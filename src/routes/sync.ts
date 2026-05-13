import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import {
  contextSnapshots,
  fileEvents,
  memoryEntries,
  operationalLessons,
  projects,
  syncSessions,
} from '../db/schema.js';
import { generateContextBlock } from '../lib/context-generator.js';
import { analyzeExploration } from '../lib/exploration-analysis.js';
import { generateLessonsFromData } from '../lib/lesson-generator.js';
import {
  buildAndSaveReplay,
  calculateAndSaveMetrics,
  createAndSaveContextPacket,
  createAndSaveSessionBriefing,
  generateAndSaveWeeklyReport,
  generateSessionBriefingForProject,
  generateSessionImprovementSummary,
  loadLessons,
  loadTaskReplays,
  loadWorkflowEvents,
  renderTaskReplayMarkdownForTask,
  saveWorkflowEvents,
} from '../lib/learning-spine-store.js';
import type { WorkflowEvent } from '../lib/learning-spine.js';
import {
  contextQuery,
  contextPacketBody,
  createMemoryBody,
  createProjectBody,
  ingestFileEventsBody,
  ingestWorkflowEventsBody,
  memoryIdParam,
  memoryQueryParams,
  memorySearchParams,
  sessionIdParam,
  startSessionBody,
  taskReplayBody,
  updateMemoryBody,
  weeklyReportBody,
} from '../lib/sync-types.js';
import {
  workflowEventForSessionStart,
  workflowEventsForModifiedFiles,
} from '../lib/workflow-event-mirror.js';
import { requireApiKey } from '../middleware/requireApiKey.js';
import type { AppEnv } from '../types.js';

export const syncRouter = new Hono<AppEnv>();

syncRouter.use('*', requireApiKey);

function newProjectId(): string {
  return `proj_${randomBytes(8).toString('hex')}`;
}

function withProjectBrainBriefing(briefing: string | null, content: string): string {
  if (!briefing || content.includes('## Project Brain Briefing')) return content;
  return `${briefing}\n\n---\n\n${content}`;
}

