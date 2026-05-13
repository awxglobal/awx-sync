/**
 * GitHub webhook receiver + GitHub write-back API endpoints.
 *
 * Receives:
 *   POST /webhooks/github          — webhook events from GitHub App
 *   POST /webhooks/github/install   — installation callback
 *
 * Write-back (requires API key):
 *   POST /github/create-pr         — create PR from brain context
 *   POST /github/create-issue      — create issue from brain context
 */

import { randomBytes } from 'node:crypto';
import { and, eq, gte } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import {
  fileEvents,
  memoryEntries,
  organizations,
  projects,
} from '../db/schema.js';
import { generateContextBlock } from '../lib/context-generator.js';
import { githubApi, getPRFiles, newGithubId, postPRComment, postIssueComment, verifyWebhookSignature } from '../lib/github.js';
import { analyzePR, formatPRComment, formatIssueComment } from '../lib/pr-analysis.js';
import { requireApiKey } from '../middleware/requireApiKey.js';
import type { AppEnv } from '../types.js';

export const githubRouter = new Hono<AppEnv>();

// ── Webhook Receiver ────────────────────────────────────────────────────────

githubRouter.post('/webhooks/github', async (c) => {
  const signature = c.req.header('x-hub-signature-256') ?? '';
  const event = c.req.header('x-github-event') ?? '';
  const rawBody = await c.req.text();

  // Verify signature if GITHUB_WEBHOOK_SECRET is set
  if (process.env.GITHUB_WEBHOOK_SECRET && !verifyWebhookSignature(rawBody, signature)) {
    return c.json({ error: 'invalid_signature' }, 401);
  }

  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  const action = payload.action as string | undefined;
  const repo = (payload.repository as Record<string, unknown>)?.full_name ?? 'unknown';
  console.log(`[webhook] Received event=${event} action=${action} repo=${repo}`);

  try {
    switch (event) {
      case 'pull_request':
        await handlePullRequest(payload, action);
        break;
      case 'push':
        await handlePush(payload);
        break;
      case 'issues':
        await handleIssue(payload, action);
        break;
      case 'issue_comment':
        await handleIssueComment(payload, action);
        break;
      case 'check_run':
        await handleCheckRun(payload, action);
        break;
      case 'pull_request_review':
        await handlePullRequestReview(payload, action);
        break;
      case 'installation':
        console.log(`[webhook] Installation event: ${action}`);
        break;
      default:
        console.log(`[webhook] Ignoring unsupported event: ${event}`);
        break;
    }
    console.log(`[webhook] Handled ${event}.${action} for ${repo} — OK`);
  } catch (err) {
    console.error(`[webhook] Error handling ${event}.${action}:`, err);
    // Return 200 anyway so GitHub doesn't retry
  }

  return c.json({ ok: true });
});

// ── Event Handlers ──────────────────────────────────────────────────────────

async function handlePullRequest(payload: Record<string, unknown>, action?: string) {
  const pr = payload.pull_request as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const repoFullName = repo.full_name as string;
  const installationId = (payload.installation as Record<string, unknown>)?.id as number | undefined;

  console.log(`[webhook:pr] ${action} on ${repoFullName}`);
  const project = await findProjectByRepo(repoFullName);
  if (!project) {
    console.log(`[webhook:pr] No project found for ${repoFullName} — skipping`);
    return;
  }
  console.log(`[webhook:pr] Matched project ${project.id}`);

  if (action === 'opened' || action === 'reopened') {
    const title = pr.title as string;
    const body = (pr.body as string ?? '').slice(0, 2000);
    const author = (pr.user as Record<string, unknown>).login as string;
    const number = pr.number as number;

    await db.insert(memoryEntries).values({
      projectId: project.id,
      category: 'note',
      title: `PR #${number} opened: ${title}`,
      body: `Author: ${author}\n\n${body}`,
      relatedFiles: [],
      metadata: { source: 'github', event: 'pr_opened', pr_number: number, author },
    });

    // Brain-powered PR comment: plain-English explanation with risk and guidance
    if (installationId) {
      try {
        const [owner, repoName] = repoFullName.split('/');
        const prFiles = await getPRFiles(installationId, owner, repoName, number);
        const filenames = prFiles.map((f) => f.filename);

        const analysis = await analyzePR(project.id, filenames);

        // Always comment if there's any signal, or if it's medium/high risk
        const hasSignals = analysis.fileRisks.length > 0 || analysis.warnings.length > 0 || analysis.ciStatus.length > 0;
        if (hasSignals || analysis.overallRisk !== 'low') {
          const commentBody = formatPRComment(
            analysis,
            title,
            body,
            prFiles.map(f => ({ filename: f.filename, additions: f.additions, deletions: f.deletions })),
          );
          await postPRComment(installationId, owner, repoName, number, commentBody);
          console.log(`[webhook] Posted brain explanation on PR #${number} (risk: ${analysis.overallRisk})`);
        }
      } catch (err) {
        console.error(`[webhook] PR analysis failed for #${number}:`, (err as Error).message);
      }
    }
  } else if (action === 'closed') {
    const merged = pr.merged as boolean;
    const number = pr.number as number;
    const title = pr.title as string;

    await db.insert(memoryEntries).values({
      projectId: project.id,
      category: 'note',
      title: `PR #${number} ${merged ? 'merged' : 'closed'}: ${title}`,
      body: merged
        ? `Merge SHA: ${pr.merge_commit_sha as string}. ${(pr.changed_files as number) ?? 0} files changed.`
        : `PR was closed without merging.`,
      relatedFiles: [],
      metadata: { source: 'github', event: merged ? 'pr_merged' : 'pr_closed', pr_number: number },
    });
  }
}

