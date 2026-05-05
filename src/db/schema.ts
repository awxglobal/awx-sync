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

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  apiKeyHash: text('api_key_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
