import { NextResponse } from "next/server";
import { readConfig, resolveProjectId } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = readConfig();
  if (!config) {
    return NextResponse.json({
      org: { id: "unknown", name: "Unknown" },
      github_login: null,
      github_connected: false,
      projects: [],
      mcp_config: null,
      steps: { github: false, project: false, mcp: false },
    });
  }

  try {
    // Verify user identity
    const verifyRes = await fetch(`${config.apiUrl}/auth/verify`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      cache: "no-store",
    }).catch(() => null);

    let orgId = "local";
    let orgName = "Local Setup";
    let githubLogin: string | null = null;

    if (verifyRes?.ok) {
      const v = await verifyRes.json();
      orgId = v.org_id ?? "local";
      orgName = v.org_name ?? "Local Setup";
      githubLogin = v.github_login ?? null;
    }

    // Fetch projects
    const projectId = await resolveProjectId(config);
    const projectsRes = await fetch(`${config.apiUrl}/sync/projects`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      cache: "no-store",
    }).catch(() => null);

    let projects: Array<{ id: string; name: string; repo: string | null }> = [];
    if (projectsRes?.ok) {
      const pd = await projectsRes.json();
      projects = (pd.projects ?? []).map((p: { id: string; name: string; rootPath?: string }) => ({
        id: p.id,
        name: p.name,
        repo: p.rootPath ?? null,
      }));
    }

    const hasProjects = projects.length > 0;
    const firstProject = projects[0];

    // Build MCP config for display
    const mcpConfig = {
      mcpServers: {
        "project-brain": {
          command: "npx",
          args: ["-y", "awx-sync-mcp"],
          env: {
            AWX_API_KEY: "YOUR_API_KEY",
            AWX_PROJECT_ID: firstProject?.id ?? "YOUR_PROJECT_ID",
          },
        },
      },
    };

    return NextResponse.json({
      org: { id: orgId, name: orgName },
      github_login: githubLogin,
      github_connected: githubLogin !== null,
      projects,
      mcp_config: mcpConfig,
      steps: {
        github: githubLogin !== null,
        project: hasProjects,
        mcp: false,
      },
    });
  } catch (error) {
    return NextResponse.json({
      org: { id: "local", name: "Local Setup" },
      github_login: null,
      github_connected: false,
      projects: [],
      mcp_config: null,
      steps: { github: false, project: false, mcp: false },
      error: (error as Error).message,
    });
  }
}