async function handlePush(payload: Record<string, unknown>) {
  const repo = payload.repository as Record<string, unknown>;
  const repoFullName = repo.full_name as string;
  console.log(`[webhook:push] Looking up project for ${repoFullName}`);
  const project = await findProjectByRepo(repoFullName);
  if (!project) {
    console.log(`[webhook:push] No project found for ${repoFullName} — skipping`);
    return;
  }
  console.log(`[webhook:push] Matched project ${project.id}`);

  const commits = (payload.commits as Array<Record<string, unknown>>) ?? [];

  const fileEventRows: Array<{
    projectId: string;
    filePath: string;
    eventType: 'created' | 'modified' | 'deleted';
    timestamp: Date;
    sourceTool: string;
  }> = [];

  for (const commit of commits) {
    const ts = new Date(commit.timestamp as string);
    for (const f of (commit.added as string[]) ?? []) {
      fileEventRows.push({ projectId: project.id, filePath: f, eventType: 'created', timestamp: ts, sourceTool: 'github' });
    }
    for (const f of (commit.modified as string[]) ?? []) {
      fileEventRows.push({ projectId: project.id, filePath: f, eventType: 'modified', timestamp: ts, sourceTool: 'github' });
    }
    for (const f of (commit.removed as string[]) ?? []) {
      fileEventRows.push({ projectId: project.id, filePath: f, eventType: 'deleted', timestamp: ts, sourceTool: 'github' });
    }
  }

  console.log(`[webhook:push] Collected ${fileEventRows.length} file events from ${commits.length} commits`);

  if (fileEventRows.length > 0) {
    // Deduplicate — keep latest per (filePath, eventType)
    const seen = new Map<string, (typeof fileEventRows)[0]>();
    for (const row of fileEventRows) {
      const key = `${row.filePath}:${row.eventType}`;
      const existing = seen.get(key);
      if (!existing || row.timestamp > existing.timestamp) seen.set(key, row);
    }
    const deduped = [...seen.values()];
    console.log(`[webhook:push] Inserting ${deduped.length} deduplicated file events`);
    await db.insert(fileEvents).values(deduped.map((r) => ({
      ...r,
      sessionId: null,
      diff: null,
      fileSize: null,
    })));
    console.log(`[webhook:push] ✅ Inserted ${deduped.length} file events for ${repoFullName}`);
  } else {
    console.log(`[webhook:push] No file events to insert`);
  }
}

