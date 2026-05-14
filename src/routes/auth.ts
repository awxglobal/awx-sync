import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { db } from '../db/client.js';
import { organizations, projects } from '../db/schema.js';
import { generateApiKey, hashApiKey } from '../lib/apikey.js';
import type { AppEnv } from '../types.js';

export const authRouter = new Hono<AppEnv>();

type GitHubTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type GitHubUser = {
  id: number;
  login: string;
  name?: string | null;
  email?: string | null;
};

type SessionPayload = {
  org_id: string;
  org_name: string;
  github_login: string;
  iat: number;
  exp: number;
};

type OAuthState = {
  redirect?: string;
  nonce?: string;
};

authRouter.get('/github', (c) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) return c.json({ error: 'github_client_id_missing' }, 500);

  const redirect = c.req.query('redirect') ?? '';
  const state = encodeState({ redirect, nonce: randomBytes(12).toString('hex') });
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'read:user user:email',
    state,
  });
  const callbackUrl = oauthCallbackUrl(c.req.url, c.req.header('x-forwarded-proto'), c.req.header('x-forwarded-host'));
  if (callbackUrl) params.set('redirect_uri', callbackUrl);

  return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

// GitHub OAuth App may be configured with /auth/github/callback
authRouter.get('/github/callback', (c) => {
  const url = new URL(c.req.url);
  url.pathname = '/auth/callback';
  return c.redirect(url.toString());
});

authRouter.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = decodeState(c.req.query('state'));
  const redirect = state.redirect;

  if (!code) return c.json({ error: 'missing_code' }, 400);

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!clientId || !clientSecret) return c.json({ error: 'github_oauth_not_configured' }, 500);
  if (!sessionSecret) return c.json({ error: 'session_secret_missing' }, 500);

  const token = await exchangeGitHubCode({
    code,
    clientId,
    clientSecret,
    redirectUri: oauthCallbackUrl(c.req.url, c.req.header('x-forwarded-proto'), c.req.header('x-forwarded-host')),
  });
  const githubUser = await fetchGitHubUser(token);
  const org = await findOrCreateGitHubOrg(githubUser);
  const jwt = signSessionToken({
    org_id: org.id,
    org_name: org.name,
    github_login: githubUser.login,
  });

  if (redirect && shouldReturnTokenInFragment(redirect)) {
    const url = new URL(redirect);
    url.hash = `token=${encodeURIComponent(jwt)}`;
    return c.redirect(url.toString());
  }

  setCookie(c, 'awx_dashboard_token', jwt, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });

  return c.redirect(redirect || '/app');
});

// Generate/rotate API key for the logged-in user (JWT auth required)
authRouter.post('/rotate-key', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);

  const payload = verifySessionToken(authHeader.slice(7));
  if (!payload) return c.json({ error: 'unauthorized' }, 401);

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, payload.org_id));

  if (!org) return c.json({ error: 'org_not_found' }, 404);

  const apiKey = generateApiKey();
  await db.update(organizations).set({ apiKeyHash: hashApiKey(apiKey) }).where(eq(organizations.id, org.id));

  return c.json({
    api_key: apiKey,
    message: 'Save this key — it cannot be retrieved again.',
  });
});

authRouter.get('/verify', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);

  const payload = verifySessionToken(authHeader.slice(7));
  if (!payload) return c.json({ error: 'unauthorized' }, 401);

  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, payload.org_id));

  if (!org) return c.json({ error: 'unauthorized' }, 401);

  return c.json({
    org_id: org.id,
    org_name: org.name,
    github_login: payload.github_login,
  });
});

// ── Quickstart: one-page onboarding ──────────────────────────────────────────

authRouter.get('/quickstart', async (c) => {
  // 1. Check for session cookie
  const token = getCookie(c, 'awx_dashboard_token');
  if (!token) {
    // Not logged in → redirect to GitHub OAuth, come back here after
    return c.redirect('/auth/github?redirect=/auth/quickstart');
  }

  const payload = verifySessionToken(token);
  if (!payload) {
    return c.redirect('/auth/github?redirect=/auth/quickstart');
  }

  // 2. Get org
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, apiKeyHash: organizations.apiKeyHash })
    .from(organizations)
    .where(eq(organizations.id, payload.org_id));

  if (!org) return c.redirect('/auth/github?redirect=/auth/quickstart');

  // 3. Always generate a fresh API key on quickstart (rotates existing)
  const apiKey = generateApiKey();
  await db.update(organizations).set({ apiKeyHash: hashApiKey(apiKey) }).where(eq(organizations.id, org.id));
  const keyIsNew = true;

  // 4. Get their first project (if any)
  const userProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.orgId, org.id))
    .orderBy(desc(projects.createdAt))
    .limit(1);

  const project = userProjects[0] ?? null;
  const projectId = project?.id ?? 'YOUR_PROJECT_ID';

  // 5. Render the quickstart page
  const needsGitHubApp = !project;
  const needsKey = !apiKey && !keyIsNew; // they had an existing key but we can't show it

  return c.html(renderQuickstartPage({
    username: payload.github_login,
    orgName: org.name,
    apiKey,
    keyIsNew,
    projectId,
    projectName: project?.name ?? null,
    needsGitHubApp,
  }));
});