async function requireProjectForOrg(projectId: string, orgId: string) {
  const [proj] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));
  return proj;
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

    try {
      await saveWorkflowEvents([
        workflowEventForSessionStart({
          projectId: project_id,
          sessionId: session.id,
          tool,
          startedAt: session.startedAt,
        }),
      ]);
    } catch {
      // Non-fatal: session start should still work if learning-spine capture fails.
    }

    // Return a lovable in-chat briefing inline so callers can continue instantly.
    let contextBlock: string | null = null;
    let projectBrainBriefing: string | null = null;
    try {
      const briefing = await createAndSaveSessionBriefing(project_id, session.id);
      const { content } = await generateContextBlock(project_id);
      projectBrainBriefing = briefing.markdown;
      contextBlock = `${briefing.markdown}\n\n---\n\n${content}`;
    } catch {
      // Non-fatal: session still opens even if context gen fails
    }

    return c.json({ session, context_block: contextBlock, project_brain_briefing: projectBrainBriefing }, 201);
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

    const [[{ editCount }], [{ readCount }], [{ memCount }], hotFiles] = await Promise.all([
      db
        .select({ editCount: sql<number>`count(*) filter (where ${fileEvents.eventType} = 'modified')::int` })
        .from(fileEvents)
        .where(eq(fileEvents.sessionId, id)),
      db
        .select({ readCount: sql<number>`count(*) filter (where ${fileEvents.eventType} = 'read')::int` })
        .from(fileEvents)
        .where(eq(fileEvents.sessionId, id)),
      db
        .select({ memCount: sql<number>`count(*)::int` })
        .from(memoryEntries)
        .where(eq(memoryEntries.sessionId, id)),
      // Files edited 5+ times in this session = "heavily worked"
      db
        .select({
          filePath: fileEvents.filePath,
          edits: sql<number>`count(*) filter (where ${fileEvents.eventType} = 'modified')::int`,
        })
        .from(fileEvents)
        .where(and(eq(fileEvents.sessionId, id), eq(fileEvents.eventType, 'modified')))
        .groupBy(fileEvents.filePath)
        .having(sql`count(*) >= 5`)
        .orderBy(sql`count(*) desc`)
        .limit(5),
    ]);

    const summary = { filesEdited: editCount, filesRead: readCount, memoriesCreated: memCount };

    const [updated] = await db
      .update(syncSessions)
      .set({ endedAt: new Date(), summary })
      .where(eq(syncSessions.id, id))
      .returning();

    // Auto-create a note memory for heavily-edited files (5+ edits in the session)
    if (hotFiles.length > 0) {
      const fileList = hotFiles.map((f) => `${f.filePath} (${f.edits} edits)`).join(', ');
      await db.insert(memoryEntries).values({
        projectId: session.projectId,
        sessionId: id,
        category: 'note',
        title: `Heavy edits: ${hotFiles.map((f) => f.filePath.split('/').pop()).join(', ')}`,
        body: `Files edited 5+ times in this session: ${fileList}`,
        relatedFiles: hotFiles.map((f) => f.filePath),
        metadata: { auto: true, source: 'session_end' },
      });
    }

    let projectBrainImprovementSummary: string | null = null;
    let projectBrainReplayOutcome: string | null = null;
    try {
      const { replay } = await buildAndSaveReplay(session.projectId, id);
      projectBrainReplayOutcome = replay.finalOutcome;
    } catch {
      // Non-fatal: session end should still succeed even if replay generation fails.
    }

    try {
      projectBrainImprovementSummary = await generateSessionImprovementSummary(session.projectId, id);
    } catch {
      // Non-fatal: session end should still succeed even if proof generation fails.
    }

    return c.json({
      session: updated,
      project_brain_improvement_summary: projectBrainImprovementSummary,
      project_brain_replay_outcome: projectBrainReplayOutcome,
    });
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

    const allRows = events.map((e) => ({
      projectId: project_id,
      sessionId: session_id ?? null,
      filePath: e.file_path,
      eventType: e.event_type as 'created' | 'modified' | 'deleted' | 'read',
      diff: e.diff ?? null,
      fileSize: e.file_size ?? null,
      timestamp: e.timestamp ? new Date(e.timestamp) : new Date(),
    }));

    // Deduplicate: within this batch, keep the latest event per (filePath, eventType).
    // Prevents double-counting when the watcher debounce fires multiple rapid saves.
    const seen = new Map<string, typeof allRows[0]>();
    for (const row of allRows) {
      const key = `${row.filePath}:${row.eventType}`;
      const existing = seen.get(key);
      if (!existing || row.timestamp > existing.timestamp) seen.set(key, row);
    }
    const rows = [...seen.values()];

    const insertedRows = rows.length > 0 ? await db.insert(fileEvents).values(rows).returning() : [];

    if (insertedRows.length > 0) {
      try {
        const [session] = session_id
          ? await db
            .select({ tool: syncSessions.tool })
            .from(syncSessions)
            .where(eq(syncSessions.id, session_id))
            .limit(1)
          : [];

        await saveWorkflowEvents(
          workflowEventsForModifiedFiles({
            projectId: project_id,
            taskId: session_id ?? `file_activity_${project_id}`,
            tool: session?.tool ?? 'local',
            files: insertedRows,
          }),
        );
      } catch {
        // Non-fatal: file activity should still be ingested if learning-spine capture fails.
      }
    }

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

// ── Memory Search ────────────────────────────────────────────────────────────