async function handleIssue(payload: Record<string, unknown>, action?: string) {
  const issue = payload.issue as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const repoFullName = repo.full_name as string;
  const installationId = (payload.installation as Record<string, unknown>)?.id as number | undefined;
  const project = await findProjectByRepo(repoFullName);
  if (!project) return;

  const number = issue.number as number;
  const title = issue.title as string;
  const author = (issue.user as Record<string, unknown>).login as string;
  const labels = ((issue.labels as Array<Record<string, unknown>>) ?? []).map((l) => l.name as string);

  if (action === 'opened') {
    const body = (issue.body as string ?? '').slice(0, 2000);
    await db.insert(memoryEntries).values({
      projectId: project.id,
      category: 'note',
      title: `Issue #${number} opened: ${title}`,
      body: `Author: ${author}${labels.length > 0 ? `\nLabels: ${labels.join(', ')}` : ''}\n\n${body}`,
      relatedFiles: [],
      metadata: { source: 'github', event: 'issue_opened', issue_number: number, author, labels },
    });

    // Brain-powered issue comment: plain-English explanation with context and guidance
    if (installationId) {
      try {
        const [owner, repoName] = repoFullName.split('/');
        const issueComment = await buildIssueContextComment(project.id, title, body);
        if (issueComment) {
          await postIssueComment(installationId, owner, repoName, number, issueComment);
          console.log(`[webhook] Posted brain explanation on issue #${number}`);
        }
      } catch (err) {
        console.error(`[webhook] Issue context failed for #${number}:`, (err as Error).message);
      }
    }
  } else if (action === 'closed') {
    const stateReason = issue.state_reason as string ?? 'completed';
    await db.insert(memoryEntries).values({
      projectId: project.id,
      category: 'note',
      title: `Issue #${number} closed: ${title}`,
      body: `Closed as ${stateReason}.`,
      relatedFiles: [],
      metadata: { source: 'github', event: 'issue_closed', issue_number: number, state_reason: stateReason },
    });
  }
}

async function handleIssueComment(payload: Record<string, unknown>, action?: string) {
  if (action !== 'created') return;

  const issue = payload.issue as Record<string, unknown>;
  const comment = payload.comment as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const repoFullName = repo.full_name as string;
  const project = await findProjectByRepo(repoFullName);
  if (!project) return;

  const issueNumber = issue.number as number;
  const issueTitle = issue.title as string;
  const author = (comment.user as Record<string, unknown>).login as string;
  const body = (comment.body as string ?? '').slice(0, 1500);
  const isPR = Boolean(issue.pull_request);

  await db.insert(memoryEntries).values({
    projectId: project.id,
    category: 'note',
    title: `Comment on ${isPR ? 'PR' : 'issue'} #${issueNumber}: ${issueTitle}`,
    body: `@${author}: ${body}`,
    relatedFiles: [],
    metadata: {
      source: 'github',
      event: 'issue_comment',
      issue_number: issueNumber,
      is_pr: isPR,
      author,
      comment_id: comment.id,
    },
  });
}

async function handleCheckRun(payload: Record<string, unknown>, action?: string) {
  if (action !== 'completed') return;

  const checkRun = payload.check_run as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const repoFullName = repo.full_name as string;
  const project = await findProjectByRepo(repoFullName);
  if (!project) return;

  const name = checkRun.name as string;
  const conclusion = checkRun.conclusion as string;
  const isFailed = conclusion === 'failure' || conclusion === 'timed_out';

  await db.insert(memoryEntries).values({
    projectId: project.id,
    category: isFailed ? 'bug_fix' : 'note',
    title: `CI ${isFailed ? 'failed' : 'passed'}: ${name}`,
    body: `Check "${name}" completed with conclusion: ${conclusion}.`,
    relatedFiles: [],
    metadata: { source: 'github', event: isFailed ? 'ci_failed' : 'ci_passed', check_name: name, conclusion },
  });
}

async function handlePullRequestReview(payload: Record<string, unknown>, action?: string) {
  if (action !== 'submitted') return;

  const review = payload.review as Record<string, unknown>;
  const pr = payload.pull_request as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const repoFullName = repo.full_name as string;
  const project = await findProjectByRepo(repoFullName);
  if (!project) return;

  const state = review.state as string; // approved, changes_requested, commented
  const reviewer = (review.user as Record<string, unknown>).login as string;
  const prNumber = pr.number as number;
  const prTitle = pr.title as string;
  const body = (review.body as string ?? '').slice(0, 1500);

  await db.insert(memoryEntries).values({
    projectId: project.id,
    category: state === 'changes_requested' ? 'constraint' : 'note',
    title: `Review on PR #${prNumber}: ${state} by @${reviewer}`,
    body: `${prTitle}\n\n${body || '(no comment)'}`,
    relatedFiles: [],
    metadata: { source: 'github', event: 'review_submitted', pr_number: prNumber, reviewer, state },
  });
}

