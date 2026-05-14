/**
 * PR & Issue Analysis Engine.
 *
 * Produces plain-English explanations of PRs and issues,
 * backed by evidence from the project brain.
 */

import { and, eq, gte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { fileEvents, memoryEntries } from '../db/schema.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface FileRisk {
  filename: string;
  riskLevel: 'high' | 'medium' | 'low';
  bugCount: number;
  recentBugs: Array<{ title: string; date: string }>;
  relatedDecisions: Array<{ title: string; date: string }>;
  relatedSchemaChanges: Array<{ title: string; date: string }>;
  guidance: string;
}

export interface PRAnalysis {
  overallRisk: 'high' | 'medium' | 'low';
  fileRisks: FileRisk[];
  warnings: string[];
  totalBugsInChangedFiles: number;
  totalDecisionsAffected: number;
  hasHighRiskFiles: boolean;
  ciStatus: Array<{ name: string; passed: boolean; date: string }>;
  relatedIssues: Array<{ title: string; number: number; date: string }>;
}

// ── Analysis ────────────────────────────────────────────────────────────────

export async function analyzePR(
  projectId: string,
  changedFiles: string[],
): Promise<PRAnalysis> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const memories = await db
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
    .where(
      and(
        eq(memoryEntries.projectId, projectId),
        eq(memoryEntries.archived, 'false'),
        gte(memoryEntries.createdAt, ninetyDaysAgo),
      ),
    );

  const recentFileEvents = await db
    .select({
      filePath: fileEvents.filePath,
      eventType: fileEvents.eventType,
      timestamp: fileEvents.timestamp,
    })
    .from(fileEvents)
    .where(
      and(
        eq(fileEvents.projectId, projectId),
        gte(fileEvents.timestamp, thirtyDaysAgo),
      ),
    );

  const fileRisks: FileRisk[] = [];

  for (const file of changedFiles) {
    const fileBugs = memories.filter(
      (m) =>
        m.category === 'bug_fix' &&
        (matchesFile(m.relatedFiles as string[] | null, file) ||
          m.title.toLowerCase().includes(fileBaseName(file)) ||
          m.body.toLowerCase().includes(fileBaseName(file))),
    );

    const recentBugs = fileBugs
      .filter((b) => b.createdAt && b.createdAt >= thirtyDaysAgo)
      .map((b) => ({ title: b.title, date: formatDate(b.createdAt!) }));

    const relatedDecisions = memories
      .filter(
        (m) =>
          m.category === 'decision' &&
          (matchesFile(m.relatedFiles as string[] | null, file) ||
            m.title.toLowerCase().includes(fileBaseName(file)) ||
            m.body.toLowerCase().includes(fileBaseName(file))),
      )
      .map((m) => ({ title: m.title, date: formatDate(m.createdAt!) }));

    const relatedSchemaChanges = memories
      .filter(
        (m) =>
          m.category === 'schema_change' &&
          (matchesFile(m.relatedFiles as string[] | null, file) ||
            m.title.toLowerCase().includes(fileBaseName(file)) ||
            m.body.toLowerCase().includes(fileBaseName(file))),
      )
      .map((m) => ({ title: m.title, date: formatDate(m.createdAt!) }));

    const fileModCount = recentFileEvents.filter(
      (e) => e.filePath === file || e.filePath.endsWith(`/${file}`) || file.endsWith(`/${e.filePath}`),
    ).length;

    const bugCount = recentBugs.length;
    let riskLevel: 'high' | 'medium' | 'low' = 'low';
    if (bugCount >= 3 || (bugCount >= 2 && fileModCount >= 5)) {
      riskLevel = 'high';
    } else if (bugCount >= 1 || fileModCount >= 8) {
      riskLevel = 'medium';
    }

    const guidance = buildFileGuidance(file, riskLevel, recentBugs, relatedDecisions, relatedSchemaChanges);

    if (bugCount > 0 || relatedDecisions.length > 0 || relatedSchemaChanges.length > 0) {
      fileRisks.push({
        filename: file,
        riskLevel,
        bugCount,
        recentBugs,
        relatedDecisions,
        relatedSchemaChanges,
        guidance,
      });
    }
  }

  const riskOrder = { high: 0, medium: 1, low: 2 };
  fileRisks.sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel]);

  const warnings: string[] = [];
  const highRiskFiles = fileRisks.filter((f) => f.riskLevel === 'high');
  const totalBugs = fileRisks.reduce((sum, f) => sum + f.bugCount, 0);
  const totalDecisions = fileRisks.reduce((sum, f) => sum + f.relatedDecisions.length, 0);

  if (highRiskFiles.length > 0) {
    warnings.push(`${highRiskFiles.length} high-risk file${highRiskFiles.length > 1 ? 's' : ''} detected — these files have had multiple recent bugs`);
  }
  if (totalDecisions > 0) {
    warnings.push(`${totalDecisions} architecture decision${totalDecisions > 1 ? 's' : ''} may be affected by this change`);
  }

  let overallRisk: 'high' | 'medium' | 'low' = 'low';
  if (highRiskFiles.length > 0 || totalBugs >= 5) {
    overallRisk = 'high';
  } else if (fileRisks.some((f) => f.riskLevel === 'medium') || totalBugs >= 2) {
    overallRisk = 'medium';
  }

  // Gather CI status from recent memories
  const ciStatus = memories
    .filter((m) => {
      const meta = m.metadata as Record<string, unknown> | null;
      return meta?.event === 'ci_failed' || meta?.event === 'ci_passed';
    })
    .slice(0, 5)
    .map((m) => {
      const meta = m.metadata as Record<string, unknown>;
      return {
        name: (meta.check_name as string) ?? m.title,
        passed: meta.event === 'ci_passed',
        date: formatDate(m.createdAt!),
      };
    });

  // Gather related issues from recent memories
  const relatedIssues = memories
    .filter((m) => {
      const meta = m.metadata as Record<string, unknown> | null;
      return (meta?.event === 'issue_opened' || meta?.event === 'issue_closed') && meta?.issue_number;
    })
    .slice(0, 5)
    .map((m) => {
      const meta = m.metadata as Record<string, unknown>;
      return {
        title: m.title.replace(/^Issue #\d+ (opened|closed): /, ''),
        number: meta.issue_number as number,
        date: formatDate(m.createdAt!),
      };
    });

  return {
    overallRisk,
    fileRisks,
    warnings,
    totalBugsInChangedFiles: totalBugs,
    totalDecisionsAffected: totalDecisions,
    hasHighRiskFiles: highRiskFiles.length > 0,
    ciStatus,
    relatedIssues,
  };
}

