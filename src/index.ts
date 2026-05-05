import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { db } from './db/client.js';
import { organizations } from './db/schema.js';
import { adminRouter } from './routes/admin.js';
import { syncRouter } from './routes/sync.js';
import type { AppEnv } from './types.js';

const app = new Hono<AppEnv>();

app.use('*', logger());

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', async (c) => {
  try {
    await db.select().from(organizations).limit(1);
    return c.json({ status: 'healthy', db: 'connected', service: 'awx-sync' });
  } catch (err) {
    return c.json({ status: 'unhealthy', error: (err as Error).message }, 500);
  }
});

app.get('/status', (c) =>
  c.json({ ok: true, service: 'awx-sync', version: '0.1.0' }),
);

// ── Routes ────────────────────────────────────────────────────────────────────

// Admin: org + key bootstrap (protected by BOOTSTRAP_SECRET)
app.route('/admin', adminRouter);

// Sync layer: all project state endpoints (requires API key)
app.route('/sync', syncRouter);

// ── Server ────────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`\n  ▸ awx-sync running on http://localhost:${info.port}`);
  console.log(`  ▸ Health:  http://localhost:${info.port}/health`);
  console.log(`  ▸ Status:  http://localhost:${info.port}/status\n`);
});

