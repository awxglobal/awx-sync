-- awx-sync: create the 5 new tables
-- organizations already exists in this Supabase project (from AWX Shredder)

CREATE TABLE IF NOT EXISTS "projects" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "root_path" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "sync_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "tool" text NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "summary" jsonb
);

CREATE TABLE IF NOT EXISTS "file_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "session_id" uuid REFERENCES "sync_sessions"("id") ON DELETE set null,
  "file_path" text NOT NULL,
  "event_type" text NOT NULL,
  "diff" text,
  "file_size" double precision,
  "timestamp" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "memory_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "session_id" uuid REFERENCES "sync_sessions"("id") ON DELETE set null,
  "category" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "related_files" jsonb DEFAULT '[]'::jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "superseded_by" uuid,
  "archived" text DEFAULT 'false' NOT NULL
);

CREATE TABLE IF NOT EXISTS "context_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "content" text NOT NULL,
  "token_estimate" double precision NOT NULL,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Indexes for fast context generation queries
CREATE INDEX IF NOT EXISTS "file_events_project_time_idx" ON "file_events" ("project_id", "timestamp" DESC);
CREATE INDEX IF NOT EXISTS "file_events_project_path_idx" ON "file_events" ("project_id", "file_path", "timestamp" DESC);
CREATE INDEX IF NOT EXISTS "memory_entries_project_cat_idx" ON "memory_entries" ("project_id", "category", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "sync_sessions_project_time_idx" ON "sync_sessions" ("project_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "context_snapshots_project_time_idx" ON "context_snapshots" ("project_id", "generated_at" DESC);