// ── Format PR Comment ───────────────────────────────────────────────────────

export function formatPRComment(
  analysis: PRAnalysis,
  prTitle: string,
  prBody: string = '',
  changedFiles: Array<{ filename: string; additions: number; deletions: number }> = [],
  dashboardUrl?: string,
): string {
  const riskEmoji = { high: '🔴', medium: '🟡', low: '🟢' };

  let comment = `## 🧠 Project Brain explains this PR\n\n`;

  // 1. What changed — plain English summary
  comment += `**Plain English:**\n`;
  comment += summarizePR(prTitle, prBody, changedFiles);
  comment += `\n\n`;

  // 2. Why it matters
  comment += `**Why it matters:**\n`;
  comment += explainWhyItMatters(analysis, changedFiles);
  comment += `\n\n`;

  // 3. Risk level
  const riskLabel = { high: 'High', medium: 'Medium', low: 'Low' };
  comment += `**Risk:** ${riskEmoji[analysis.overallRisk]} ${riskLabel[analysis.overallRisk]}\n`;
  comment += riskExplanation(analysis);
  comment += `\n\n`;

  // 4. Evidence
  const evidenceLines = buildEvidence(analysis, changedFiles);
  if (evidenceLines.length > 0) {
    comment += `**Evidence:**\n`;
    for (const line of evidenceLines) {
      comment += `- ${line}\n`;
    }
    comment += `\n`;
  }

  // 5. What to do next
  const nextSteps = buildNextSteps(analysis, changedFiles);
  if (nextSteps.length > 0) {
    comment += `**What to do next:**\n`;
    for (const step of nextSteps) {
      comment += `- ${step}\n`;
    }
    comment += `\n`;
  }

  // 6. AI guidance
  const aiGuidance = buildAIGuidance(analysis, changedFiles);
  if (aiGuidance) {
    comment += `**Suggested AI guidance:**\n`;
    comment += `> ${aiGuidance}\n\n`;
  }

  // 7. Dashboard link
  if (dashboardUrl) {
    comment += `**Full replay:** [View in Project Brain](${dashboardUrl})\n\n`;
  }

  comment += `---\n`;
  comment += `*[Project Brain](https://awx-shredder.fly.dev) — making GitHub understandable for AI-native builders*`;

  return comment;
}

// ── Format Issue Comment ────────────────────────────────────────────────────

