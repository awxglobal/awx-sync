import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiClient } from './api-client.js';

export async function fetchAndPrint(
  client: ApiClient,
  projectId: string,
  maxTokens = 2000,
): Promise<void> {
  const block = await client.getContext(projectId, maxTokens);
  process.stdout.write(block + '\n');
}

export async function fetchAndCopy(
  client: ApiClient,
  projectId: string,
  maxTokens = 2000,
): Promise<void> {
  const block = await client.getContext(projectId, maxTokens);

  // Windows: use clip
  try {
    const proc = execSync('clip', { input: block });
    void proc;
    console.log('  ✓ Context block copied to clipboard. Paste it at the top of your Claude Code session.');
  } catch {
    // Fallback: print to stdout
    process.stdout.write(block + '\n');
    console.log('\n  (clipboard unavailable — context printed above)');
  }
}

export async function fetchAndWriteFile(
  client: ApiClient,
  projectId: string,
  projectRoot: string,
  maxTokens = 2000,
): Promise<void> {
  const block = await client.getContext(projectId, maxTokens);
  const filePath = join(projectRoot, '.awx-context.md');
  writeFileSync(filePath, block, 'utf-8');
}