syncRouter.get('/search-memory', async (c) => {
  const orgId = c.get('orgId');

  const parsed = memorySearchParams.safeParse({
    q: c.req.query('q'),
    project_id: c.req.query('project_id'),
    category: c.req.query('category'),
    file_path: c.req.query('file_path'),
    include_archived: c.req.query('include_archived'),
    limit: c.req.query('limit'),
  });

  if (!parsed.success) {
    return c.json({ error: 'invalid_query', details: parsed.error.flatten() }, 400);
  }

  const { q, project_id, category, file_path, include_archived, limit } = parsed.data;

  // If a specific project is requested, verify org owns it
  if (project_id) {
    const [proj] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, project_id), eq(projects.orgId, orgId)));
    if (!proj) return c.json({ error: 'project_not_found', project_id }, 404);
  }

  // Prepare search pattern — escape % and _ in the query so they're treated as literals
  const escaped = q.replace(/%/g, '\\%').replace(/_/g, '\\_');
  const pattern = `%${escaped}%`;

  // Build conditions
  const conditions = [
    // Always scope to this org's projects
    inArray(
      memoryEntries.projectId,
      db.select({ id: projects.id }).from(projects).where(eq(projects.orgId, orgId)),
    ),
    // Text match: title OR body OR related_files (cast jsonb to text)
    sql`(
      ${memoryEntries.title} ilike ${pattern}
      OR ${memoryEntries.body} ilike ${pattern}
      OR ${memoryEntries.relatedFiles}::text ilike ${pattern}
    )`,
  ];

  if (include_archived === 'false') conditions.push(eq(memoryEntries.archived, 'false'));
  if (category) conditions.push(eq(memoryEntries.category, category));
  if (project_id) conditions.push(eq(memoryEntries.projectId, project_id));
  if (file_path) {
    conditions.push(sql`${memoryEntries.relatedFiles}::text ilike ${'%' + file_path + '%'}`);
  }

  // Relevance score: 3 = title match, 2 = file match, 1 = body-only match
  const relevanceScore = sql<number>`
    CASE
      WHEN ${memoryEntries.title} ilike ${pattern} THEN 3
      WHEN ${memoryEntries.relatedFiles}::text ilike ${pattern} THEN 2
      ELSE 1
    END
  `;

  // Snippet: 200 chars of body starting near the first match position
  const snippet = sql<string>`
    CASE
      WHEN length(${memoryEntries.body}) <= 220 THEN ${memoryEntries.body}
      ELSE substring(
        ${memoryEntries.body},
        greatest(1, position(lower(${escaped}) in lower(${memoryEntries.body})) - 60),
        220
      )
    END
  `;

  // Where the match was found (for the caller to understand why a result came back)
  const matchIn = sql<string>`
    CASE
      WHEN ${memoryEntries.title} ilike ${pattern}
        AND ${memoryEntries.body} ilike ${pattern} THEN 'title+body'
      WHEN ${memoryEntries.title} ilike ${pattern} THEN 'title'
      WHEN ${memoryEntries.relatedFiles}::text ilike ${pattern} THEN 'file'
      ELSE 'body'
    END
  `;

  const rows = await db
    .select({
      id: memoryEntries.id,
      projectId: memoryEntries.projectId,
      category: memoryEntries.category,
      title: memoryEntries.title,
      relatedFiles: memoryEntries.relatedFiles,
      createdAt: memoryEntries.createdAt,
      archived: memoryEntries.archived,
      snippet,
      match_in: matchIn,
      relevance: relevanceScore,
    })
    .from(memoryEntries)
    .where(and(...conditions))
    .orderBy(sql`${relevanceScore} desc`, desc(memoryEntries.createdAt))
    .limit(limit);

  return c.json({
    query: q,
    count: rows.length,
    results: rows,
  });
});

// ── File Events (project-level) ─────────────────────────────────────────────

