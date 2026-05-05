#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { program } from 'commander';
import { ApiClient } from './api-client.js';
import { fetchAndCopy, fetchAndPrint, fetchAndWriteFile } from './context.js';
import { configExists, loadConfig, writeConfig } from './config.js';
import { startWatcher } from './watcher.js';

program
  .name('awx-sync')
  .description('Project state layer for Claude Code')
  .version('0.1.0');

// ── init ─────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Set up awx-sync for this project')
  .option('--api-url <url>', 'API server URL', 'http://localhost:3000')
  .option('--api-key <key>', 'Your awxs_ API key')
  .option('--name <name>', 'Project name')
  .option('--tool <tool>', 'Tool (claude-code | cursor | codex)', 'claude-code')
  .action(async (opts) => {
    if (configExists()) {
      console.log('  ✓ .awxsync.json already exists. Delete it first to re-init.');
      process.exit(0);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> =>
      new Promise((res) => rl.question(q, res));

    const apiUrl = opts.apiUrl || (await ask('  API URL [http://localhost:3000]: ')) || 'http://localhost:3000';
    const apiKey = opts.apiKey || (await ask('  API key (awxs_...): '));
    const name = opts.name || (await ask('  Project name: '));
    rl.close();

    if (!apiKey.startsWith('awxs_')) {
      console.error('  ✗ API key must start with awxs_');
      process.exit(1);
    }

    const client = new ApiClient({ apiUrl, apiKey });

    let proj: { id: string; name: string };
    try {
      proj = await client.createProject(name, process.cwd());
    } catch (err) {
      console.error('  ✗ Failed to create project:', (err as Error).message);
      process.exit(1);
    }

    writeConfig({
      projectId: proj.id,
      apiKey,
      apiUrl,
      tool: opts.tool as 'claude-code',
    });

    console.log(`\n  ✓ Project created: ${proj.name} (${proj.id})`);
    console.log('  ✓ .awxsync.json written\n');
    console.log('  Next steps:');
    console.log('    awx-sync watch    — start watching files');
    console.log('    awx-sync inject   — get context block for Claude Code\n');
  });

// ── watch ─────────────────────────────────────────────────────────────────────

program
  .command('watch')
  .description('Watch files and stream activity to the backend')
  .option('--no-session', 'Skip creating a session (just watch files)')
  .action(async (opts) => {
    const config = loadConfig();
    const client = new ApiClient({ apiUrl: config.apiUrl, apiKey: config.apiKey });

    let sessionId: string | undefined;

    if (opts.session !== false) {
      try {
        const { session, context_block } = await client.startSession(
          config.projectId,
          config.tool,
        );
        sessionId = session.id;
        console.log(`\n  ▸ Session started: ${sessionId}`);

        if (context_block) {
          console.log('\n' + context_block + '\n');
          console.log('  (context block above — copy it into your Claude Code session)\n');
        }
      } catch (err) {
        console.warn('  ⚠ Could not start session:', (err as Error).message);
      }
    }

    const stop = startWatcher({
      projectRoot: process.cwd(),
      projectId: config.projectId,
      sessionId,
      client,
      ignore: config.ignore,
    });

    console.log('  ▸ Watching for file changes. Press Ctrl+C to stop.\n');

    process.on('SIGINT', async () => {
      stop();
      if (sessionId) {
        try {
          await client.endSession(sessionId);
          console.log('\n  ✓ Session ended.');
        } catch {
          // Non-fatal
        }
      }
      process.exit(0);
    });
  });

// ── inject ────────────────────────────────────────────────────────────────────

program
  .command('inject')
  .description('Fetch the current project state block and copy to clipboard')
  .option('--print', 'Print to stdout instead of copying to clipboard')
  .option('--max-tokens <n>', 'Token budget for context block', '2000')
  .action(async (opts) => {
    const config = loadConfig();
    const client = new ApiClient({ apiUrl: config.apiUrl, apiKey: config.apiKey });
    const maxTokens = parseInt(opts.maxTokens, 10);

    try {
      if (opts.print) {
        await fetchAndPrint(client, config.projectId, maxTokens);
      } else {
        await fetchAndCopy(client, config.projectId, maxTokens);
      }
    } catch (err) {
      console.error('  ✗ Failed to fetch context:', (err as Error).message);
      process.exit(1);
    }
  });

// ── auto ──────────────────────────────────────────────────────────────────────

program
  .command('auto')
  .description('Watch files AND keep .awx-context.md updated (for CLAUDE.md @include)')
  .option('--interval <seconds>', 'How often to refresh the context file', '30')
  .action(async (opts) => {
    const config = loadConfig();
    const client = new ApiClient({ apiUrl: config.apiUrl, apiKey: config.apiKey });
    const interval = parseInt(opts.interval, 10) * 1000;

    let sessionId: string | undefined;
    try {
      const { session } = await client.startSession(config.projectId, config.tool);
      sessionId = session.id;
      console.log(`  ▸ Session started: ${sessionId}`);
    } catch (err) {
      console.warn('  ⚠ Could not start session:', (err as Error).message);
    }

    const stop = startWatcher({
      projectRoot: process.cwd(),
      projectId: config.projectId,
      sessionId,
      client,
      ignore: config.ignore,
    });

    async function refreshContext() {
      try {
        await fetchAndWriteFile(client, config.projectId, process.cwd());
        process.stdout.write('  ▸ .awx-context.md updated\n');
      } catch (err) {
        console.warn('  ⚠ Context refresh failed:', (err as Error).message);
      }
    }

    // Write immediately, then on interval
    await refreshContext();
    const timer = setInterval(refreshContext, interval);

    console.log(`  ▸ Watching files and refreshing context every ${opts.interval}s`);
    console.log('  ▸ Add "@.awx-context.md" to your CLAUDE.md to auto-inject\n');
    console.log('  Press Ctrl+C to stop.\n');

    process.on('SIGINT', async () => {
      stop();
      clearInterval(timer);
      if (sessionId) {
        try {
          await client.endSession(sessionId);
          console.log('\n  ✓ Session ended.');
        } catch {
          // Non-fatal
        }
      }
      process.exit(0);
    });
  });

// ── memory ────────────────────────────────────────────────────────────────────

const memoryCmd = program
  .command('memory')
  .description('Manage project memory entries');

memoryCmd
  .command('add')
  .description('Record a memory entry (bug fixed, schema changed, decision made, etc.)')
  .option('--category <cat>', 'bug_fix | schema_change | project_rule | decision | constraint | note')
  .option('--title <title>', 'One-line summary')
  .option('--body <body>', 'Full description')
  .option('--files <files>', 'Comma-separated related file paths')
  .action(async (opts) => {
    const config = loadConfig();
    const client = new ApiClient({ apiUrl: config.apiUrl, apiKey: config.apiKey });

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> =>
      new Promise((res) => rl.question(q, res));

    const categories = ['bug_fix', 'schema_change', 'project_rule', 'decision', 'constraint', 'note'];

    const category =
      opts.category ||
      (await ask(`  Category (${categories.join(' | ')}): `));

    if (!categories.includes(category)) {
      console.error(`  ✗ Invalid category: ${category}`);
      rl.close();
      process.exit(1);
    }

    const title = opts.title || (await ask('  Title (one-line): '));
    const body = opts.body || (await ask('  Body (details): '));
    const filesInput = opts.files || (await ask('  Related files (comma-separated, or blank): '));
    rl.close();

    const relatedFiles = filesInput
      ? filesInput.split(',').map((f: string) => f.trim()).filter(Boolean)
      : [];

    try {
      await client.createMemory({
        project_id: config.projectId,
        category: category as 'bug_fix',
        title,
        body,
        related_files: relatedFiles,
      });
      console.log(`\n  ✓ Memory recorded: "${title}"`);
    } catch (err) {
      console.error('  ✗ Failed to record memory:', (err as Error).message);
      process.exit(1);
    }
  });

memoryCmd
  .command('list')
  .description('List memory entries for this project')
  .option('--category <cat>', 'Filter by category')
  .action(async (opts) => {
    const config = loadConfig();
    const client = new ApiClient({ apiUrl: config.apiUrl, apiKey: config.apiKey });

    const url = `${config.apiUrl}/sync/memory/${config.projectId}${opts.category ? `?category=${opts.category}` : ''}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });

    if (!res.ok) {
      console.error('  ✗ Failed to list memories:', res.status);
      process.exit(1);
    }

    const data = (await res.json()) as { entries: Array<{ category: string; title: string; createdAt: string }> };
    if (data.entries.length === 0) {
      console.log('  No memory entries yet. Run: awx-sync memory add');
      return;
    }

    console.log(`\n  ${data.entries.length} memory entries:\n`);
    for (const e of data.entries) {
      const cat = e.category.padEnd(16);
      const date = new Date(e.createdAt).toLocaleDateString();
      console.log(`  [${cat}] ${e.title} (${date})`);
    }
    console.log('');
  });

// ── status ────────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show current project config')
  .action(() => {
    if (!configExists()) {
      console.log('  No .awxsync.json found. Run: awx-sync init');
      process.exit(0);
    }
    const config = loadConfig();
    console.log('\n  awx-sync status');
    console.log(`  Project ID : ${config.projectId}`);
    console.log(`  API URL    : ${config.apiUrl}`);
    console.log(`  Tool       : ${config.tool}`);
    console.log('');
  });

program.parse();
