import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Overridable so tests never touch the real ~/.switchyard. */
export const SWITCHYARD_HOME = process.env.SWITCHYARD_HOME ?? join(homedir(), '.switchyard');
export const RUN_DIR = join(SWITCHYARD_HOME, 'run');
export const DB_PATH = join(SWITCHYARD_HOME, 'switchyard.db');

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root, resolved from packages/core/{src,dist}. */
export const REPO_ROOT = resolve(here, '../../..');
export const WEB_DIST_DIR = join(REPO_ROOT, 'packages/web/dist');
export const BUS_MCP_ENTRY = join(REPO_ROOT, 'packages/bus-mcp/dist/index.js');
export const HOOK_RELAY_ENTRY = join(REPO_ROOT, 'packages/bus-mcp/dist/hook.js');
export const MOCK_AGENT_ENTRY = join(REPO_ROOT, 'packages/bus-mcp/dist/mock-agent.js');

export function ensureDirs(): void {
  for (const d of [SWITCHYARD_HOME, RUN_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}
