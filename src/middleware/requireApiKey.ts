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
      { error: 'unauthorized', message: 'Include: Authorization: Bearer awxs_<key>' },
      401,
    );
  }

  const key = authHeader.slice(7);

  if (!key.startsWith(API_KEY_PREFIX)) {
    return c.json(
      { error: 'unauthorized', message: `Key must start with "${API_KEY_PREFIX}"` },
      401,
    );
  }

  const keyHash = hashApiKey(key);

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

