/**
 * Automatic Lesson Generator
 *
 * Reads real data from memory_entries + file_events (populated by GitHub webhooks)
 * and generates operational_lessons with confidence scores.
 *
 * Pattern detectors:
 *   1. Hot files        — files edited in many PRs/pushes are fragile
 *   2. Bug-prone files  — files mentioned in bug_fix memories repeatedly
 *   3. CI failure zones — files associated with CI failures
 *   4. Review friction  — files that get review change requests
 *   5. Churn patterns   — files created and quickly modified (unstable)
 *   6. Co-change groups — files that always change together
 */

import { createHash } from 'node:crypto';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  fileEvents,
  memoryEntries,
  operationalLessons,
} from '../db/schema.js';
import type { OperationalLesson } from './learning-spine.js';

interface GeneratedLesson {
  area: string;
  trigger: string;
  lesson: string;
  appliesToFiles: string[];
  confidence: number;
  evidenceCount: number;
}

/**
 * Analyze project data and generate/update lessons.
 * Call this on-demand (GET /brain/lessons) or on a schedule.
 */
export async function generateLessonsFromData(projectId: string): Promise<OperationalLesson[]> {
  const ninetyDays = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // Load raw data
  const [memories, files] = await Promise.all([
    db
      .select({
        id: memoryEntries.id,
        category: memoryEntries.category,
        title: memoryEntries.title,
        body: memoryEntries.body,
        relatedFiles: memoryEntries.relatedFiles,
        metadata: memoryEntries.metadata,
        createdAt: memoryEntries.createdAt,
      })
      .from(memoryEntries)
      .where(and(eq(memoryEntries.projectId, projectId), gte(memoryEntries.createdAt, ninetyDays)))
      .orderBy(desc(memoryEntries.createdAt)),
    db
      .select({
        filePath: fileEvents.filePath,
        eventType: fileEvents.eventType,
        timestamp: fileEvents.timestamp,
      })
      .from(fileEvents)
      .where(and(eq(fileEvents.projectId, projectId), gte(fileEvents.timestamp, ninetyDays)))
      .orderBy(desc(fileEvents.timestamp)),
  ]);

  const generated: GeneratedLesson[] = [];

  // ── Pattern 1: Hot Files (many edits or many different days) ─────────────
  const fileEditDays = new Map<string, Set<string>>();
  const fileEditCount = new Map<string, number>();
  for (const f of files) {
    if (f.eventType === 'modified') {
      const day = f.timestamp.toISOString().slice(0, 10);
      if (!fileEditDays.has(f.filePath)) fileEditDays.set(f.filePath, new Set());
      fileEditDays.get(f.filePath)!.add(day);
      fileEditCount.set(f.filePath, (fileEditCount.get(f.filePath) ?? 0) + 1);
    }
  }
  for (const [filePath, days] of fileEditDays) {
    const edits = fileEditCount.get(filePath) ?? 0;
    // Trigger on 2+ different days OR 2+ edits in a single period
    if ((days.size >= 2 || edits >= 2) && !isBoilerplate(filePath)) {
      const reason = days.size >= 2
        ? `modified on ${days.size} different days`
        : `modified ${edits} times`;
      generated.push({
        area: 'hot-file',
        trigger: `${filePath} was ${reason} in the last 90 days.`,
        lesson: `${shortName(filePath)} changes frequently — run focused tests before committing changes to this file.`,
        appliesToFiles: [filePath],
        confidence: Math.min(0.45 + Math.max(days.size, edits / 2) * 0.08, 0.95),
        evidenceCount: Math.max(days.size, edits),
      });
    }
  }

  // ── Pattern 2: Bug-Prone Files ──────────────────────────────────────────
  const bugMemories = memories.filter((m) => {
    const meta = m.metadata as Record<string, unknown> | null;
    return m.category === 'bug_fix' || meta?.event === 'ci_failed';
  });
  const bugFileCount = new Map<string, number>();
  for (const m of bugMemories) {
    const files = extractFilesFromMemory(m);
    for (const f of files) bugFileCount.set(f, (bugFileCount.get(f) ?? 0) + 1);
  }
  for (const [filePath, count] of bugFileCount) {
    if (count >= 2 && !isBoilerplate(filePath)) {
      generated.push({
        area: 'bug-prone',
        trigger: `${filePath} appeared in ${count} bug fix or CI failure events.`,
        lesson: `${shortName(filePath)} has a history of bugs — review changes carefully and add regression tests.`,
        appliesToFiles: [filePath],
        confidence: Math.min(0.6 + count * 0.1, 0.95),
        evidenceCount: count,
      });
    }
  }

  // ── Pattern 3: CI Failure Zones ─────────────────────────────────────────
  const ciFailures = memories.filter((m) => {
    const meta = m.metadata as Record<string, unknown> | null;
    return meta?.event === 'ci_failed';
  });
  if (ciFailures.length >= 2) {
    const checkNames = ciFailures.map((m) => {
      const meta = m.metadata as Record<string, unknown> | null;
      return (meta?.check_name as string) ?? 'unknown';
    });
    const nameCounts = new Map<string, number>();
    for (const n of checkNames) nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);

    for (const [checkName, count] of nameCounts) {
      if (count >= 2) {
        generated.push({
          area: 'ci-instability',
          trigger: `CI check "${checkName}" failed ${count} times in 90 days.`,
          lesson: `The "${checkName}" CI check is flaky or fragile — investigate root cause before ignoring failures.`,
          appliesToFiles: [],
          confidence: Math.min(0.55 + count * 0.1, 0.9),
          evidenceCount: count,
        });
      }
    }
  }

  // ── Pattern 4: Review Friction ──────────────────────────────────────────
  const reviewMemories = memories.filter((m) => {
    const meta = m.metadata as Record<string, unknown> | null;
    return meta?.event === 'review_submitted' && meta?.state === 'changes_requested';
  });
  if (reviewMemories.length >= 2) {
    generated.push({
      area: 'review-friction',
      trigger: `${reviewMemories.length} PRs received "changes requested" reviews in 90 days.`,
      lesson: `PRs in this project frequently need revision — include clear PR descriptions and self-review before requesting review.`,
      appliesToFiles: [],
      confidence: Math.min(0.5 + reviewMemories.length * 0.08, 0.85),
      evidenceCount: reviewMemories.length,
    });
  }

  // ── Pattern 5: Churn (created then quickly modified) ────────────────────
  const createdFiles = new Map<string, Date>();
  const modifiedAfterCreate = new Map<string, number>();
  for (const f of [...files].reverse()) { // oldest first
    if (f.eventType === 'created') {
      createdFiles.set(f.filePath, f.timestamp);
    } else if (f.eventType === 'modified' && createdFiles.has(f.filePath)) {
      const created = createdFiles.get(f.filePath)!;
      const hoursSinceCreate = (f.timestamp.getTime() - created.getTime()) / (1000 * 60 * 60);
      if (hoursSinceCreate < 48) {
        modifiedAfterCreate.set(f.filePath, (modifiedAfterCreate.get(f.filePath) ?? 0) + 1);
      }
    }
  }
  for (const [filePath, mods] of modifiedAfterCreate) {
    if (mods >= 2 && !isBoilerplate(filePath)) {
      generated.push({
        area: 'unstable-new-file',
        trigger: `${filePath} was modified ${mods} times within 48h of creation.`,
        lesson: `${shortName(filePath)} was unstable right after creation — plan the interface before implementing.`,
        appliesToFiles: [filePath],
        confidence: Math.min(0.5 + mods * 0.07, 0.8),
        evidenceCount: mods,
      });
    }
  }

  // ── Pattern 6: Co-Change Groups ─────────────────────────────────────────
  // Files that always change on the same day likely have hidden dependencies
  const dayFiles = new Map<string, string[]>();
  for (const f of files) {
    if (f.eventType !== 'modified') continue;
    const day = f.timestamp.toISOString().slice(0, 10);
    if (!dayFiles.has(day)) dayFiles.set(day, []);
    dayFiles.get(day)!.push(f.filePath);
  }
  const pairCount = new Map<string, number>();
  for (const [, dayFileList] of dayFiles) {
    const unique = [...new Set(dayFileList)].filter((f) => !isBoilerplate(f));
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = [unique[i], unique[j]].sort().join('::');
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [pair, count] of pairCount) {
    if (count >= 2) {
      const [a, b] = pair.split('::');
      generated.push({
        area: 'co-change',
        trigger: `${shortName(a)} and ${shortName(b)} changed together on ${count} different days.`,
        lesson: `${shortName(a)} and ${shortName(b)} are tightly coupled — changes to one likely need changes to the other.`,
        appliesToFiles: [a, b],
        confidence: Math.min(0.55 + count * 0.08, 0.9),
        evidenceCount: count,
      });
    }
  }

  // ── Pattern 7: PR merge velocity ────────────────────────────────────────
  const prOpened = memories.filter((m) => {
    const meta = m.metadata as Record<string, unknown> | null;
    return meta?.event === 'pr_opened' || meta?.source === 'github' && m.title.includes('PR #') && m.title.includes('opened');
  });
  const prMerged = memories.filter((m) => {
    const meta = m.metadata as Record<string, unknown> | null;
    return meta?.event === 'pr_merged';
  });
  if (prOpened.length >= 3 && prMerged.length > 0) {
    const mergeRate = prMerged.length / prOpened.length;
    if (mergeRate < 0.5) {
      generated.push({
        area: 'low-merge-rate',
        trigger: `Only ${prMerged.length} of ${prOpened.length} PRs were merged (${Math.round(mergeRate * 100)}%).`,
        lesson: `Many PRs are opened but not merged — consider smaller, more focused PRs.`,
        appliesToFiles: [],
        confidence: 0.65,
        evidenceCount: prOpened.length,
      });
    }
  }

  // ── Convert to OperationalLesson format and save ────────────────────────
  const now = new Date().toISOString();
  const lessons: OperationalLesson[] = generated.map((g) => {
    const hash = createHash('sha1')
      .update(JSON.stringify({ projectId, area: g.area, files: g.appliesToFiles.sort(), lesson: g.lesson }))
      .digest('hex')
      .slice(0, 12);
    return {
      id: `lesson_auto_${hash}`,
      repoId: projectId,
      scope: 'repo' as const,
      area: g.area,
      trigger: g.trigger,
      lesson: g.lesson,
      evidenceRefs: [],
      appliesToFiles: g.appliesToFiles,
      requiredTests: [],
      reviewerExpectations: [],
      confidence: g.confidence,
      status: 'proposed' as const,
      createdAt: now,
      updatedAt: now,
    };
  });

  // Upsert into DB (don't duplicate existing lessons)
  if (lessons.length > 0) {
    for (const lesson of lessons) {
      await db
        .insert(operationalLessons)
        .values({
          id: lesson.id,
          projectId: lesson.repoId,
          scope: lesson.scope,
          area: lesson.area,
          trigger: lesson.trigger,
          lesson: lesson.lesson,
          evidenceRefs: lesson.evidenceRefs,
          appliesToFiles: lesson.appliesToFiles,
          requiredTests: lesson.requiredTests,
          reviewerExpectations: lesson.reviewerExpectations,
          confidence: lesson.confidence,
          status: lesson.status,
          createdAt: new Date(lesson.createdAt),
          updatedAt: new Date(lesson.updatedAt),
        })
        .onConflictDoUpdate({
          target: operationalLessons.id,
          set: {
            trigger: lesson.trigger,
            confidence: lesson.confidence,
            updatedAt: new Date(),
          },
        });
    }
  }

  return lessons;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractFilesFromMemory(m: {
  relatedFiles: unknown;
  title: string;
  body: string;
  metadata: unknown;
}): string[] {
  // From relatedFiles array
  const files: string[] = [];
  if (Array.isArray(m.relatedFiles)) {
    files.push(...m.relatedFiles.filter((f): f is string => typeof f === 'string'));
  }
  // From title/body — extract file paths like src/foo/bar.ts
  const pathPattern = /(?:^|\s)((?:src|lib|routes|components|app|pages|api|db|mcp)\/[\w/.,-]+\.\w+)/g;
  for (const match of `${m.title} ${m.body}`.matchAll(pathPattern)) {
    files.push(match[1]);
  }
  return [...new Set(files)];
}

function shortName(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : filePath;
}

function isBoilerplate(filePath: string): boolean {
  return /^(package\.json|package-lock\.json|tsconfig\.json|\.gitignore|README\.md|node_modules|dist\/|\.next\/)/.test(filePath);
}