syncRouter.get('/file-events/:projectId', async (c) => {
  const orgId = c.get('orgId');
  const projectId = c.req.param('projectId');
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 500);

  const proj = await requireProjectForOrg(projectId, orgId);
  if (!proj) return c.json({ error: 'project_not_found', project_id: projectId }, 404);

  const rows = await db
    .select({
      id: fileEvents.id,
      filePath: fileEvents.filePath,
      eventType: fileEvents.eventType,
      timestamp: fileEvents.timestamp,
    })
    .from(fileEvents)
    .where(eq(fileEvents.projectId, projectId))
    .orderBy(desc(fileEvents.timestamp))
    .limit(limit);

  return c.json({ events: rows, count: rows.length });
});

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

  const briefing = await generateSessionBriefingForProject(projectId);

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
    const content = withProjectBrainBriefing(briefing.markdown, cached.content);
    return c.json({
      context_block: content,
      project_brain_briefing: briefing.markdown,
      token_estimate: Math.ceil(content.length / 4),
      generated_at: cached.generatedAt,
      cached: true,
    });
  }

  const generated = await generateContextBlock(projectId, {
    maxTokens: parsed.data.max_tokens,
  });
  const content = withProjectBrainBriefing(briefing.markdown, generated.content);
  const tokenEstimate = Math.ceil(content.length / 4);

  const [snapshot] = await db
    .insert(contextSnapshots)
    .values({ projectId, content, tokenEstimate })
    .returning();

  return c.json({
    context_block: content,
    project_brain_briefing: briefing.markdown,
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

  const [briefing, context] = await Promise.all([
    generateSessionBriefingForProject(projectId),
    generateContextBlock(projectId, { maxTokens }),
  ]);
  return c.text(withProjectBrainBriefing(briefing.markdown, context.content));
});

// Replay + Learning Spine

syncRouter.post(
  '/brain/events',
  zValidator('json', ingestWorkflowEventsBody),
  async (c) => {
    const orgId = c.get('orgId');
    const body = c.req.valid('json');

    const proj = await requireProjectForOrg(body.project_id, orgId);
    if (!proj) return c.json({ error: 'project_not_found', project_id: body.project_id }, 404);

    const events: WorkflowEvent[] = body.events.map((event) => ({
      id: event.id,
      repoId: body.project_id,
      taskId: event.task_id,
      timestamp: event.timestamp,
      sourceTool: event.source_tool,
      actorType: event.actor_type,
      type: event.type,
      summary: event.summary,
      metadata: event.metadata,
      relatedFiles: event.related_files,
      evidenceRefs: event.evidence_refs,
    }));

    await saveWorkflowEvents(events);
    return c.json({ ingested: events.length }, 201);
  },
);

syncRouter.get('/brain/events/:projectId', async (c) => {
  const orgId = c.get('orgId');
  const projectId = c.req.param('projectId');
  const taskId = c.req.query('task_id') ?? undefined;

  const proj = await requireProjectForOrg(projectId, orgId);
  if (!proj) return c.json({ error: 'project_not_found', project_id: projectId }, 404);

  const events = await loadWorkflowEvents(projectId, taskId);
  return c.json({ events, count: events.length });
});

syncRouter.post(
  '/brain/replays',
  zValidator('json', taskReplayBody),
  async (c) => {
    const orgId = c.get('orgId');
    const body = c.req.valid('json');

    const proj = await requireProjectForOrg(body.project_id, orgId);
    if (!proj) return c.json({ error: 'project_not_found', project_id: body.project_id }, 404);

    const result = await buildAndSaveReplay(body.project_id, body.task_id);
    return c.json(result, 201);
  },
);

syncRouter.get('/brain/replays/:projectId', async (c) => {
  const orgId = c.get('orgId');
  const projectId = c.req.param('projectId');

  const proj = await requireProjectForOrg(projectId, orgId);
  if (!proj) return c.json({ error: 'project_not_found', project_id: projectId }, 404);

  const replays = await loadTaskReplays(projectId);
  return c.json({ replays, count: replays.length });
});

syncRouter.get('/brain/replays/:projectId/:taskId/markdown', async (c) => {
  const orgId = c.get('orgId');
  const projectId = c.req.param('projectId');
  const taskId = c.req.param('taskId');

  const proj = await requireProjectForOrg(projectId, orgId);
  if (!proj) return c.json({ error: 'project_not_found', project_id: projectId }, 404);

  try {
    const markdown = await renderTaskReplayMarkdownForTask(projectId, taskId);
    return c.text(markdown);
  } catch (err) {
    return c.json({ error: 'replay_not_found', message: (err as Error).message }, 404);
  }
});

