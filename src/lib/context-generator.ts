import { and, desc, eq, gte, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { fileEvents, memoryEntries, projects, syncSessions } from '../db/schema.js';

interface ContextOptions {
  maxTokens?: number;
}

interface Section {
  label: string;
  content: string;
  priority: number; // lower = trimmed first
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function generateContextBlock(
  projectId: string,
  opts: ContextOptions = {},
): Promise<{ content: string; tokenEstimate: number }> {
  const maxTokens = opts.maxTokens ?? 2000;
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since2h = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  const [proj] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!proj) throw new Error(`Project ${projectId} not found`);

  // ── Queries (parallel) ───────────────────────────────────────────────────

  const [recentFileRows, activeFileRows, allMemories, lastSession] = await Promise.all([
    // Files edited in last 24h — grouped by path, sorted by edit count
    db
      .select({
        filePath: fileEvents.filePath,
        editCount: sql<number>`count(*) filter (where ${fileEvents.eventType} = 'modified')::int`,
        readCount: sql<number>`count(*) filter (where ${fileEvents.eventType} = 'read')::int`,
        lastSeen: sql<Date>`max(${fileEvents.timestamp})`,
        eventTypes: sql<string[]>`array_agg(distinct ${fileEvents.eventType})`,
      })
      .from(fileEvents)
      .where(
        and(
          eq(fileEvents.projectId, projectId),
          gte(fileEvents.timestamp, since24h),
        ),
      )
      .groupBy(fileEvents.filePath)
      .orderBy(
        sql`count(*) filter (where ${fileEvents.eventType} = 'modified') desc`,
      )
      .limit(20),

    // Files touched in last 2h = "currently active"
    db
      .select({ filePath: fileEvents.filePath })
      .from(fileEvents)
      .where(
        and(
          eq(fileEvents.projectId, projectId),
          gte(fileEvents.timestamp, since2h),
        ),
      )
      .groupBy(fileEvents.filePath)
      .orderBy(sql`max(${fileEvents.timestamp}) desc`)
      .limit(10),

    // All live memory entries (not archived, not superseded)
    db
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.projectId, projectId),
          eq(memoryEntries.archived, 'false'),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(100),

    // Last completed session
    db
      .select()
      .from(syncSessions)
      .where(
        and(
          eq(syncSessions.projectId, projectId),
          ne(syncSessions.endedAt, null as unknown as Date),
        ),
      )
      .orderBy(desc(syncSessions.startedAt))
      .limit(1),
  ]);

  // ── Derive "what they're in the middle of" ──────────────────────────────

  const hottestFile = recentFileRows[0];
  const activeFilePaths = new Set(activeFileRows.map((r) => r.filePath));

  const lastDecision = allMemories.find(
    (m) => m.category === 'decision' || m.category === 'project_rule',
  );
  const lastBug = allMemories.find((m) => m.category === 'bug_fix');

  // ── Build header ────────────────────────────────────────────────────────

  const updatedAt = timeAgo(now);
  let header = `=== PROJECT STATE ===\n`;
  header += `${proj.name}`;
  if (hottestFile) {
    header += ` | active in ${hottestFile.filePath.split('/').slice(-2).join('/')}`;
  }
  header += `\n`;

  if (lastDecision) {
    header += `Last decision: "${lastDecision.title}"\n`;
  }

  // ── Sections ────────────────────────────────────────────────────────────

  const sections: Section[] = [];

  // Active files (highest priority — this is the "where are you" signal)
  if (activeFileRows.length > 0) {
    const lines = activeFileRows
      .map((r) => `  ${r.filePath}`)
      .join('\n');
    sections.push({
      label: 'ACTIVE NOW',
      content: `## ACTIVE NOW (last 2h)\n${lines}`,
      priority: 10,
    });
  }

  // Recent file activity
  if (recentFileRows.length > 0) {
    const lines = recentFileRows
      .map((r) => {
        const types = (r.eventTypes as string[]) ?? [];
        const marker = types.includes('created')
          ? '[+]'
          : types.includes('deleted')
            ? '[x]'
            : '[~]';
        const edits = r.editCount > 0 ? ` ${r.editCount} edit${r.editCount !== 1 ? 's' : ''}` : '';
        const hot = activeFilePaths.has(r.filePath) ? ' ●' : '';
        return `  ${marker} ${r.filePath}${edits}, ${timeAgo(new Date(r.lastSeen))}${hot}`;
      })
      .join('\n');
    sections.push({
      label: 'FILE ACTIVITY',
      content: `## FILE ACTIVITY (last 24h)\n${lines}`,
      priority: 9,
    });
  }

  // Memory by category
  const categories: Array<{
    key: string;
    label: string;
    priority: number;
  }> = [
    { key: 'bug_fix', label: 'BUGS FIXED', priority: 8 },
    { key: 'schema_change', label: 'SCHEMA', priority: 8 },
    { key: 'decision', label: 'DECISIONS', priority: 7 },
    { key: 'project_rule', label: 'RULES IN FORCE', priority: 7 },
    { key: 'constraint', label: 'CONSTRAINTS', priority: 6 },
    { key: 'note', label: 'NOTES', priority: 5 },
  ];

  for (const cat of categories) {
    const entries = allMemories.filter((m) => m.category === cat.key);
    if (entries.length === 0) continue;

    const lines = entries
      .map((e) => {
        const files =
          e.relatedFiles && (e.relatedFiles as string[]).length > 0
            ? ` — ${(e.relatedFiles as string[]).join(', ')}`
            : '';
        return `  - ${e.title}${files}`;
      })
      .join('\n');

    sections.push({
      label: cat.label,
      content: `## ${cat.label}\n${lines}`,
      priority: cat.priority,
    });
  }

  // Last session summary
  if (lastSession.length > 0) {
    const s = lastSession[0];
    const sum = s.summary as { filesEdited: number; filesRead: number; memoriesCreated: number } | null;
    if (sum) {
      const line = `  ${s.tool} session: ${sum.filesEdited} files edited, ${sum.memoriesCreated} memories added (${timeAgo(new Date(s.startedAt))})`;
      sections.push({
        label: 'LAST SESSION',
        content: `## LAST SESSION\n${line}`,
        priority: 4,
      });
    }
  }

  // ── Token-budget trimming ────────────────────────────────────────────────

  const headerTokens = estimateTokens(header);
  const footerText = `=== END ===`;
  const footerTokens = estimateTokens(footerText);
  let budget = maxTokens - headerTokens - footerTokens - 10;

  // Sort ascending by priority so we trim lowest first
  const sorted = [...sections].sort((a, b) => a.priority - b.priority);
  const kept: Section[] = [];

  // Add from highest priority downward
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i];
    const tokens = estimateTokens(s.content + '\n');
    if (tokens <= budget) {
      kept.push(s);
      budget -= tokens;
    }
    // If a section doesn't fit, skip it (don't truncate mid-section)
  }

  // Restore original order
  const orderedKept = sections.filter((s) => kept.includes(s));

  const body = orderedKept.map((s) => s.content).join('\n\n');
  const content = `${header}\n${body}\n\n${footerText}`;
  const tokenEstimate = estimateTokens(content);

  return { content, tokenEstimate };
}


