import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { db } from '../db/client.js';
import { organizations } from '../db/schema.js';
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