export function formatIssueComment(
  issueTitle: string,
  issueBody: string,
  relatedBugs: Array<{ title: string; date: string }>,
  relatedDecisions: Array<{ title: string; date: string }>,
  activeRules: Array<{ title: string }>,
  relatedFiles: string[],
  dashboardUrl?: string,
): string {
  let comment = `## 🧠 Project Brain explains this issue\n\n`;

  // Plain English
  comment += `**Plain English:**\n`;
  comment += `This issue is about: ${issueTitle.toLowerCase().replace(/^(fix|bug|feat|feature|chore|refactor|docs)[\s:]+/i, '')}\n\n`;

  // Why it matters
  const signals: string[] = [];
  if (relatedBugs.length > 0) signals.push(`${relatedBugs.length} related bug${relatedBugs.length > 1 ? 's' : ''} fixed recently`);
  if (relatedDecisions.length > 0) signals.push(`${relatedDecisions.length} architecture decision${relatedDecisions.length > 1 ? 's' : ''} related to this area`);
  if (activeRules.length > 0) signals.push(`${activeRules.length} active rule${activeRules.length > 1 ? 's' : ''} apply here`);

  if (signals.length > 0) {
    comment += `**Why it matters:**\n`;
    comment += `The brain found context: ${signals.join(', ')}.\n\n`;
  }

  // Evidence
  const hasEvidence = relatedBugs.length > 0 || relatedDecisions.length > 0 || activeRules.length > 0;
  if (hasEvidence) {
    comment += `**Evidence:**\n`;

    if (relatedBugs.length > 0) {
      for (const b of relatedBugs.slice(0, 3)) {
        comment += `- Bug fixed: ${b.title} *(${b.date})*\n`;
      }
    }
    if (relatedDecisions.length > 0) {
      for (const d of relatedDecisions.slice(0, 2)) {
        comment += `- Decision: ${d.title} *(${d.date})*\n`;
      }
    }
    if (activeRules.length > 0) {
      for (const r of activeRules.slice(0, 2)) {
        comment += `- Rule: ${r.title}\n`;
      }
    }
    comment += `\n`;
  }

  // What to do next
  const nextSteps: string[] = [];
  if (relatedBugs.length > 0) {
    nextSteps.push('Check if this is a regression of a previously fixed bug');
  }
  if (relatedDecisions.length > 0) {
    nextSteps.push('Review the related architecture decisions before starting work');
  }
  if (activeRules.length > 0) {
    nextSteps.push('Follow the active rules listed above when implementing a fix');
  }
  if (relatedFiles.length > 0) {
    nextSteps.push(`Start by looking at: ${relatedFiles.slice(0, 3).map(f => `\`${f}\``).join(', ')}`);
  }

  if (nextSteps.length > 0) {
    comment += `**What to do next:**\n`;
    for (const step of nextSteps) {
      comment += `- ${step}\n`;
    }
    comment += `\n`;
  }

  // AI guidance
  const aiParts: string[] = [];
  if (relatedBugs.length > 0) {
    aiParts.push(`check if this is related to: ${relatedBugs[0].title}`);
  }
  if (relatedFiles.length > 0) {
    aiParts.push(`start by reading ${relatedFiles.slice(0, 2).join(' and ')}`);
  }
  if (activeRules.length > 0) {
    aiParts.push(`follow this rule: ${activeRules[0].title}`);
  }

  if (aiParts.length > 0) {
    comment += `**Suggested AI guidance:**\n`;
    comment += `> ${aiParts.join('. ')}.\n\n`;
  }

  if (dashboardUrl) {
    comment += `**Full context:** [View in Project Brain](${dashboardUrl})\n\n`;
  }

  comment += `---\n`;
  comment += `*[Project Brain](https://awx-shredder.fly.dev) — making GitHub understandable for AI-native builders*`;

  return comment;
}

// ── PR Comment Helpers ──────────────────────────────────────────────────────

function summarizePR(
  title: string,
  body: string,
  changedFiles: Array<{ filename: string; additions: number; deletions: number }>,
): string {
  // Clean up conventional commit prefix
  const cleanTitle = title.replace(/^(fix|feat|feature|chore|refactor|docs|style|test|ci|build|perf)[\s(:]+/i, '').replace(/\):\s*/, ': ');

  // Group files by directory for a human-readable summary
  const dirs = new Set(changedFiles.map(f => f.filename.split('/').slice(0, -1).join('/')).filter(Boolean));
  const totalAdded = changedFiles.reduce((s, f) => s + f.additions, 0);
  const totalRemoved = changedFiles.reduce((s, f) => s + f.deletions, 0);

  let summary = cleanTitle || 'Changes across multiple files';

  if (changedFiles.length > 0) {
    summary += ` (${changedFiles.length} file${changedFiles.length > 1 ? 's' : ''} changed`;
    if (totalAdded > 0 || totalRemoved > 0) {
      summary += `, +${totalAdded}/-${totalRemoved} lines`;
    }
    summary += `)`;
  }

  if (dirs.size > 0 && dirs.size <= 3) {
    summary += `.\nAreas touched: ${[...dirs].join(', ')}`;
  }

  return summary;
}

function explainWhyItMatters(
  analysis: PRAnalysis,
  changedFiles: Array<{ filename: string }>,
): string {
  const reasons: string[] = [];

  if (analysis.hasHighRiskFiles) {
    const highFiles = analysis.fileRisks.filter(f => f.riskLevel === 'high');
    reasons.push(`${highFiles.map(f => `\`${shortPath(f.filename)}\``).join(', ')} ${highFiles.length > 1 ? 'have' : 'has'} had multiple bugs recently`);
  }

  if (analysis.totalDecisionsAffected > 0) {
    reasons.push(`this touches files where architecture decisions were made`);
  }

  const schemaFiles = analysis.fileRisks.filter(f => f.relatedSchemaChanges.length > 0);
  if (schemaFiles.length > 0) {
    reasons.push(`schema changes have been made in related files`);
  }

  // Detect sensitive areas by filename
  const sensitivePatterns = [
    { pattern: /auth|login|session|token/i, label: 'authentication' },
    { pattern: /payment|billing|stripe|charge/i, label: 'payments' },
    { pattern: /migration|schema|model/i, label: 'database structure' },
    { pattern: /config|env|secret/i, label: 'configuration' },
    { pattern: /deploy|ci|workflow|pipeline/i, label: 'deployment' },
  ];

  for (const { pattern, label } of sensitivePatterns) {
    if (changedFiles.some(f => pattern.test(f.filename))) {
      reasons.push(`this touches ${label}, which is a sensitive area`);
      break;
    }
  }

  if (reasons.length === 0) {
    return 'No special risk signals found. Standard review applies.';
  }

  return reasons.map(r => r.charAt(0).toUpperCase() + r.slice(1)).join('. ') + '.';
}

function riskExplanation(analysis: PRAnalysis): string {
  if (analysis.overallRisk === 'low') {
    return '\nNo recent bugs or risky patterns found in the changed files.';
  }

  const reasons: string[] = [];
  if (analysis.hasHighRiskFiles) {
    reasons.push(`files with repeated recent bugs`);
  }
  if (analysis.totalBugsInChangedFiles >= 2) {
    reasons.push(`${analysis.totalBugsInChangedFiles} bugs fixed in these files recently`);
  }
  if (analysis.totalDecisionsAffected > 0) {
    reasons.push(`architecture decisions affected`);
  }

  return `\n${reasons.join(', ')}.`;
}

function buildEvidence(
  analysis: PRAnalysis,
  changedFiles: Array<{ filename: string; additions: number; deletions: number }>,
): string[] {
  const lines: string[] = [];

  // Changed files
  if (changedFiles.length > 0) {
    const fileList = changedFiles.slice(0, 5).map(f => `\`${shortPath(f.filename)}\``).join(', ');
    const more = changedFiles.length > 5 ? ` and ${changedFiles.length - 5} more` : '';
    lines.push(`Changed files: ${fileList}${more}`);
  }

  // CI status
  const failedCI = analysis.ciStatus.filter(c => !c.passed);
  const passedCI = analysis.ciStatus.filter(c => c.passed);
  if (failedCI.length > 0) {
    lines.push(`CI failed: ${failedCI.map(c => c.name).join(', ')}`);
  } else if (passedCI.length > 0) {
    lines.push(`CI passed: ${passedCI.map(c => c.name).join(', ')}`);
  }

  // Previous bugs
  for (const file of analysis.fileRisks.filter(f => f.bugCount > 0).slice(0, 3)) {
    for (const bug of file.recentBugs.slice(0, 2)) {
      lines.push(`Previous bug in \`${shortPath(file.filename)}\`: ${bug.title} *(${bug.date})*`);
    }
  }

  // Decisions
  for (const file of analysis.fileRisks.filter(f => f.relatedDecisions.length > 0).slice(0, 2)) {
    for (const d of file.relatedDecisions.slice(0, 1)) {
      lines.push(`Decision: ${d.title} *(${d.date})*`);
    }
  }

  // Related issues
  for (const issue of analysis.relatedIssues.slice(0, 2)) {
    lines.push(`Related issue: ${issue.title} *(${issue.date})*`);
  }

  return lines;
}

