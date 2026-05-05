import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import {
  contextSnapshots,
  fileEvents,
  memoryEntries,
  projects,
  syncSessions,
} from '../db/schema.js';
import { generateContextBlock } from '../lib/context-generator.js';
import {
  contextQuery,
  createMemoryBody,
  createProjectBody,
  ingestFileEventsBody,
  memoryIdParam,
  memoryQueryParams,
  sessionIdParam,
  startSessionBody,
  updateMemoryBody,
} from '../lib/sync-types.js';
import { requireApiKey } from '../middleware/requireApiKey.js';
import type { AppEnv } from '../types.js';

export const syncRouter = new Hono<AppEnv>();

syncRouter.use('*', requireApiKey);

function newProjectId(): string {
  return `proj_${randomBytes(8).toString('hex')}`;
}

// ── Projects ─────────────────────────────────────────────────────────────────

syncRouter.post('/projects', zValidator('json', createProjectBody), async (c) => {
  const orgId = c.get('orgId');
  const { name, root_path } = c.req.valid('json');
  const id = newProjectId();

  await db.insert(projects).values({ id, orgId, name, rootPath: root_path });

  const [proj] = await db.select().from(projects).where(eq(projects.id, id));
  return c.json(proj, 201);
});

syncRouter.get('/projects', async (c) => {
  const orgId = c.get('orgId');
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.orgId, orgId))
    .orderBy(desc(projects.createdAt));
  return c.json({ projects: rows });
});

syncRouter.get('/projects/:id', async (c) => {
  const orgId = c.get('orgId');
  const id = c.req.param('id');
  const [proj] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.orgId, orgId)));
  if (!proj) return c.json({ error: 'project_not_found' }, 404);
  return c.json(proj);
});

// ── Sessions ─────────────────────────────────────────────────────────────────

syncRouter.post(
  '/sessions/start',
  zValidator('json', startSessionBody),
  async (c) => {
    const orgId = c.get('orgId');
    const { project_id, tool } = c.req.valid('json');

    const [proj] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, project_id), eq(projects.orgId, orgId)));

    if (!proj) return c.json({ error: 'project_not_found', project_id }, 404);

    const [session] = await db
      .insert(syncSessions)
      .values({ projectId: project_id, tool })
      .returning();

    // Return the context block inline so callers get state in one round-trip
    let contextBlock: string | null = null;
    try {
      const { content } = await generateContextBlock(project_id);
      contextBlock = content;
    } catch {
      // Non-fatal: session still opens even if context gen fails
    }

    return c.json({ session, context_block: contextBlock }, 201);
  },
);

syncRouter.post(
  '/sessions/:id/end',
  zValidator('param', sessionIdParam),
  async (c) => {
    const { id } = c.req.valid('param');

    const [session] = await db
      .select()
      .from(syncSessions)
      .where(eq(syncSessions.id, id));

    if (!session) return c.json({ error: 'session_not_found', id }, 404);
    if (session.endedAt) return c.json({ error: 'session_already_ended', id }, 409);

    const [{ editCount }] = await db
      .select({ editCount: sql<number>`count(*) filter (where ${fileEvents.eventType} = 'modified')::int` })
      .from(fileEvents)
      .where(eq(fileEvents.sessionId, id));

    const [{ readCount }] = await db
      .select({ readCount: sql<number>`count(*) filter (where ${fileEvents.eventType} = 'read')::int` })
      .from(fileEvents)
      .where(eq(fileEvents.sessionId, id));

    const [{ memCount }] = await db
      .select({ memCount: sql<number>`count(*)::int` })
      .from(memoryEntries)
      .where(eq(memoryEntries.sessionId, id));

    const summary = { filesEdited: editCount, filesRead: readCount, memoriesCreated: memCount };

    const [updated] = await db
      .update(syncSessions)
      .set({ endedAt: new Date(), summary })
      .where(eq(syncSessions.id, id))
      .returning();

    return c.json(updated);
  },
);

syncRouter.get('/sessions/:projectId/history', async (c) => {
  const orgId = c.get('orgId');
  const projectId = c.req.param('projectId');

  const [proj] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));

  if (!proj) return c.json({ error: 'project_not_found' }, 404);

  const rows = await db
    .select()
    .from(syncSessions)
    .where(eq(syncSessions.projectId, projectId))
    .orderBy(desc(syncSessions.startedAt))
    .limit(20);

  return c.json({ sessions: rows });
});

// ── File Events ──────────────────────────────────────────────────────────────

syncRouter.post(
  '/events/files',
  zValidator('json', ingestFileEventsBody),
  async (c) => {
    const orgId = c.get('orgId');
    const { project_id, session_id, events } = c.req.valid('json');

    const [proj] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, project_id), eq(projects.orgId, orgId)));

    if (!proj) return c.json({ error: 'project_not_found', project_id }, 404);

    const rows = events.map((e) => ({
      projectId: project_id,
      sessionId: session_id ?? null,
      filePath: e.file_path,
      eventType: e.event_type as 'created' | 'modified' | 'deleted' | 'read',
      diff: e.diff ?? null,
      fileSize: e.file_size ?? null,
      timestamp: e.timestamp ? new Date(e.timestamp) : new Date(),
    }));

    await db.insert(fileEvents).values(rows);

    return c.json({ ingested: rows.length });
  },
);

