import { sql } from 'drizzle-orm';
import {
  doublePrecision,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// ── Auth ─────────────────────────────────────────────────────────────────────
// Matches the existing table in Supabase (shared with AWX Shredder).
// We only use id + api_key_hash; the other columns are AWX Shredder's.

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  planTier: text('plan_tier', { enum: ['FREE', 'PAID'] }),
  email: text('email'),
  openaiApiKey: text('openai_api_key'),
  apiKeyHash: text('api_key_hash'),
});

// ── Projects ─────────────────────────────────────────────────────────────────

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  rootPath: text('root_path').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Sessions ─────────────────────────────────────────────────────────────────

export const syncSessions = pgTable('sync_sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  summary: jsonb('summary').$type<{
    filesEdited: number;
    filesRead: number;
    memoriesCreated: number;
  }>(),
});

// ── File Events ──────────────────────────────────────────────────────────────

export const fileEvents = pgTable('file_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => syncSessions.id, {
    onDelete: 'set null',
  }),
  filePath: text('file_path').notNull(),
  eventType: text('event_type', {
    enum: ['created', 'modified', 'deleted', 'read'],
  }).notNull(),
  diff: text('diff'),
  fileSize: doublePrecision('file_size'),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
});

// ── Memory ───────────────────────────────────────────────────────────────────

export const memoryEntries = pgTable('memory_entries', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => syncSessions.id, {
    onDelete: 'set null',
  }),
  category: text('category', {
    enum: ['bug_fix', 'schema_change', 'project_rule', 'decision', 'constraint', 'note'],
  }).notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  relatedFiles: jsonb('related_files').$type<string[]>().default([]),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  supersededBy: uuid('superseded_by'),
  archived: text('archived', { enum: ['true', 'false'] }).notNull().default('false'),
});

// ── Context Snapshots ────────────────────────────────────────────────────────

export const contextSnapshots = pgTable('context_snapshots', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  tokenEstimate: doublePrecision('token_estimate').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Types ─────────────────────────────────────────────────────────────────────

// Replay + Learning Spine

export const workflowEvents = pgTable('workflow_events', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull(),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
  sourceTool: text('source_tool').notNull(),
  actorType: text('actor_type').notNull(),
  type: text('type').notNull(),
  summary: text('summary').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  relatedFiles: jsonb('related_files').$type<string[]>().notNull().default([]),
  evidenceRefs: jsonb('evidence_refs').$type<Array<Record<string, unknown>>>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const taskReplays = pgTable('task_replays', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  finalOutcome: text('final_outcome').notNull(),
  replay: jsonb('replay').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const operationalLessons = pgTable('operational_lessons', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  scope: text('scope').notNull(),
  area: text('area').notNull(),
  trigger: text('trigger').notNull(),
  lesson: text('lesson').notNull(),
  evidenceRefs: jsonb('evidence_refs').$type<string[]>().notNull().default([]),
  appliesToFiles: jsonb('applies_to_files').$type<string[]>().notNull().default([]),
  requiredTests: jsonb('required_tests').$type<string[]>().notNull().default([]),
  reviewerExpectations: jsonb('reviewer_expectations').$type<string[]>().notNull().default([]),
  confidence: doublePrecision('confidence').notNull(),
  status: text('status').notNull().default('proposed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const contextPackets = pgTable('context_packets', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  taskDescription: text('task_description').notNull(),
  files: jsonb('files').$type<string[]>().notNull().default([]),
  packet: jsonb('packet').$type<Record<string, unknown>>().notNull(),
  briefingMarkdown: text('briefing_markdown').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const metricsSnapshots = pgTable('metrics_snapshots', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const weeklyReports = pgTable('weekly_reports', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  weekStart: timestamp('week_start', { withTimezone: true }).notNull(),
  weekEnd: timestamp('week_end', { withTimezone: true }).notNull(),
  metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull(),
  reportMarkdown: text('report_markdown').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type SyncSession = typeof syncSessions.$inferSelect;
export type NewSyncSession = typeof syncSessions.$inferInsert;
export type FileEvent = typeof fileEvents.$inferSelect;
export type NewFileEvent = typeof fileEvents.$inferInsert;
export type MemoryEntry = typeof memoryEntries.$inferSelect;
export type NewMemoryEntry = typeof memoryEntries.$inferInsert;
export type ContextSnapshot = typeof contextSnapshots.$inferSelect;
export type NewContextSnapshot = typeof contextSnapshots.$inferInsert;
export type WorkflowEventRow = typeof workflowEvents.$inferSelect;
export type NewWorkflowEventRow = typeof workflowEvents.$inferInsert;
export type TaskReplayRow = typeof taskReplays.$inferSelect;
export type NewTaskReplayRow = typeof taskReplays.$inferInsert;
export type OperationalLessonRow = typeof operationalLessons.$inferSelect;
export type NewOperationalLessonRow = typeof operationalLessons.$inferInsert;
export type ContextPacketRow = typeof contextPackets.$inferSelect;
export type NewContextPacketRow = typeof contextPackets.$inferInsert;
export type MetricsSnapshotRow = typeof metricsSnapshots.$inferSelect;
export type NewMetricsSnapshotRow = typeof metricsSnapshots.$inferInsert;
export type WeeklyReportRow = typeof weeklyReports.$inferSelect;
export type NewWeeklyReportRow = typeof weeklyReports.$inferInsert;