syncRouter.get('/brain/lessons/:projectId', async (c) => {
  const orgId = c.get('orgId');
  const projectId = c.req.param('projectId');

  const proj = await requireProjectForOrg(projectId, orgId);
  if (!proj) return c.json({ error: 'project_not_found', project_id: projectId }, 404);

  // Auto-generate lessons from real data if ?generate=true or no lessons exist
  const existing = await loadLessons(projectId);
  const shouldGenerate = c.req.query('generate') === 'true' || existing.length === 0;

  if (shouldGenerate) {
    const generated = await generateLessonsFromData(projectId);
    // Reload all lessons (generated + any previously saved)
    const all = await loadLessons(projectId);
    return c.json({ lessons: all, count: all.length, generated: generated.length });
  }

  return c.json({ lessons: existing, count: existing.length, generated: 0 });
});

syncRouter.post(
  '/brain/context-packets',
  zValidator('json', contextPacketBody),
  async (c) => {
    const orgId = c.get('orgId');
    const body = c.req.valid('json');

    const proj = await requireProjectForOrg(body.project_id, orgId);
    if (!proj) return c.json({ error: 'project_not_found', project_id: body.project_id }, 404);

    const packet = await createAndSaveContextPacket({
      projectId: body.project_id,
      taskDescription: body.task_description,
      files: body.files,
    });

    return c.json(packet, 201);
  },
);

syncRouter.post('/brain/metrics/:projectId', async (c) => {
  const orgId = c.get('orgId');
  const projectId = c.req.param('projectId');

  const proj = await requireProjectForOrg(projectId, orgId);
  if (!proj) return c.json({ error: 'project_not_found', project_id: projectId }, 404);

  const metrics = await calculateAndSaveMetrics(projectId);
  return c.json(metrics, 201);
});

syncRouter.post(
  '/brain/weekly-report',
  zValidator('json', weeklyReportBody),
  async (c) => {
    const orgId = c.get('orgId');
    const body = c.req.valid('json');

    const proj = await requireProjectForOrg(body.project_id, orgId);
    if (!proj) return c.json({ error: 'project_not_found', project_id: body.project_id }, 404);

    const report_markdown = await generateAndSaveWeeklyReport(
      body.project_id,
      new Date(body.week_start),
      new Date(body.week_end),
    );

    return c.json({ report_markdown }, 201);
  },
);

// ── Exploration Analysis ────────────────────────────────────────────────────

syncRouter.post('/brain/exploration/:projectId', async (c) => {
  const orgId = c.get('orgId');
  const projectId = c.req.param('projectId');

  const proj = await requireProjectForOrg(projectId, orgId);
  if (!proj) return c.json({ error: 'project_not_found', project_id: projectId }, 404);

  const body = await c.req.json() as {
    task_id: string;
    task_description?: string;
  };

  if (!body.task_id) {
    return c.json({ error: 'task_id_required' }, 400);
  }

  const analysis = await analyzeExploration(projectId, body.task_id, body.task_description);
  return c.json(analysis);
});

// ── Health / Cockpit ────────────────────────────────────────────────────────

