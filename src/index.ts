import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { db } from './db/client.js';
import { organizations } from './db/schema.js';
import { renderProjectBrainOnboardingPage } from './lib/saas-onboarding.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { githubRouter, writeBackRouter } from './routes/github-webhooks.js';
import { syncRouter } from './routes/sync.js';
import type { AppEnv } from './types.js';

const app = new Hono<AppEnv>();

app.use('*', logger());
const dashboardCors = cors({
  origin: (origin) => {
    if (origin === 'https://project-brain-dashboard.fly.dev') return origin;
    if (origin === 'http://localhost:4000') return origin;
    if (origin?.endsWith('.lovable.app')) return origin;
    return null;
  },
  credentials: true,
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
});
app.use('/auth/*', dashboardCors);
app.use('/sync/*', dashboardCors);

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

app.get('/', (c) => c.html(renderProjectBrainOnboardingPage()));
app.get('/app', (c) => c.html(renderProjectBrainOnboardingPage()));
app.get('/app/setup', (c) => {
  const setupPath = join(process.cwd(), 'src', 'public', 'setup.html');
  if (!existsSync(setupPath)) return c.text('Setup page not found', 404);
  return c.html(readFileSync(setupPath, 'utf-8'));
});
app.get('/demo', (c) => c.html(renderProjectBrainOnboardingPage()));

app.get('/auth/setup', (c) => {
  const awxPath = join(process.cwd(), '.awxsync.json');
  const mcpPath = join(process.cwd(), '.mcp.json');
  const awx = readJson<{ projectId?: string; apiUrl?: string; apiKey?: string }>(awxPath);
  const mcp = readJson<{ mcpServers?: Record<string, unknown> }>(mcpPath);
  const mcpConfigured = Object.keys(mcp?.mcpServers ?? {}).some((name) =>
    /project-brain|awx-sync/i.test(name),
  );

  return c.json({
    projectId: awx?.projectId ?? null,
    backend: awx?.apiUrl ?? 'http://localhost:3000',
    hasApiKey: Boolean(awx?.apiKey),
    mcpConfigured,
    initCommand: awx?.apiKey
      ? `project-brain init --api-key ${maskKey(awx.apiKey)}`
      : 'project-brain init --api-key <key>',
  });
});

app.post('/auth/reveal-key', (c) => {
  const awxPath = join(process.cwd(), '.awxsync.json');
  const awx = readJson<{ apiKey?: string }>(awxPath);
  if (!awx?.apiKey) {
    return c.json({ error: 'api_key_missing', message: 'No local API key found in .awxsync.json.' }, 404);
  }
  return c.json({ apiKey: awx.apiKey });
});

// Dashboard auth: GitHub OAuth + JWT verification
app.route('/auth', authRouter);

// GitHub webhooks (no API key — verified by HMAC signature)
app.route('/', githubRouter);

// GitHub write-back API (requires API key)
app.route('/github', writeBackRouter);

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

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function maskKey(key: string): string {
  if (key.length <= 14) return '<hidden>';
  return `${key.slice(0, 8)}…${key.slice(-6)}`;
}
