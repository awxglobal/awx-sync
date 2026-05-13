import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { db } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { API_KEY_PREFIX, hashApiKey } from '../lib/apikey.js';
import type { AppEnv } from '../types.js';

export const requireApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json(
      { error: 'unauthorized', message: 'Include: Authorization: Bearer awxs_<key> or a session token' },
      401,
    );
  }

  const token = authHeader.slice(7);

  // Try JWT session token first (from dashboard login)
  if (token.startsWith('eyJ')) {
    const payload = verifyJwt(token);
    if (payload?.org_id) {
      const [org] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, payload.org_id));
      if (org) {
        c.set('orgId', org.id);
        return next();
      }
    }
    return c.json({ error: 'unauthorized', message: 'Invalid session token.' }, 401);
  }

  // Fall back to API key auth
  if (!token.startsWith(API_KEY_PREFIX)) {
    return c.json(
      { error: 'unauthorized', message: `Key must start with "${API_KEY_PREFIX}"` },
      401,
    );
  }

  const keyHash = hashApiKey(token);

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.apiKeyHash, keyHash));

  if (!org) {
    return c.json({ error: 'unauthorized', message: 'Invalid API key.' }, 401);
  }

  c.set('orgId', org.id);
  await next();
});

function verifyJwt(token: string): { org_id: string; org_name: string; github_login: string; exp: number } | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (!data.org_id || typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