syncRouter.get('/health/:projectId', async (c) => {
  const orgId = c.get('orgId');
  const projectId = c.req.param('projectId');

  const proj = await requireProjectForOrg(projectId, orgId);
  if (!proj) return c.json({ error: 'project_not_found', project_id: projectId }, 404);

  const now = new Date();
  const twentyFourHours = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const oneHour = new Date(now.getTime() - 60 * 60 * 1000);

  // Gather signals from real data
  const [recentFiles, recentMemories, lessons] = await Promise.all([
    db
      .select({ filePath: fileEvents.filePath, eventType: fileEvents.eventType, timestamp: fileEvents.timestamp })
      .from(fileEvents)
      .where(and(eq(fileEvents.projectId, projectId), gte(fileEvents.timestamp, twentyFourHours)))
      .orderBy(desc(fileEvents.timestamp))
      .limit(500),
    db
      .select({ id: memoryEntries.id, category: memoryEntries.category, createdAt: memoryEntries.createdAt })
      .from(memoryEntries)
      .where(and(eq(memoryEntries.projectId, projectId), gte(memoryEntries.createdAt, twentyFourHours)))
      .orderBy(desc(memoryEntries.createdAt)),
    db
      .select({ id: operationalLessons.id, area: operationalLessons.area, confidence: operationalLessons.confidence })
      .from(operationalLessons)
      .where(eq(operationalLessons.projectId, projectId)),
  ]);

  // Compute cockpit signals
  const uniqueFiles = new Set(recentFiles.map((f) => f.filePath));
  const recentHourFiles = recentFiles.filter((f) => f.timestamp >= oneHour);
  const uniqueRecentFiles = new Set(recentHourFiles.map((f) => f.filePath));

  // Scope: how many files touched in 24h
  const scopeCount = uniqueFiles.size;
  const scopeStatus = scopeCount <= 5 ? 'green' : scopeCount <= 15 ? 'amber' : 'red';
  const scopeDetail = `${scopeCount} files changed in the last 24 hours`;

  // Focus: how many distinct directories (modules)
  const dirs = new Set(Array.from(uniqueFiles).map((f) => f.split('/').slice(0, -1).join('/')).filter(Boolean));
  const focusStatus = dirs.size <= 2 ? 'green' : dirs.size <= 4 ? 'amber' : 'red';
  const focusDetail = `changes span ${dirs.size} directories`;

  // Repetition: any file edited more than 3 times in the last hour
  const hourFileCounts = new Map<string, number>();
  for (const f of recentHourFiles) {
    hourFileCounts.set(f.filePath, (hourFileCounts.get(f.filePath) ?? 0) + 1);
  }
  const maxRepeat = Math.max(0, ...hourFileCounts.values());
  const repetitionStatus = maxRepeat <= 2 ? 'green' : maxRepeat <= 4 ? 'amber' : 'red';
  const repetitionDetail = maxRepeat <= 2
    ? 'no file edited more than twice in the last hour'
    : `a file was edited ${maxRepeat} times in the last hour`;

  // Duration: total activity window
  const timestamps = recentFiles.map((f) => f.timestamp.getTime());
  const activitySpanHours = timestamps.length > 1
    ? (Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60 * 60)
    : 0;
  const durationStatus = activitySpanHours <= 4 ? 'green' : activitySpanHours <= 12 ? 'amber' : 'red';
  const durationDetail = `${Math.round(activitySpanHours)}h activity window in the last 24h`;

  // Trajectory: lessons and bug patterns
  const bugMemories = recentMemories.filter((m) => m.category === 'bug_fix');
  const highConfLessons = lessons.filter((l) => (l.confidence ?? 0) >= 0.7);
  const trajectoryStatus = bugMemories.length === 0 && highConfLessons.length <= 2
    ? 'green'
    : bugMemories.length <= 2 && highConfLessons.length <= 5
      ? 'amber'
      : 'red';
  const trajectoryDetail = `${lessons.length} lessons (${highConfLessons.length} high confidence), ${bugMemories.length} recent bugs`;

  // Overall status
  const statuses = [scopeStatus, focusStatus, repetitionStatus, durationStatus, trajectoryStatus];
  const overallStatus = statuses.includes('red') ? 'red' : statuses.includes('amber') ? 'amber' : 'green';

  const summaryText = overallStatus === 'green'
    ? `Healthy — ${scopeCount} files, ${recentMemories.length} events, all signals green.`
    : overallStatus === 'amber'
      ? `Running warm — ${scopeCount} files across ${dirs.size} modules in 24h.`
      : `Running hot — ${scopeCount} files across ${dirs.size} modules, ${maxRepeat}x repetition detected.`;

  return c.json({
    status: overallStatus,
    summary: summaryText,
    signals: {
      scope: { status: scopeStatus, detail: scopeDetail },
      focus: { status: focusStatus, detail: focusDetail },
      repetition: { status: repetitionStatus, detail: repetitionDetail },
      duration: { status: durationStatus, detail: durationDetail },
      trajectory: { status: trajectoryStatus, detail: trajectoryDetail },
    },
    source: 'api',
  });
});