function renderQuickstartPage(opts: {
  username: string;
  orgName: string;
  apiKey: string | null;
  keyIsNew: boolean;
  projectId: string;
  projectName: string | null;
  needsGitHubApp: boolean;
}): string {
  const keyDisplay = opts.apiKey
    ? opts.apiKey
    : '(already generated — use your existing key)';
  const keyWarning = opts.apiKey
    ? '<p style="color:#d97706;font-size:13px;margin:8px 0 0">⚠ Save this key now — you won\'t see it again.</p>'
    : '';

  const claudeConfig = opts.apiKey ? JSON.stringify({
    mcpServers: {
      "project-brain": {
        command: "npx",
        args: ["-y", "awx-sync-mcp"],
        env: {
          AWX_API_KEY: opts.apiKey,
          AWX_PROJECT_ID: opts.projectId,
        },
      },
    },
  }, null, 2) : null;

  const codexConfig = `[mcp_servers.project-brain]
type = "stdio"
command = "npx"
args = ["-y", "awx-sync-mcp"]

[mcp_servers.project-brain.env]
AWX_API_KEY = "${opts.apiKey ?? 'YOUR_API_KEY'}"
AWX_PROJECT_ID = "${opts.projectId}"`;

  const githubAppSection = opts.needsGitHubApp
    ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:16px;margin:20px 0">
        <strong>Step 1:</strong> Install the GitHub App to connect a repo<br>
        <a href="https://github.com/apps/probrain-ai/installations/new" style="display:inline-block;margin-top:10px;padding:8px 16px;background:#111;color:#fff;border-radius:6px;text-decoration:none;font-size:14px">Install GitHub App →</a>
        <p style="font-size:12px;color:#92400e;margin:8px 0 0">Then refresh this page to get your project ID.</p>
      </div>`
    : `<div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;padding:16px;margin:20px 0">
        ✅ GitHub connected — project: <strong>${opts.projectName}</strong> (<code>${opts.projectId}</code>)
      </div>`;

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Project Brain — Quickstart</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#1e293b;padding:32px 16px}
  .container{max-width:640px;margin:0 auto}
  h1{font-size:24px;margin-bottom:4px}
  .sub{color:#64748b;font-size:14px;margin-bottom:24px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  .card h2{font-size:16px;margin-bottom:12px}
  pre{background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.6;position:relative}
  .copy-btn{position:absolute;top:8px;right:8px;background:#334155;color:#cbd5e1;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px}
  .copy-btn:hover{background:#475569}
  code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px}
  .tabs{display:flex;gap:4px;margin-bottom:12px}
  .tab{padding:8px 16px;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;cursor:pointer;font-size:13px;font-weight:500}
  .tab.active{background:#0f172a;color:#fff;border-color:#0f172a}
  .key-box{background:#ecfdf5;border:1px solid #6ee7b7;border-radius:8px;padding:12px;font-family:monospace;font-size:13px;word-break:break-all}
  a.btn{display:inline-block;padding:10px 20px;background:#0891b2;color:#fff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500}
</style>
</head><body>
<div class="container">
  <h1>🧠 Welcome, ${opts.username}</h1>
  <p class="sub">Project Brain gives your AI tools persistent memory.</p>

  ${githubAppSection}

  ${opts.apiKey ? `<div class="card">
    <h2>Your API Key</h2>
    <div class="key-box">${keyDisplay}</div>
    ${keyWarning}
  </div>` : ''}

  <div class="card">
    <h2>${opts.needsGitHubApp ? 'Step 2' : 'Copy your config'}</h2>
    <div class="tabs">
      <div class="tab active" onclick="showTab('claude')">Claude Code</div>
      <div class="tab" onclick="showTab('codex')">Codex</div>
    </div>
    <div id="tab-claude">
      <p style="font-size:13px;color:#64748b;margin-bottom:8px">Add to <code>.claude/settings.json</code></p>
      <div style="position:relative">
        <pre id="claude-config">${claudeConfig ? escapeHtml(claudeConfig) : 'Generate an API key first'}</pre>
        ${claudeConfig ? '<button class="copy-btn" onclick="copyText(\'claude-config\')">Copy</button>' : ''}
      </div>
    </div>
    <div id="tab-codex" style="display:none">
      <p style="font-size:13px;color:#64748b;margin-bottom:8px">Add to <code>.codex/config.toml</code></p>
      <div style="position:relative">
        <pre id="codex-config">${escapeHtml(codexConfig)}</pre>
        <button class="copy-btn" onclick="copyText('codex-config')">Copy</button>
      </div>
    </div>
  </div>

  <div style="text-align:center;margin-top:24px">
    <a class="btn" href="https://project-brain-dashboard.fly.dev">Go to Dashboard →</a>
  </div>
</div>
<script>
function showTab(t){
  document.querySelectorAll('.tab').forEach(e=>e.classList.remove('active'));
  document.getElementById('tab-claude').style.display=t==='claude'?'block':'none';
  document.getElementById('tab-codex').style.display=t==='codex'?'block':'none';
  event.target.classList.add('active');
}
function copyText(id){
  navigator.clipboard.writeText(document.getElementById(id).textContent);
  event.target.textContent='Copied!';
  setTimeout(()=>event.target.textContent='Copy',1500);
}
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function exchangeGitHubCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}): Promise<string> {
  const requestBody: Record<string, string> = {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
  };
  if (input.redirectUri) requestBody.redirect_uri = input.redirectUri;

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const responseBody = (await response.json()) as GitHubTokenResponse;
  if (!response.ok || !responseBody.access_token) {
    throw new Error(responseBody.error_description ?? responseBody.error ?? 'GitHub token exchange failed');
  }
  return responseBody.access_token;
}

async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'project-brain',
    },
  });

  if (!response.ok) throw new Error(`GitHub user lookup failed: HTTP ${response.status}`);
  const user = (await response.json()) as GitHubUser;
  if (!user.login) throw new Error('GitHub user lookup did not return a login');
  return user;
}

async function findOrCreateGitHubOrg(user: GitHubUser): Promise<{ id: string; name: string }> {
  const existing = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.email, githubEmailKey(user.login)))
    .limit(1);

  if (existing[0]) return existing[0];

  const apiKey = generateApiKey();
  const [org] = await db
    .insert(organizations)
    .values({
      id: `org_gh_${user.id}`,
      name: user.name?.trim() || user.login,
      email: githubEmailKey(user.login),
      apiKeyHash: hashApiKey(apiKey),
      planTier: 'FREE',
    })
    .onConflictDoUpdate({
      target: organizations.id,
      set: {
        name: user.name?.trim() || user.login,
        email: githubEmailKey(user.login),
      },
    })
    .returning({ id: organizations.id, name: organizations.name });

  return org;
}

function signSessionToken(payload: Omit<SessionPayload, 'iat' | 'exp'>): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: SessionPayload = {
    ...payload,
    iat: now,
    exp: now + 60 * 60 * 24 * 7,
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = sign(`${encodedHeader}.${encodedPayload}`);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifySessionToken(token: string): SessionPayload | null {
  const [encodedHeader, encodedPayload, signature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !signature) return null;

  const expected = sign(`${encodedHeader}.${encodedPayload}`);
  if (!safeEqual(signature, expected)) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as SessionPayload;
    if (!payload.org_id || !payload.org_name || !payload.github_login) return null;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function sign(value: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET env var is required');
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function encodeState(state: OAuthState): string {
  return base64UrlEncode(JSON.stringify(state));
}

function decodeState(value: string | undefined): OAuthState {
  if (!value) return {};
  try {
    return JSON.parse(base64UrlDecode(value)) as OAuthState;
  } catch {
    return {};
  }
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf-8');
}

function requestOrigin(url: string, forwardedProto?: string, forwardedHost?: string): string {
  const parsed = new URL(url);
  const protocol = forwardedProto?.split(',')[0]?.trim() || parsed.protocol.replace(':', '');
  const host = forwardedHost?.split(',')[0]?.trim() || parsed.host;
  return `${protocol}://${host}`;
}

function oauthCallbackUrl(url: string, forwardedProto?: string, forwardedHost?: string): string | undefined {
  if (process.env.GITHUB_OAUTH_CALLBACK_URL) return process.env.GITHUB_OAUTH_CALLBACK_URL;
  if (process.env.GITHUB_REDIRECT_URI) return process.env.GITHUB_REDIRECT_URI;
  if (process.env.FORCE_GITHUB_REDIRECT_URI === 'true') {
    return new URL('/auth/callback', requestOrigin(url, forwardedProto, forwardedHost)).toString();
  }
  return undefined;
}

function githubEmailKey(login: string): string {
  return `github:${login.toLowerCase()}`;
}

function shouldReturnTokenInFragment(redirect: string): boolean {
  if (redirect.startsWith('https://')) return true;
  try {
    const url = new URL(redirect);
    return url.protocol === 'http:' && url.hostname === 'localhost' && url.port === '4000';
  } catch {
    return false;
  }
}
