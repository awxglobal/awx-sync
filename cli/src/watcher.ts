import { statSync } from 'node:fs';
import { relative } from 'node:path';
import chokidar from 'chokidar';
import type { ApiClient, FileEventPayload } from './api-client.js';

interface WatcherOptions {
  projectRoot: string;
  projectId: string;
  sessionId?: string;
  client: ApiClient;
  ignore?: string[];
}

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/*.log',
  '**/.awxsync.json',
  '**/.awx-context.md',
];

export function startWatcher(opts: WatcherOptions): () => void {
  const { projectRoot, projectId, sessionId, client, ignore = [] } = opts;

  const pending: FileEventPayload[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      if (pending.length === 0) return;

      const batch = pending.splice(0, pending.length);
      try {
        const result = await client.ingestFileEvents(projectId, batch, sessionId);
        process.stdout.write(`  ▸ sent ${result.ingested} event${result.ingested !== 1 ? 's' : ''}\n`);
      } catch (err) {
        console.error('  ✗ failed to send events:', (err as Error).message);
        // Put them back for retry on next flush
        pending.unshift(...batch);
      }
    }, 2000);
  }

  function toRelative(absPath: string): string {
    return relative(projectRoot, absPath).replace(/\\/g, '/');
  }

  function getFileSize(absPath: string): number | undefined {
    try {
      return statSync(absPath).size;
    } catch {
      return undefined;
    }
  }

  const watcher = chokidar.watch(projectRoot, {
    ignored: [...DEFAULT_IGNORE, ...ignore],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  watcher.on('add', (absPath) => {
    pending.push({
      file_path: toRelative(absPath),
      event_type: 'created',
      file_size: getFileSize(absPath),
      timestamp: new Date().toISOString(),
    });
    scheduleFlush();
  });

  watcher.on('change', (absPath) => {
    pending.push({
      file_path: toRelative(absPath),
      event_type: 'modified',
      file_size: getFileSize(absPath),
      timestamp: new Date().toISOString(),
    });
    scheduleFlush();
  });

  watcher.on('unlink', (absPath) => {
    pending.push({
      file_path: toRelative(absPath),
      event_type: 'deleted',
      timestamp: new Date().toISOString(),
    });
    scheduleFlush();
  });

  watcher.on('error', (err) => {
    console.error('Watcher error:', err);
  });

  console.log(`  ▸ watching ${projectRoot}`);

  return () => {
    watcher.close();
    if (flushTimer) clearTimeout(flushTimer);
  };
}
