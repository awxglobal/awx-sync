import { NextResponse } from "next/server";
import { readConfig, resolveProjectId } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = readConfig();
  if (!config) {
    return NextResponse.json({ lessons: [], hotspots: [], failurePatterns: [] });
  }

  const projectId = await resolveProjectId(config);
  if (!projectId) {
    return NextResponse.json({ lessons: [], hotspots: [], failurePatterns: [], source: "no_project" });
  }

  try {
    // Fetch lessons from backend
    const lessonsRes = await fetch(
      `${config.apiUrl}/sync/brain/lessons/${projectId}`,
      { headers: { Authorization: `Bearer ${config.apiKey}` }, cache: "no-store" }
    ).catch(() => null);

    let lessons: Array<{ area: string; lesson: string; trigger: string; evidenceRefs: string[]; requiredTests: string[]; confidence: number }> = [];
    if (lessonsRes?.ok) {
      const ld = await lessonsRes.json();
      lessons = ld.lessons ?? [];
    }

    // Fetch file events to build hotspots
    const fileRes = await fetch(
      `${config.apiUrl}/sync/file-events/${projectId}?limit=500`,
      { headers: { Authorization: `Bearer ${config.apiKey}` }, cache: "no-store" }
    ).catch(() => null);

    let fileEvents: Array<{ filePath: string; eventType: string; timestamp: string }> = [];
    if (fileRes?.ok) {
      const fd = await fileRes.json();
      fileEvents = fd.events ?? fd.file_events ?? [];
    }

    // Fetch memories for context
    const memRes = await fetch(
      `${config.apiUrl}/sync/memory/${projectId}`,
      { headers: { Authorization: `Bearer ${config.apiKey}` }, cache: "no-store" }
    ).catch(() => null);

    let memories: Array<{ category: string; title: string; body: string; relatedFiles: string[]; createdAt: string }> = [];
    if (memRes?.ok) {
      const md = await memRes.json();
      memories = md.memories ?? [];
    }

    // Fetch workflow events for failure patterns
    const eventsRes = await fetch(
      `${config.apiUrl}/sync/brain/events/${projectId}`,
      { headers: { Authorization: `Bearer ${config.apiKey}` }, cache: "no-store" }
    ).catch(() => null);

    let workflowEvents: Array<{ type: string; summary: string; metadata?: Record<string, unknown>; relatedFiles?: string[]; related_files?: string[]; timestamp: string }> = [];
    if (eventsRes?.ok) {
      const ed = await eventsRes.json();
      workflowEvents = ed.events ?? [];
    }

    // Build hotspots from file event frequency
    const fileCounts = new Map<string, { count: number; lastSeen: string; types: Set<string> }>();
    for (const fe of fileEvents) {
      const existing = fileCounts.get(fe.filePath);
      if (existing) {
        existing.count++;
        existing.types.add(fe.eventType);
        if (fe.timestamp > existing.lastSeen) existing.lastSeen = fe.timestamp;
      } else {
        fileCounts.set(fe.filePath, { count: 1, lastSeen: fe.timestamp, types: new Set([fe.eventType]) });
      }
    }

    const hotspots = Array.from(fileCounts.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([file, data]) => ({
        file,
        signals: data.count,
        lastSeen: timeAgo(data.lastSeen),
        reason: Array.from(data.types).join(", "),
      }));

    // Build failure patterns from workflow events
    const patternMap = new Map<string, { count: number; area: string }>();
    for (const evt of workflowEvents) {
      if (evt.type === "command_run" && Number(evt.metadata?.exitCode ?? 0) !== 0) {
        const key = "Failed commands";
        const existing = patternMap.get(key);
        patternMap.set(key, { count: (existing?.count ?? 0) + 1, area: "commands" });
      }
      if (evt.type === "test_failed") {
        const key = "Test failures";
        const existing = patternMap.get(key);
        patternMap.set(key, { count: (existing?.count ?? 0) + 1, area: "tests" });
      }
      if (evt.type === "file_changed") {
        const files = evt.relatedFiles ?? evt.related_files ?? [];
        if (files.length > 5) {
          const key = "Broad file changes";
          const existing = patternMap.get(key);
          patternMap.set(key, { count: (existing?.count ?? 0) + 1, area: "exploration" });
        }
      }
    }

    // Add memory-based patterns
    const prCount = memories.filter(m => m.category.startsWith("pr_")).length;
    if (prCount > 0) patternMap.set("PR events captured", { count: prCount, area: "github" });

    const bugCount = memories.filter(m => m.category === "bug_fix").length;
    if (bugCount > 0) patternMap.set("Bug fixes documented", { count: bugCount, area: "quality" });

    const reviewCount = memories.filter(m => m.category === "review_submitted").length;
    if (reviewCount > 0) patternMap.set("Code reviews tracked", { count: reviewCount, area: "reviews" });

    const ciCount = memories.filter(m => m.category === "ci_failed" || m.category === "ci_passed").length;
    if (ciCount > 0) patternMap.set("CI events captured", { count: ciCount, area: "ci" });

    // Add file-event patterns
    const hotFiles = Array.from(fileCounts.entries()).filter(([, d]) => d.count >= 3);
    if (hotFiles.length > 0) patternMap.set("Hot files (3+ edits)", { count: hotFiles.length, area: "file churn" });

    const createdFiles = fileEvents.filter(f => f.eventType === "created").length;
    if (createdFiles > 0) patternMap.set("New files created", { count: createdFiles, area: "growth" });

    // Add lesson-based patterns
    if (lessons.length > 0) patternMap.set("Operational lessons active", { count: lessons.length, area: "learning" });

    const failurePatterns = Array.from(patternMap.entries()).map(([name, data]) => ({
      name,
      count: data.count,
      severity: data.count >= 5 ? "High" : data.count >= 2 ? "Medium" : "Low",
      area: data.area,
    }));

    // Format lessons for frontend
    const formattedLessons = lessons.map(l => ({
      area: l.area,
      rule: l.lesson,
      evidence: l.trigger + (l.evidenceRefs?.length ? ` (${l.evidenceRefs.length} evidence refs)` : ""),
      required: l.requiredTests?.[0] ?? "No specific test required",
    }));

    // If no lessons from backend, build from memories
    if (formattedLessons.length === 0) {
      for (const mem of memories.slice(0, 5)) {
        formattedLessons.push({
          area: mem.category.replace(/_/g, " "),
          rule: mem.title,
          evidence: mem.body.slice(0, 120),
          required: mem.relatedFiles?.[0] ?? "See project brain",
        });
      }
    }

    return NextResponse.json({
      lessons: formattedLessons,
      hotspots,
      failurePatterns,
      source: "live",
      counts: {
        totalLessons: formattedLessons.length,
        totalHotspots: hotspots.length,
        totalPatterns: failurePatterns.length,
        totalFileEvents: fileEvents.length,
        totalMemories: memories.length,
        totalWorkflowEvents: workflowEvents.length,
      },
    });
  } catch (error) {
    return NextResponse.json({
      lessons: [],
      hotspots: [],
      failurePatterns: [],
      source: "error",
      message: (error as Error).message,
    });
  }
}

function timeAgo(timestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
