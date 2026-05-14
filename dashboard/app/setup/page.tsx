"use client";

import { useEffect, useState } from "react";
import { BrainCircuit, Check, Copy, Github, Key } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AuthGuard } from "@/components/auth-guard";

interface SetupProject {
  id: string;
  name: string;
  repo: string | null;
}

interface SetupData {
  org: { id: string; name: string };
  github_login: string | null;
  github_connected: boolean;
  projects: SetupProject[];
  mcp_config: Record<string, unknown> | null;
  steps: { github: boolean; project: boolean; mcp: boolean };
}

export default function SetupPage() {
  const [data, setData] = useState<SetupData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyGenerating, setKeyGenerating] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [copiedCodex, setCopiedCodex] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [activeTab, setActiveTab] = useState<"claude" | "codex">("claude");

  useEffect(() => {
    fetch("/api/setup-data")
      .then((res) => {
        if (res.status === 401) {
          window.location.href = "/auth/github?redirect=/app/setup";
          return null;
        }
        return res.json();
      })
      .then((d) => {
        if (d) setData(d);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  async function revealKey() {
    setKeyGenerating(true);
    try {
      const res = await fetch("/api/reveal-key", { method: "POST" });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setApiKey(d.api_key);
    } catch (err) {
      setError((err as Error).message);
    }
    setKeyGenerating(false);
  }

  function getMcpConfigString() {
    if (!data?.mcp_config) return "";
    const config = JSON.parse(JSON.stringify(data.mcp_config));
    if (apiKey && config.mcpServers?.["project-brain"]?.env) {
      config.mcpServers["project-brain"].env.AWX_API_KEY = apiKey;
    }
    return JSON.stringify(config, null, 2);
  }

  function getCodexConfigString() {
    const projectId = data?.projects?.[0]?.id ?? "YOUR_PROJECT_ID";
    const key = apiKey ?? "YOUR_API_KEY";
    return `[mcp_servers.project-brain]
type = "stdio"
command = "npx"
args = ["-y", "awx-sync-mcp"]

[mcp_servers.project-brain.env]
AWX_API_KEY = "${key}"
AWX_PROJECT_ID = "${projectId}"`;
  }

  function copyConfig() {
    navigator.clipboard.writeText(getMcpConfigString());
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  }

  function copyCodexConfig() {
    navigator.clipboard.writeText(getCodexConfigString());
    setCopiedCodex(true);
    setTimeout(() => setCopiedCodex(false), 2000);
  }

  function copyKey() {
    if (!apiKey) return;
    navigator.clipboard.writeText(apiKey);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <p className="text-muted-foreground">Loading setup...</p>
      </main>
    );
  }

  if (error && !data) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <Card className="max-w-md p-6 text-center">
          <p className="text-sm text-destructive">Failed to load setup: {error}</p>
          <Button variant="secondary" className="mt-4" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </Card>
      </main>
    );
  }

  if (!data) return null;

  const githubDone = data.steps.github;
  const projectsDone = data.projects.length > 0;
  const keyDone = !!apiKey;

  return (
    <AuthGuard>
    <main className="relative min-h-screen overflow-hidden px-4 py-8 text-foreground sm:px-6 lg:px-8">
      <div className="grid-fade pointer-events-none absolute inset-x-0 top-0 h-[520px]" />
      <div className="relative mx-auto max-w-[680px]">
        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-400/10">
            <BrainCircuit className="h-5 w-5 text-cyan-700" />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-950">Project Brain Setup</div>
            <div className="text-xs text-muted-foreground">
              Welcome, {data.github_login || data.org.name}
            </div>
          </div>
        </div>

        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
          You&apos;re almost live
        </h1>
        <p className="mb-8 max-w-lg text-sm leading-6 text-muted-foreground">
          Follow these steps to connect your AI tools to your project brain.
          Once connected, the brain fills itself automatically.
        </p>

        {/* Steps */}
        <div className="flex flex-col gap-4">
          {/* Step 1: GitHub */}
          <Step number={1} done={githubDone} active={!githubDone} title={githubDone ? "GitHub connected" : "Connect GitHub"}>
            {githubDone ? (
              <p className="text-xs leading-5 text-muted-foreground">
                Webhooks are flowing. PRs, commits, reviews, and CI events are being captured automatically.
              </p>
            ) : (
              <div>
                <p className="mb-3 text-xs leading-5 text-muted-foreground">
                  Install the GitHub App to start filling your brain automatically.
                </p>
                <Button size="sm" asChild>
                  <a href="https://github.com/apps/probrain-ai/installations/new">
                    <Github className="h-3.5 w-3.5" />
                    Install GitHub App
                  </a>
                </Button>
              </div>
            )}
          </Step>

          {/* Step 2: Projects */}
          <Step
            number={2}
            done={projectsDone}
            active={githubDone && !projectsDone}
            title={projectsDone ? `${data.projects.length} project${data.projects.length > 1 ? "s" : ""} created` : "Create projects"}
          >
            {projectsDone ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Each repo has a project brain. Webhooks route automatically.</p>
                {data.projects.map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-md border border-border bg-white/60 px-3 py-2 text-xs">
                    <span className="font-medium text-slate-800">{p.name}</span>
                    <span className="text-muted-foreground">{p.repo ?? "no repo linked"}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">
                Projects are auto-created when you install the GitHub App on your repos.
              </p>
            )}
          </Step>

          {/* Step 3: API Key */}
          <Step number={3} done={keyDone} active={projectsDone && !keyDone} title={keyDone ? "API key generated" : "Get your API key"}>
            {keyDone ? (
              <div>
                <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50/70 px-3 py-2.5 font-mono text-xs text-emerald-800">
                  <span className="flex-1 break-all">{apiKey}</span>
                  <button onClick={copyKey} className="flex-shrink-0 rounded p-1 hover:bg-emerald-100" title="Copy key">
                    {copiedKey ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <p className="mt-2 text-xs font-medium text-amber-600">
                  Save this now — it cannot be retrieved again.
                </p>
              </div>
            ) : (
              <div>
                <p className="mb-3 text-xs leading-5 text-muted-foreground">
                  You need an API key to connect Claude Code, Cursor, or Codex to your brain.
                </p>
                <Button size="sm" onClick={revealKey} disabled={keyGenerating}>
                  <Key className="h-3.5 w-3.5" />
                  {keyGenerating ? "Generating..." : "Generate API key"}
                </Button>
              </div>
            )}
          </Step>

          {/* Step 4: MCP Config */}
          <Step number={4} done={false} active={keyDone} title="Connect your AI tool">
            <p className="mb-3 text-xs leading-5 text-muted-foreground">
              Pick your tool and copy the config.
              {!keyDone && " Generate your API key first (step 3)."}
            </p>
            <div className="mb-3 flex gap-1 rounded-md border border-border bg-muted/30 p-0.5">
              <button
                onClick={() => setActiveTab("claude")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === "claude"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-muted-foreground hover:text-slate-700"
                }`}
              >
                Claude Code
              </button>
              <button
                onClick={() => setActiveTab("codex")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === "codex"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-muted-foreground hover:text-slate-700"
                }`}
              >
                Codex
              </button>
            </div>

            {activeTab === "claude" && data.mcp_config && (
              <div>
                <p className="mb-2 text-xs text-muted-foreground">
                  Add to{" "}
                  <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-cyan-700">.claude/settings.json</code>
                </p>
                <div className="relative">
                  <pre className="overflow-x-auto rounded-md border border-border bg-slate-950 p-4 font-mono text-[11px] leading-5 text-slate-200">
                    {getMcpConfigString()}
                  </pre>
                  <button
                    onClick={copyConfig}
                    className="absolute right-2 top-2 flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-slate-700"
                  >
                    {copiedConfig ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-400" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" /> Copy
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {activeTab === "codex" && (
              <div>
                <p className="mb-2 text-xs text-muted-foreground">
                  Add to{" "}
                  <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-cyan-700">.codex/config.toml</code>{" "}
                  in your project root
                </p>
                <div className="relative">
                  <pre className="overflow-x-auto rounded-md border border-border bg-slate-950 p-4 font-mono text-[11px] leading-5 text-slate-200">
                    {getCodexConfigString()}
                  </pre>
                  <button
                    onClick={copyCodexConfig}
                    className="absolute right-2 top-2 flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-slate-700"
                  >
                    {copiedCodex ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-400" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" /> Copy
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </Step>
        </div>

        {/* Footer */}
        <div className="mt-8 text-center">
          <Button variant="secondary" asChild>
            <a href="/">Go to dashboard</a>
          </Button>
        </div>
      </div>
    </main>
    </AuthGuard>
  );
}

function Step({
  number,
  done,
  active,
  title,
  children,
}: {
  number: number;
  done: boolean;
  active: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={`transition-all ${done ? "border-emerald-200/60" : active ? "border-cyan-300/40" : "opacity-60"}`}>
      <CardContent className="p-4">
        <div className="mb-2 flex items-center gap-3">
          <div
            className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
              done
                ? "bg-emerald-100 text-emerald-700"
                : active
                  ? "bg-cyan-100 text-cyan-700"
                  : "bg-muted/60 text-muted-foreground"
            }`}
          >
            {done ? <Check className="h-3.5 w-3.5" /> : number}
          </div>
          <span className="text-sm font-semibold text-slate-900">{title}</span>
        </div>
        <div className="ml-10">{children}</div>
      </CardContent>
    </Card>
  );
}
