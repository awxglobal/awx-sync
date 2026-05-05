import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { generateApiKey, hashApiKey } from '../lib/apikey.js';
import type { AppEnv } from '../types.js';

export const adminRouter = new Hono<AppEnv>();

const createOrgBody = z.object({
  name: z.string().min(1).max(200),
  // Simple bootstrap secret — set in env, not stored in DB
  bootstrap_secret: z.string().min(1),
});

function newOrgId(): string {
  return `org_${randomBytes(8).toString('hex')}`;
}

/**
 * POST /admin/orgs
 * Bootstrap endpoint to create an org and get an API key.
 * Protected by BOOTSTRAP_SECRET env var so it can't be called publicly.
 * This is how you set up the first org before you have an API key.
 */
adminRouter.post('/orgs', zValidator('json', createOrgBody), async (c) => {
  const { name, bootstrap_secret } = c.req.valid('json');

  const expectedSecret = process.env.BOOTSTRAP_SECRET;
  if (!expectedSecret || bootstrap_secret !== expectedSecret) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const id = newOrgId();

  await db.insert(organizations).values({ id, name, apiKeyHash, planTier: 'FREE' });

  return c.json(
    {
      org_id: id,
      name,
      api_key: apiKey,
      message: 'Save this API key — it will not be shown again.',
    },
    201,
  );
});

/**
 * POST /admin/orgs/:id/rotate-key
 * Generate a new API key for an existing org.
 */
adminRouter.post('/orgs/:id/rotate-key', async (c) => {
  const bootstrap_secret = c.req.header('X-Bootstrap-Secret');
  const expectedSecret = process.env.BOOTSTRAP_SECRET;

  if (!expectedSecret || bootstrap_secret !== expectedSecret) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = c.req.param('id');
  const [org] = await db.select().from(organizations).where(eq(organizations.id, id));
  if (!org) return c.json({ error: 'org_not_found' }, 404);

  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  await db.update(organizations).set({ apiKeyHash }).where(eq(organizations.id, id));

  return c.json({
    org_id: id,
    api_key: apiKey,
    message: 'Old key is now invalid. Save this new key.',
  });
});