// ── Memory ───────────────────────────────────────────────────────────────────

syncRouter.post(
  '/memory',
  zValidator('json', createMemoryBody),
  async (c) => {
    const orgId = c.get('orgId');
    const body = c.req.valid('json');

    const [proj] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, body.project_id), eq(projects.orgId, orgId)));

    if (!proj) return c.json({ error: 'project_not_found', project_id: body.project_id }, 404);

    // If this supersedes an older entry, archive it first
    if (body.supersedes) {
      await db
        .update(memoryEntries)
        .set({ archived: 'true', supersededBy: undefined })
        .where(eq(memoryEntries.id, body.supersedes));
    }

    const [entry] = await db
      .insert(memoryEntries)
      .values({
        projectId: body.project_id,
        sessionId: body.session_id ?? null,
        category: body.category,
        title: body.title,
        body: body.body,
        relatedFiles: body.related_files ?? [],
        metadata: body.metadata ?? null,
      })
      .returning();

    return c.json(entry, 201);
  },
);

syncRouter.get('/memory/:projectId', async (c) => {
  const orgId = c.get('orgId');
  const projectId = c.req.param('projectId');

  const parsed = memoryQueryParams.safeParse({
    category: c.req.query('category'),
    limit: c.req.query('limit'),
    since: c.req.query('since'),
    include_archived: c.req.query('include_archived'),
  });

  if (!parsed.success) {
    return c.json({ error: 'invalid_query', details: parsed.error.flatten() }, 400);
  }

  const { category, limit, since, include_archived } = parsed.data;

  const [proj] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));

  if (!proj) return c.json({ error: 'project_not_found', project_id: projectId }, 404);

  const conditions = [eq(memoryEntries.projectId, projectId)];
  if (include_archived === 'false') conditions.push(eq(memoryEntries.archived, 'false'));
  if (category) conditions.push(eq(memoryEntries.category, category));
  if (since) conditions.push(gte(memoryEntries.createdAt, new Date(since)));

  const rows = await db
    .select()
    .from(memoryEntries)
    .where(and(...conditions))
    .orderBy(desc(memoryEntries.createdAt))
    .limit(limit);

  return c.json({ entries: rows, count: rows.length });
});

syncRouter.patch(
  '/memory/:id',
  zValidator('param', memoryIdParam),
  zValidator('json', updateMemoryBody),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates.title = body.title;
    if (body.body !== undefined) updates.body = body.body;
    if (body.related_files !== undefined) updates.relatedFiles = body.related_files;
    if (body.metadata !== undefined) updates.metadata = body.metadata;
    if (body.archived !== undefined) updates.archived = body.archived;

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'no_fields_to_update' }, 400);
    }

    const [updated] = await db
      .update(memoryEntries)
      .set(updates)
      .where(eq(memoryEntries.id, id))
      .returning();

    if (!updated) return c.json({ error: 'memory_not_found', id }, 404);
    return c.json(updated);
  },
);

// ── Context ──────────────────────────────────────────────────────────────────

syncRouter.get('/context/:projectId', async (c) => {
  const orgId = c.get('orgId');
  const projectId = c.req.param('projectId');

  const parsed = contextQuery.safeParse({
    max_tokens: c.req.query('max_tokens'),
    format: c.req.query('format'),
  });

  if (!parsed.success) {
    return c.json({ error: 'invalid_query', details: parsed.error.flatten() }, 400);
  }

  const [proj] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));

  if (!proj) return c.json({ error: 'project_not_found', project_id: projectId }, 404);

  // Check for a fresh cached snapshot (within 60 seconds)
  const cutoff = new Date(Date.now() - 60_000);
  const [cached] = await db
    .select()
    .from(contextSnapshots)
    .where(
      and(
        eq(contextSnapshots.projectId, projectId),
        gte(contextSnapshots.generatedAt, cutoff),
      ),
    )
    .orderBy(desc(contextSnapshots.generatedAt))
    .limit(1);

  if (cached) {
    return c.json({
      context_block: cached.content,
      token_estimate: cached.tokenEstimate,
      generated_at: cached.generatedAt,
      cached: true,
    });
  }

  const { content, tokenEstimate } = await generateContextBlock(projectId, {
    maxTokens: parsed.data.max_tokens,
  });

  const [snapshot] = await db
    .insert(contextSnapshots)
    .values({ projectId, content, tokenEstimate })
    .returning();

  return c.json({
    context_block: content,
    token_estimate: tokenEstimate,
    generated_at: snapshot.generatedAt,
    cached: false,
  });
});

syncRouter.get('/context/:projectId/raw', async (c) => {
  const orgId = c.get('orgId');
  const projectId = c.req.param('projectId');

  const [proj] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));

  if (!proj) return c.text('Project not found', 404);

  const parsed = contextQuery.safeParse({
    max_tokens: c.req.query('max_tokens'),
  });

  const maxTokens = parsed.success ? parsed.data.max_tokens : 2000;

  const { content } = await generateContextBlock(projectId, { maxTokens });
  return c.text(content);
});