// ── Issue Context Comment Builder ────────────────────────────────────────────

async function buildIssueContextComment(
  projectId: string,
  issueTitle: string,
  issueBody: string,
): Promise<string | null> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const memories = await db
    .select({
      category: memoryEntries.category,
      title: memoryEntries.title,
      createdAt: memoryEntries.createdAt,
      relatedFiles: memoryEntries.relatedFiles,
    })
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.projectId, projectId),
        eq(memoryEntries.archived, 'false'),
        gte(memoryEntries.createdAt, ninetyDaysAgo),
      ),
    );

  const searchText = `${issueTitle} ${issueBody}`.toLowerCase();
  const words = searchText.split(/\s+/).filter((w) => w.length > 3);

  const relatedMemories = memories.filter((m) => {
    const memText = m.title.toLowerCase();
    return words.some((w) => memText.includes(w));
  });

  if (relatedMemories.length === 0) return null;

  const bugFixes = relatedMemories.filter((m) => m.category === 'bug_fix').slice(0, 3);
  const decisions = relatedMemories.filter((m) => m.category === 'decision').slice(0, 2);
  const rules = relatedMemories.filter((m) => m.category === 'project_rule').slice(0, 2);

  if (bugFixes.length === 0 && decisions.length === 0 && rules.length === 0) return null;

  // Collect related files from matched memories
  const allRelatedFiles = new Set<string>();
  for (const m of relatedMemories) {
    const files = m.relatedFiles as string[] | null;
    if (files) {
      for (const f of files) allRelatedFiles.add(f);
    }
  }

  const fmtDate = (d: Date | null) => d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

  return formatIssueComment(
    issueTitle,
    issueBody,
    bugFixes.map(b => ({ title: b.title, date: fmtDate(b.createdAt) })),
    decisions.map(d => ({ title: d.title, date: fmtDate(d.createdAt) })),
    rules.map(r => ({ title: r.title })),
    [...allRelatedFiles].slice(0, 5),
  );
}

// ── Repo → Project Lookup ───────────────────────────────────────────────────

async function findProjectByRepo(repoFullName: string): Promise<{ id: string } | null> {
  const repoName = repoFullName.split('/').pop() ?? repoFullName;
  const orgName = repoFullName.split('/')[0] ?? '';
  const allProjects = await db.select({ id: projects.id, name: projects.name, rootPath: projects.rootPath, orgId: projects.orgId }).from(projects);

  // 1. Exact name match
  const exact = allProjects.find(
    (p) => p.name.toLowerCase() === repoName.toLowerCase(),
  );
  if (exact) return { id: exact.id };

  // 2. rootPath contains repo name
  const pathMatch = allProjects.find(
    (p) => p.rootPath.toLowerCase().includes(repoName.toLowerCase()),
  );
  if (pathMatch) return { id: pathMatch.id };

  // 3. Match by GitHub org — find org with matching github login, use their first project
  const orgs = await db.select({ id: organizations.id, email: organizations.email }).from(organizations);
  const matchedOrg = orgs.find(
    (o) => o.email?.toLowerCase() === `github:${orgName.toLowerCase()}`,
  );
  if (matchedOrg) {
    const orgProject = allProjects.find((p) => p.orgId === matchedOrg.id);
    if (orgProject) {
      console.log(`[webhook] Matched repo ${repoFullName} to project ${orgProject.id} via org ${matchedOrg.id}`);
      return { id: orgProject.id };
    }
  }

  // 4. Fallback — if there's only one project total, use it (single-user setup)
  if (allProjects.length === 1) {
    console.log(`[webhook] Single project fallback: ${allProjects[0].id} for repo ${repoFullName}`);
    return { id: allProjects[0].id };
  }

  console.log(`[webhook] No project match for repo ${repoFullName}`);
  return null;
}

// ── Write-Back API (Create PR / Create Issue) ───────────────────────────────

const writeBackRouter = new Hono<AppEnv>();
writeBackRouter.use('*', requireApiKey);

