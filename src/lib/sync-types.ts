import { z } from 'zod';

export const createProjectBody = z.object({
  name: z.string().min(1).max(200),
  root_path: z.string().min(1),
});

export const startSessionBody = z.object({
  project_id: z.string().min(1),
  tool: z.enum(['claude-code', 'cursor', 'codex']),
});

export const sessionIdParam = z.object({
  id: z.string().uuid(),
});

const fileEventItem = z.object({
  file_path: z.string().min(1),
  event_type: z.enum(['created', 'modified', 'deleted', 'read']),
  diff: z.string().optional(),
  file_size: z.number().nonnegative().optional(),
  timestamp: z.string().datetime().optional(),
});

export const ingestFileEventsBody = z.object({
  project_id: z.string().min(1),
  session_id: z.string().uuid().optional(),
  events: z.array(fileEventItem).min(1).max(500),
});

export const createMemoryBody = z.object({
  project_id: z.string().min(1),
  session_id: z.string().uuid().optional(),
  category: z.enum(['bug_fix', 'schema_change', 'project_rule', 'decision', 'constraint', 'note']),
  title: z.string().min(1).max(500),
  body: z.string().min(1),
  related_files: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  supersedes: z.string().uuid().optional(),
});

export const memoryIdParam = z.object({
  id: z.string().uuid(),
});

export const updateMemoryBody = z.object({
  title: z.string().min(1).max(500).optional(),
  body: z.string().min(1).optional(),
  related_files: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  archived: z.enum(['true', 'false']).optional(),
});

export const memoryQueryParams = z.object({
  category: z
    .enum(['bug_fix', 'schema_change', 'project_rule', 'decision', 'constraint', 'note'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  since: z.string().datetime().optional(),
  include_archived: z.enum(['true', 'false']).default('false'),
});

export const contextQuery = z.object({
  max_tokens: z.coerce.number().int().min(100).max(10000).default(2000),
  format: z.enum(['plain', 'markdown']).default('plain'),
});
