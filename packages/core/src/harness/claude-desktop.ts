import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Core } from '../core.js';
import { SWITCHYARD_HOME, BUS_MCP_ENTRY } from '../paths.js';
import { runFilePath } from '../auth/capability.js';
import { DEFAULT_SIZE, freeSlot } from '../nodes/service.js';
import { LEAN_NODE_FLAGS } from './util.js';

/**
 * Opt-in (DECISIONS 2026-10-14): the only Claude Desktop file Switchyard writes is this config (plus one .bak), and
 * only its `mcpServers.switchyard` entry. Overridable so tests never touch the real one.
 */
export const claudeDesktopConfigPath = () =>
  process.env.SWITCHYARD_CLAUDE_DESKTOP_CONFIG ??
  join(homedir(), 'Library/Application Support/Claude/claude_desktop_config.json');

/** Fixed node id, so its 0600 run file is the stable ~/.switchyard/run/claude-desktop.json the entry names. */
export const DESKTOP_NODE = 'claude-desktop';

export type DesktopEntryState = 'present' | 'absent' | 'stale' | 'invalid';

/** What Claude Desktop runs: the bus-mcp of this checkout. env carries only paths, never the capability. */
export function desktopEntry() {
  return {
    command: process.execPath,
    args: [...LEAN_NODE_FLAGS, BUS_MCP_ENTRY],
    env: { SWITCHYARD_HOME, SWITCHYARD_CAPFILE: runFilePath(DESKTOP_NODE) },
  };
}

function readConfig(): Record<string, unknown> {
  const p = claudeDesktopConfigPath();
  if (!existsSync(p)) return {};
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    v = undefined;
  }
  const isObj = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x);
  const servers = isObj(v) ? (v as { mcpServers?: unknown }).mcpServers : undefined;
  if (!isObj(v) || (servers !== undefined && !isObj(servers)))
    throw new Error(`${p} is not valid JSON; refusing to overwrite it`);
  return v as Record<string, unknown>;
}

function writeConfig(cfg: Record<string, unknown>): void {
  const p = claudeDesktopConfigPath();
  if (!existsSync(dirname(p)))
    throw new Error(`Claude Desktop does not look installed: ${dirname(p)} is missing`);
  // Once only: the .bak keeps the owner's file as it was before Switchyard first changed it.
  if (existsSync(p) && !existsSync(`${p}.bak`)) copyFileSync(p, `${p}.bak`);
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

const servers = (cfg: Record<string, unknown>) => (cfg.mcpServers ?? {}) as Record<string, unknown>;

/** present = our exact entry; stale = a `switchyard` entry for another checkout, node binary or home. */
export function desktopEntryState(): DesktopEntryState {
  let cfg: Record<string, unknown>;
  try {
    cfg = readConfig();
  } catch {
    return 'invalid';
  }
  const cur = servers(cfg).switchyard;
  if (cur === undefined) return 'absent';
  return isDeepStrictEqual(cur, desktopEntry()) ? 'present' : 'stale';
}

/** Adds or refreshes only `mcpServers.switchyard`; every other key is written back as it was read. */
export function addDesktopEntry(): { changed: boolean } {
  const cfg = readConfig();
  if (isDeepStrictEqual(servers(cfg).switchyard, desktopEntry())) return { changed: false };
  writeConfig({ ...cfg, mcpServers: { ...servers(cfg), switchyard: desktopEntry() } });
  return { changed: true };
}

export function removeDesktopEntry(): { changed: boolean } {
  const cfg = readConfig();
  if (!('switchyard' in servers(cfg))) return { changed: false };
  const rest = { ...servers(cfg) };
  delete rest.switchyard;
  const next: Record<string, unknown> = { ...cfg, mcpServers: rest };
  // ponytail: an mcpServers block left empty is dropped, so a file that had none reverts exactly
  // (one that had an explicit empty block loses it; same meaning to Claude Desktop).
  if (Object.keys(rest).length === 0) delete next.mcpServers;
  writeConfig(next);
  return { changed: true };
}

export function desktopStatus(core: Core) {
  return {
    config: desktopEntryState(),
    configPath: claudeDesktopConfigPath(),
    nodeId: DESKTOP_NODE,
    /** The one workspace the identity is bound to (its node row), or null when not connected. */
    workspaceId: core.store.getNode(DESKTOP_NODE)?.workspaceId ?? null,
  };
}

/**
 * Connect: write the entry, then give Claude Desktop one identity, a small `external` node on the chosen workspace's
 * canvas. A real canvas node so the owner scopes it with edges like any agent; no PTY, state always "external".
 * Moving to another workspace drops the old node and its edges. Every Connect issues a fresh capability.
 */
export function connectClaudeDesktop(core: Core, workspaceId: string) {
  const { store, nodes, caps } = core;
  if (!store.getWorkspace(workspaceId)) throw new Error('unknown workspace');
  addDesktopEntry(); // refuses invalid JSON before anything else changes
  const cur = store.getNode(DESKTOP_NODE);
  if (cur && cur.workspaceId !== workspaceId) nodes.remove(DESKTOP_NODE);
  if (!store.getNode(DESKTOP_NODE)) {
    const [w, h] = DEFAULT_SIZE.external;
    const slot = freeSlot(
      store.listNodes(workspaceId).filter((n) => !n.data.project),
      w,
      h,
    );
    store.insertNode({
      id: DESKTOP_NODE,
      workspaceId,
      type: 'external',
      harness: 'claude-desktop',
      title: 'Claude Desktop',
      cwd: null,
      ...slot,
      w,
      h,
      state: 'external',
      sessionRef: null,
      yolo: false,
      data: {},
      summary: '',
    });
  }
  caps.issue(DESKTOP_NODE, workspaceId);
  return desktopStatus(core);
}

/** Remove: revoke first (deletes the run file), so the identity is dead even if the config can't be edited. */
export function removeClaudeDesktop(core: Core) {
  core.nodes.remove(DESKTOP_NODE);
  removeDesktopEntry();
  return desktopStatus(core);
}