writeBackRouter.post('/create-pr', async (c) => {
  const orgId = c.get('orgId');
  const body = await c.req.json() as {
    project_id: string;
    repo: string; // "owner/repo"
    head: string; // branch name
    base?: string; // default: main
    title?: string;
    body_text?: string;
    installation_id: number;
    auto_fill?: boolean; // fill from brain context
  };

  // Verify project belongs to org
  const [proj] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, body.project_id), eq(projects.orgId, orgId)));
  if (!proj) return c.json({ error: 'project_not_found' }, 404);

  let prTitle = body.title ?? '';
  let prBody = body.body_text ?? '';

  // Auto-fill from brain context
  if (body.auto_fill !== false) {
    try {
      const ctx = await generateContextBlock(body.project_id, { maxTokens: 1500 });
      const contextSummary = ctx.content.slice(0, 3000);

      if (!prTitle) {
        // Extract a title from recent activity
        const recentLines = contextSummary.split('\n').filter((l) => l.startsWith('['));
        prTitle = recentLines[0]?.replace(/^\[.\]\s*/, '') ?? 'Update from Project Brain';
      }

      prBody = [
        prBody,
        '',
        '---',
        '',
        '<details><summary>Project Brain Context</summary>',
        '',
        '```',
        contextSummary,
        '```',
        '',
        '</details>',
        '',
        '_Auto-filled by [Project Brain](https://awx-shredder.fly.dev)_',
      ].join('\n');
    } catch {
      // Non-fatal — proceed with whatever title/body was provided
    }
  }

  if (!prTitle) return c.json({ error: 'title_required', message: 'Provide a title or enable auto_fill' }, 400);

  const result = await githubApi(body.installation_id, `/repos/${body.repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: prTitle,
      body: prBody,
      head: body.head,
      base: body.base ?? 'main',
    }),
  }) as { number: number; html_url: string; title: string };

  // Save as memory
  await db.insert(memoryEntries).values({
    projectId: body.project_id,
    category: 'note',
    title: `Created PR #${result.number}: ${result.title}`,
    body: `PR created via Project Brain write-back.\nURL: ${result.html_url}`,
    relatedFiles: [],
    metadata: { source: 'github', event: 'pr_created', pr_number: result.number, url: result.html_url },
  });

  return c.json({
    pr_number: result.number,
    url: result.html_url,
    title: result.title,
    auto_filled: body.auto_fill !== false,
  }, 201);
});

writeBackRouter.post('/create-issue', async (c) => {
  const orgId = c.get('orgId');
  const body = await c.req.json() as {
    project_id: string;
    repo: string; // "owner/repo"
    installation_id: number;
    title?: string;
    body_text?: string;
    labels?: string[];
    auto_fill?: boolean;
  };

  // Verify project belongs to org
  const [proj] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, body.project_id), eq(projects.orgId, orgId)));
  if (!proj) return c.json({ error: 'project_not_found' }, 404);

  let issueTitle = body.title ?? '';
  let issueBody = body.body_text ?? '';

  // Auto-fill from brain context
  if (body.auto_fill !== false) {
    try {
      const ctx = await generateContextBlock(body.project_id, { maxTokens: 1500 });
      const contextSummary = ctx.content.slice(0, 3000);

      if (!issueTitle) {
        issueTitle = 'Issue from Project Brain';
      }

      issueBody = [
        issueBody,
        '',
        '---',
        '',
        '<details><summary>Project Brain Context</summary>',
        '',
        '```',
        contextSummary,
        '```',
        '',
        '</details>',
        '',
        '_Auto-filled by [Project Brain](https://awx-shredder.fly.dev)_',
      ].join('\n');
    } catch {
      // Non-fatal
    }
  }

  if (!issueTitle) return c.json({ error: 'title_required' }, 400);

  const result = await githubApi(body.installation_id, `/repos/${body.repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: issueTitle,
      body: issueBody,
      labels: body.labels ?? [],
    }),
  }) as { number: number; html_url: string; title: string };

  // Save as memory
  await db.insert(memoryEntries).values({
    projectId: body.project_id,
    category: 'note',
    title: `Created issue #${result.number}: ${result.title}`,
    body: `Issue created via Project Brain write-back.\nURL: ${result.html_url}`,
    relatedFiles: [],
    metadata: { source: 'github', event: 'issue_created', issue_number: result.number, url: result.html_url },
  });

  return c.json({
    issue_number: result.number,
    url: result.html_url,
    title: result.title,
    auto_filled: body.auto_fill !== false,
  }, 201);
});

export { writeBackRouter };