function buildNextSteps(
  analysis: PRAnalysis,
  changedFiles: Array<{ filename: string }>,
): string[] {
  const steps: string[] = [];

  // CI-based guidance
  const failedCI = analysis.ciStatus.filter(c => !c.passed);
  if (failedCI.length > 0) {
    steps.push(`Do not merge until CI is green — ${failedCI.map(c => c.name).join(', ')} failed`);
  }

  // High-risk file guidance
  for (const file of analysis.fileRisks.filter(f => f.riskLevel === 'high').slice(0, 2)) {
    steps.push(`Review \`${shortPath(file.filename)}\` carefully — ${file.bugCount} recent bugs`);
  }

  // Decision-affected files
  for (const file of analysis.fileRisks.filter(f => f.relatedDecisions.length > 0).slice(0, 2)) {
    steps.push(`Check if changes to \`${shortPath(file.filename)}\` respect the existing architecture decisions`);
  }

  // Schema change guidance
  for (const file of analysis.fileRisks.filter(f => f.relatedSchemaChanges.length > 0).slice(0, 1)) {
    steps.push(`Verify schema compatibility for \`${shortPath(file.filename)}\``);
  }

  // Test suggestion based on file types
  const testableFiles = changedFiles.filter(f =>
    /\.(ts|js|tsx|jsx|py|go|rs|rb)$/.test(f.filename) &&
    !f.filename.includes('.test.') &&
    !f.filename.includes('.spec.') &&
    !f.filename.includes('__test')
  );
  if (testableFiles.length > 0) {
    const testFile = testableFiles[0].filename.replace(/\.(ts|js|tsx|jsx)$/, '.test.$1');
    steps.push(`Run tests for the changed files (e.g. \`${shortPath(testFile)}\`)`);
  }

  // Default for low risk
  if (steps.length === 0) {
    steps.push('Standard review — no special actions needed');
  }

  return steps;
}

