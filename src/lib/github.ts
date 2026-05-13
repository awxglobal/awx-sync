/**
 * GitHub App utilities — JWT signing, installation tokens, webhook verification, API calls.
 *
 * Env vars:
 *   GITHUB_APP_ID           — from GitHub App settings
 *   GITHUB_APP_PRIVATE_KEY  — PEM key (newlines as \n or actual newlines)
 *   GITHUB_WEBHOOK_SECRET   — for HMAC-SHA256 signature verification
 */

import { createHmac, createSign, randomBytes } from 'node:crypto';

// ── JWT for GitHub App ──────────────────────────────────────────────────────

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

/**
 * Create a short-lived JWT signed with the GitHub App private key.
 * Valid for 10 minutes (GitHub's max).
 */
export function createAppJwt(): string {
  const appId = process.env.GITHUB_APP_ID;
  const pem = (process.env.GITHUB_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
  if (!appId || !pem) throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set');

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }));

  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(pem, 'base64url');

  return `${header}.${payload}.${signature}`;
}

// ── Installation Token Cache ────────────────────────────────────────────────

let cachedToken: { token: string; expiresAt: number; installationId: number } | null = null;

/**
 * Get an installation access token for the given GitHub App installation.
 * Caches the token and refreshes when it's within 5 minutes of expiry.
 */
export async function getInstallationToken(installationId: number): Promise<string> {
  if (cachedToken && cachedToken.installationId === installationId && cachedToken.expiresAt > Date.now() + 300_000) {
    return cachedToken.token;
  }

  const jwt = createAppJwt();
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub installation token error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  cachedToken = {
    token: data.token,
    installationId,
    expiresAt: new Date(data.expires_at).getTime(),
  };

  return data.token;
}

// ── Webhook Signature Verification ──────────────────────────────────────────

/**
 * Verify the X-Hub-Signature-256 header from GitHub webhooks.
 */
export function verifyWebhookSignature(payload: string, signature: string): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  if (expected.length !== signature.length) return false;

  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── GitHub API Helper ───────────────────────────────────────────────────────

/**
 * Authenticated GitHub API call using an installation token.
 */
export async function githubApi(
  installationId: number,
  path: string,
  opts: RequestInit = {},
): Promise<unknown> {
  const token = await getInstallationToken(installationId);
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers as Record<string, string> ?? {}),
    },
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 300)}`);
  }

  return body;
}

// ── Utility ─────────────────────────────────────────────────────────────────

export function newGithubId(): string {
  return `ghi_${randomBytes(8).toString('hex')}`;
}

// ── PR Helpers ──────────────────────────────────────────────────────────────

export async function getPRFiles(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<Array<{ filename: string; status: string; additions: number; deletions: number }>> {
  return (await githubApi(installationId, `/repos/${owner}/${repo}/pulls/${prNumber}/files`)) as Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
}

export async function postPRComment(
  installationId: number,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await githubApi(installationId, `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export async function postIssueComment(
  installationId: number,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await githubApi(installationId, `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}
