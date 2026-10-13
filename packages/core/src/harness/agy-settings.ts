import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SWITCHYARD_HOME, ensureDirs } from '../paths.js';

/** Overridable so tests never touch the real ~/.gemini. */
export const geminiDir = () => process.env.SWITCHYARD_GEMINI_DIR ?? join(homedir(), '.gemini');
export const agySettingsPath = () => join(geminiDir(), 'antigravity-cli/settings.json');
const ownedPath = () => join(SWITCHYARD_HOME, 'agy-owned-rules.json');

/** Rule that lets every tool of the switchyard MCP server run without an Ask (agy defaults MCP tools to Ask). */
export const BUS_RULE = 'mcp(switchyard/*)';
/** Test-running commands only. Settings are global in agy, so this cannot be limited to one folder. */
export const TEST_COMMAND_RULE =
  'command(regex:(pytest|python3? -m pytest|npm (test|run (build|lint|test))))';
export const writeRuleFor = (dir: string) => `write_file(${dir.endsWith('/') ? dir : `${dir}/`})`;

function readSettings(): Record<string, unknown> {
  const p = agySettingsPath();
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new Error(`${p} is not valid JSON; refusing to overwrite it`);
}

function allowList(cfg: Record<string, unknown>): string[] {
  const perms = (cfg.permissions ?? {}) as { allow?: unknown };
  return Array.isArray(perms.allow) ? (perms.allow as string[]) : [];
}

function writeSettings(cfg: Record<string, unknown>): void {
  const p = agySettingsPath();
  mkdirSync(dirname(p), { recursive: true });
  if (existsSync(p)) copyFileSync(p, `${p}.bak`);
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

function readOwned(): string[] {
  try {
    const v = JSON.parse(readFileSync(ownedPath(), 'utf8')) as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function writeOwned(rules: string[]): void {
  ensureDirs();
  writeFileSync(ownedPath(), JSON.stringify([...new Set(rules)], null, 2), { mode: 0o600 });
}

/**
 * Adds allow rules (idempotent, keeps every other key and rule). Rules that were already present
 * before Switchyard touched the file are NOT recorded as ours, so Remove never deletes the owner's own rules.
 */
export function addAllowRules(rules: string[]): { added: string[] } {
  const cfg = readSettings();
  const allow = allowList(cfg);
  const added = rules.filter((r) => !allow.includes(r));
  if (added.length === 0) return { added };
  const perms = {
    ...((cfg.permissions ?? {}) as Record<string, unknown>),
    allow: [...allow, ...added],
  };
  writeSettings({ ...cfg, permissions: perms });
  writeOwned([...readOwned(), ...added]);
  return { added };
}

/** Removes only rules Switchyard added, and cleans up an allow list it created from nothing. */
export function removeAllowRules(rules?: string[]): { removed: string[] } {
  const owned = readOwned();
  const targets = (rules ?? owned).filter((r) => owned.includes(r));
  if (targets.length === 0) return { removed: [] };
  const cfg = readSettings();
  const allow = allowList(cfg);
  const kept = allow.filter((r) => !targets.includes(r));
  const perms = { ...((cfg.permissions ?? {}) as Record<string, unknown>), allow: kept };
  if (kept.length === 0) delete (perms as { allow?: unknown }).allow;
  const next = { ...cfg, permissions: perms };
  if (Object.keys(perms).length === 0) delete (next as { permissions?: unknown }).permissions;
  writeSettings(next);
  writeOwned(owned.filter((r) => !targets.includes(r)));
  return { removed: targets };
}

export function allowRuleState(): { bus: boolean; testCommands: boolean; writeDirs: string[] } {
  let allow: string[] = [];
  try {
    allow = allowList(readSettings());
  } catch {
    // unparseable file: report nothing allowed
  }
  return {
    bus: allow.includes(BUS_RULE),
    testCommands: allow.includes(TEST_COMMAND_RULE),
    writeDirs: allow.filter((r) => r.startsWith('write_file(') && readOwned().includes(r)),
  };
}
