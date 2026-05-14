# Lovable Prompt — Project Brain Dashboard (Copy everything below this line)

Build a complete dashboard app called "Project Brain" — an operational intelligence dashboard for AI-powered development workflows. It connects to an existing backend API at `https://awx-shredder.fly.dev`.

## Tech Stack
- React + TypeScript + Vite (Lovable default)
- Tailwind CSS with custom theme
- shadcn/ui components (Card, Button, Badge, Tabs, Collapsible, Avatar, Tooltip)
- recharts for charts
- lucide-react for icons
- framer-motion for animations

## Design System

Light-mode glassmorphic design. Set these CSS variables in globals.css:
```
--background: 210 33% 98% (soft blue-white)
--foreground: 222 38% 12% (dark navy)
--primary: 190 82% 37% (cyan/teal — this is the signature accent color)
--muted: 215 28% 94%
--border: 218 24% 88%
--destructive: 8 76% 52%
--accent: 258 70% 60% (purple — secondary accent)
```

Fonts: Inter (body), JetBrains Mono (code/numbers). Background: subtle grid overlay (42px) on a multi-layered gradient (white with faint radial teal and indigo blobs). All cards use glassmorphism: `bg-white/78 backdrop-blur-xl shadow-[0_18px_60px_rgba(15,23,42,0.08)] border border-white/60 rounded-2xl`. Primary buttons are cyan. Status colors: green=#10b981, amber=#f59e0b, red=#ef4444.

## Authentication Flow

The backend uses GitHub OAuth. Implement these 3 auth pages:

### 1. Login Page (`/login`)
- Centered card with a BrainCircuit icon (lucide), title "Project Brain", subtitle "Operational Intelligence for AI Workflows"
- Single button: "Sign in with GitHub" — links to: `https://awx-shredder.fly.dev/auth/github?redirect=${window.location.origin}/auth/callback`
- If localStorage already has `awx_session_token`, redirect to `/`

### 2. Auth Callback Page (`/auth/callback`)
- On mount, read the URL hash fragment: `window.location.hash` contains `#token=xxx`
- Extract the token, store it in `localStorage.setItem("awx_session_token", token)`
- Also set a cookie: `document.cookie = "awx_session_token=" + token + "; path=/; max-age=604800; SameSite=Lax"`
- Redirect to `/`
- Show a spinner with "Signing you in..." while processing

### 3. AuthGuard wrapper component
- Wrap all protected pages
- On mount, get token from `localStorage.getItem("awx_session_token")`
- Verify it: `GET https://awx-shredder.fly.dev/auth/verify` with header `Authorization: Bearer ${token}`
- If valid: response is `{org_id, org_name, github_login}` — store this as user context
- If invalid or missing: redirect to `/login`
- Export a `getStoredToken()` helper function

## API Helper

Create a `lib/api.ts` with a helper that calls the backend:
```typescript
const BACKEND = "https://awx-shredder.fly.dev";

export async function apiFetch(path: string, options?: RequestInit) {
  const token = localStorage.getItem("awx_session_token");
  const res = await fetch(`${BACKEND}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}
