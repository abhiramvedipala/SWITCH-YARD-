import { mkdirSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
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
export const HOOK_AGY_ENTRY = join(REPO_ROOT, 'packages/bus-mcp/dist/hook-agy.js');
export const MOCK_AGENT_ENTRY = join(REPO_ROOT, 'packages/bus-mcp/dist/mock-agent.js');

export function ensureDirs(): void {
  for (const d of [SWITCHYARD_HOME, RUN_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

/** Where run/scratch folders live. Tests point this at <repo>/scratch via SWITCHYARD_SCRATCH_ROOT. */
export function scratchRoot(): string {
  return process.env.SWITCHYARD_SCRATCH_ROOT ?? join(SWITCHYARD_HOME, 'scratch');
}

/** realpath that also works for paths that don't exist yet: resolve the nearest existing ancestor. */
function real(p: string): string {
  let cur = resolve(p);
  let rest = '';
  for (;;) {
    try {
      return rest ? join(realpathSync(cur), rest) : realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest = rest ? join(cur.slice(parent.length + 1), rest) : cur.slice(parent.length + 1);
      cur = parent;
    }
  }
}

/** True when `child` is `parent` or lives under it (both already resolved). */
export function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Why an agent/run may not use this folder, or null if it is fine. Symlinks are resolved first. */
export function unsafeCwdReason(cwd: string): string | null {
  const c = real(cwd);
  if (inside(c, real(scratchRoot()))) return null;
  if (inside(c, real(REPO_ROOT))) return "This is the Switchyard app's own folder.";
  if (inside(c, real(SWITCHYARD_HOME)))
    return "This is Switchyard's private data folder (only its scratch/ subfolder is allowed).";
  return null;
}

export function assertSafeCwd(cwd: string, allowOwnFolder = false): void {
  const why = unsafeCwdReason(cwd);
  if (why && !allowOwnFolder) {
    throw new Error(
      `${why} Pick another folder, or confirm "I understand this is the app's own folder".`,
    );
  }
}
