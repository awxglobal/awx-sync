import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Config {
  projectId: string;
  apiKey: string;
  apiUrl: string;
  tool: 'claude-code' | 'cursor' | 'codex';
  ignore?: string[];
}

const CONFIG_FILE = '.awxsync.json';

export function configPath(cwd: string = process.cwd()): string {
  return join(cwd, CONFIG_FILE);
}

export function loadConfig(cwd: string = process.cwd()): Config {
  const path = configPath(cwd);
  if (!existsSync(path)) {
    console.error(`No ${CONFIG_FILE} found. Run: awx-sync init`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Config;
  } catch {
    console.error(`Failed to parse ${CONFIG_FILE}`);
    process.exit(1);
  }
}

export function writeConfig(config: Config, cwd: string = process.cwd()): void {
  writeFileSync(configPath(cwd), JSON.stringify(config, null, 2), 'utf-8');
}

export function configExists(cwd: string = process.cwd()): boolean {
  return existsSync(configPath(cwd));
}