```

## Resolving the Project ID

Many API calls need a project ID. After auth verification returns `{org_id}`, call:
`GET /sync/projects` (with Bearer token) — returns `{projects: [{id, name, root_path, created_at}]}`. Use the first project's `id`. Store it in React context alongside the user info. If no projects exist, show a "Connect GitHub to get started" prompt.

Create an API key resolver: call `POST /auth/rotate-key` with Bearer token — returns `{api_key}`. Store this as `apiKey` in context. This API key is needed for `/sync/*` endpoints (pass as `Authorization: Bearer ${apiKey}` for sync routes).

IMPORTANT: Auth routes (`/auth/*`) use the session JWT token. Sync routes (`/sync/*`) use the API key. Create the helper to handle both.

## Pages and Layout

### App Layout
- Dark navy sidebar (240px) on the left with:
  - Logo: BrainCircuit icon + "Project Brain" text
  - Nav items with icons: Dashboard (LayoutDashboard), Setup (Settings), Replay (Play), Intelligence (Lightbulb)
  - Bottom: user avatar showing `github_login` from auth, logout button
- Main content area with the background gradient described above
- Mobile: sidebar collapses to hamburger menu

### Page 1: Dashboard (`/`) — Main cockpit view

This is the main page. It has 4 sections stacked vertically:

#### Section A: Cockpit Health Ring
Fetch: `GET /sync/health/${projectId}` with API key Bearer token.
Response shape: `{ status: "green"|"amber"|"red", summary: string, signals: { scope: {status, detail}, focus: {status, detail}, repetition: {status, detail}, duration: {status, detail}, trajectory: {status, detail} } }`

Display:
- Large animated ring (200px) with conic-gradient. Green ring = score 86, amber = 62, red = 28. The ring should animate on load using framer-motion.
- Inside the ring: large score number + status label ("Relax" for green, "Pay attention" for amber, "Stop and check" for red)
- Below the ring: summary text
- Expandable signal breakdown: 5 rows, each showing signal name, colored status dot, and detail text
- Color the ring border: green=#10b981, amber=#f59e0b, red=#ef4444

#### Section B: Metric Cards (5 cards in a responsive grid)
Fetch: `GET /sync/brain/events/${projectId}` (returns `{events}`), `GET /sync/file-events/${projectId}?limit=500` (returns `{events}`), `GET /sync/memory/${projectId}` (returns `{memories}`)

Compute 5 metrics from the raw data:

1. **Retry Rate** (icon: RotateCcw) — Count events where `type === "command_run"` and `metadata.exitCode !== 0`, divide by total command_run events. Show as percentage. Pain text: "Commands that failed and needed retry"
2. **PR Activity** (icon: GitPullRequest) — Count memories where `category` starts with `pr_`. Show as count. Pain: "Pull requests tracked by the brain"
3. **CI Health** (icon: AlertTriangle) — Count memories where `category === "ci_failed"` vs `ci_passed`. Show fail rate as percentage. Pain: "CI pipeline failure rate"
4. **File Churn** (icon: Files) — Count unique files from file events. Show as count. Pain: "Files modified across sessions"
5. **Workflow Events** (icon: Activity) — Total workflow events count. Pain: "Total development events captured"

Each MetricCard is a glassmorphism card showing:
- Icon + title at top
- Large value number (use JetBrains Mono font)
- Pain description text in muted color
- Mini area chart (recharts AreaChart, 80px tall, cyan fill, no axes) showing last 7 data points (group events by day)
- Clickable — when clicked, highlights with cyan border

#### Section C: Replay Timeline
Fetch: `GET /sync/brain/replays/${projectId}` — returns `{replays: [{id, task_id, started_at, ended_at, final_outcome, replay}]}`

Each replay has a `replay` JSON field containing: `{task, events: [{time, type, title, detail, evidence}], outcome, filesChanged, filesRead}`

Display the most recent replay as a vertical timeline:
- Header: task name, outcome badge (success=green, failure=red, partial=amber)
- Stats row: files read count, files changed count
- Vertical line with event nodes. Each event shows:
  - Colored icon based on type (start=Play, file=FileText, command=Terminal, failure=XCircle in red, loop=RotateCcw in amber, ci=CheckCircle, review=Eye, diagnosis=Search, lesson=Lightbulb in cyan, success=CheckCircle in green)
  - Time, title, expandable detail text
  - Evidence tags (small cyan badges)

If no replays exist, show an empty state: "No replays yet. Start a session via Claude Code to see your workflow here."

#### Section D: Intelligence Panels (3-column grid)
Fetch: `GET /sync/brain/lessons/${projectId}` (returns `{lessons: [{area, lesson, trigger, evidenceRefs, requiredTests, confidence}]}`), reuse file events and memories from Section B.

**Column 1: Operational Lessons**
- Each lesson card shows: area badge (cyan), lesson text (bold), trigger as evidence, confidence as progress bar
- If no lessons from API, show recent memories as fallback (category as area, title as lesson, body snippet as evidence)

**Column 2: Repository Hotspots**
- Build from file events: group by filePath, count occurrences, sort by count descending, take top 6
- Each hotspot shows: truncated file path, signal count badge, time ago, event types as tags

**Column 3: Activity Patterns**
- Build from workflow events: count failed commands, test failures, broad file changes (>5 files), PR events, bug fixes, CI events, hot files (3+ edits), new files created, active lessons
- Each pattern shows: name, count number, severity badge (High if count>=5, Medium if >=2, Low otherwise), area tag

### Page 2: Setup (`/setup`)

A 4-step setup wizard in a single page:

**Step 1: Connect GitHub**
- Show GitHub App install link: `https://github.com/apps/probrain-ai/installations/new`
- Green checkmark if projects exist (fetched from `/sync/projects`)

**Step 2: Your Projects**
- List projects from `/sync/projects` showing name and root_path
- Green checkmark if at least 1 project exists

**Step 3: API Key**
- Button "Generate API Key" — calls `POST /auth/rotate-key` with session token
- Shows the returned key in a monospace box with a Copy button
- Warning: "Save this key — you won't see it again"

**Step 4: Connect Your AI Tool**
- Two tabs: "Claude Code" and "Codex"
- Claude Code tab shows JSON config to paste into `.claude/settings.json`:
```json
{
  "mcpServers": {
    "awx-sync": {
      "command": "npx",
      "args": ["-y", "awx-sync-mcp@latest"],
      "env": {
        "AWX_API_KEY": "<their-api-key>",
        "AWX_API_URL": "https://awx-shredder.fly.dev",
        "AWX_PROJECT_ID": "<their-project-id>"
      }
    }
  }
}
```
- Codex tab shows TOML config for `.codex/config.toml`:
```toml
[mcp_servers.awx-sync]
command = "npx"
args = ["-y", "awx-sync-mcp@latest"]
env = { AWX_API_KEY = "<key>", AWX_API_URL = "https://awx-shredder.fly.dev", AWX_PROJECT_ID = "<id>" }
```
- Replace `<their-api-key>` and `<their-project-id>` with actual values from context
- Copy button on each config block

### Page 3: Replay (`/replay`)
- Full-page version of the replay timeline from the dashboard
- Left sidebar showing list of all replays (task name + outcome badge + date)
- Clicking a replay shows it in the main area with the full timeline
- If no replays, show empty state with instructions

### Page 4: Intelligence (`/intelligence`)
- Full-page version of the 3-column intelligence panels
- Add search/filter bar at top: filter lessons by area, filter hotspots by file extension, filter patterns by severity
- Each card should be expandable for more detail

## Key UX Details

1. All data fetches should show skeleton loaders (pulsing gray rectangles matching the card shape) while loading
2. Error states should show a subtle red banner with the error message, not crash the page
3. Empty states should always show a helpful message explaining what needs to happen to populate data
4. The cockpit ring should pulse gently when status is "amber" or "red"
5. Add a "Refresh" button (RefreshCw icon) in the header that refetches all data
6. Use `react-router-dom` for routing
7. All timestamps should show as relative time ("2m ago", "3h ago", "5d ago")
8. Numbers should animate up from 0 when they first appear (use framer-motion)

## Environment Variable
Create a `.env` file with: `VITE_API_URL=https://awx-shredder.fly.dev`
Use `import.meta.env.VITE_API_URL` throughout instead of hardcoding.

## CORS Note
The backend already allows CORS from any origin on `/auth/*` and `/sync/*` routes, so direct browser fetch calls will work.

Build the complete app with all 4 pages, all components, full auth flow, real API integration, and the glassmorphic design system. Every component should be functional and connected to the real backend — no mock data, no placeholder components, no TODO comments. This is a production app.