function buildAIGuidance(
  analysis: PRAnalysis,
  changedFiles: Array<{ filename: string }>,
): string | null {
  const parts: string[] = [];

  // What to review
  const highRiskFiles = analysis.fileRisks.filter(f => f.riskLevel === 'high' || f.riskLevel === 'medium');
  if (highRiskFiles.length > 0) {
    parts.push(`Review ${highRiskFiles.slice(0, 3).map(f => shortPath(f.filename)).join(', ')} for regressions`);
  }

  // Decision constraints
  const decisionsFiles = analysis.fileRisks.filter(f => f.relatedDecisions.length > 0);
  if (decisionsFiles.length > 0) {
    const firstDecision = decisionsFiles[0].relatedDecisions[0];
    if (firstDecision) {
      parts.push(`follow the existing decision: ${firstDecision.title}`);
    }
  }

  // Test guidance
  const failedCI = analysis.ciStatus.filter(c => !c.passed);
  if (failedCI.length > 0) {
    parts.push(`fix the failing CI check: ${failedCI[0].name}`);
  } else if (changedFiles.length > 0) {
    parts.push(`run the related tests before pushing`);
  }

  // Bug avoidance
  const buggyFiles = analysis.fileRisks.filter(f => f.bugCount > 0);
  if (buggyFiles.length > 0 && buggyFiles[0].recentBugs[0]) {
    parts.push(`watch out for: ${buggyFiles[0].recentBugs[0].title}`);
  }

  if (parts.length === 0) return null;

  return parts.join('. ') + '.';
}

function buildFileGuidance(
  filename: string,
  riskLevel: 'high' | 'medium' | 'low',
  recentBugs: Array<{ title: string }>,
  decisions: Array<{ title: string }>,
  schemaChanges: Array<{ title: string }>,
): string {
  const parts: string[] = [];

  if (riskLevel === 'high') {
    parts.push(`High-risk file with ${recentBugs.length} recent bugs`);
  }

  if (recentBugs.length > 0) {
    parts.push(`Last bug: ${recentBugs[0].title}`);
  }

  if (decisions.length > 0) {
    parts.push(`Decision: ${decisions[0].title}`);
  }

  if (schemaChanges.length > 0) {
    parts.push(`Schema change: ${schemaChanges[0].title}`);
  }

  return parts.join('. ') || `Review ${shortPath(filename)}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function matchesFile(relatedFiles: string[] | null, target: string): boolean {
  if (!relatedFiles || relatedFiles.length === 0) return false;
  const targetBase = fileBaseName(target);
  return relatedFiles.some(
    (f) => f === target || f.endsWith(`/${target}`) || target.endsWith(`/${f}`) || fileBaseName(f) === targetBase,
  );
}

function fileBaseName(path: string): string {
  return path.split('/').pop()?.toLowerCase() ?? path.toLowerCase();
}

function shortPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 2) return path;
  return parts.slice(-2).join('/');
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
