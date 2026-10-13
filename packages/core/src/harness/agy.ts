import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { SWITCHYARD_HOME, BUS_MCP_ENTRY, HOOK_RELAY_ENTRY } from '../paths.js';
import type {
  Harness,
  NodeCtx,
  TerminalLaunch,
  TurnOptions,
  TurnResult,
  NormalizedEvent,
} from './types.js';
import { which, runCapture, runNdjson, busEnv, coordinationBlurb, extractJson } from './util.js';
import { geminiDir } from './agy-settings.js';

export const agyMcpConfigPath = () => join(geminiDir(), 'config/mcp_config.json');
export const agyHooksConfigPath = () => join(geminiDir(), 'config/hooks.json');

function bin(): string {
  return which('agy') ?? join(homedir(), '.local/bin/agy');
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(`${path} is not valid JSON; refusing to overwrite it`);
  }
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Adds (or refreshes) only the `switchyard` entry in agy's global MCP config, leaving every other entry alone.
 * agy's docs don't say whether `env` values expand `$VAR`, so bus-mcp treats a literal "$SWITCHYARD_NODE"
 * as unset and falls back to the per-cwd identity file core writes for each agy node.
 */
export function ensureAgyMcpEntry(): void {
  const cfg = readJson(agyMcpConfigPath());
  const servers = (cfg.mcpServers as Record<string, unknown> | undefined) ?? {};
  servers.switchyard = {
    command: process.execPath,
    args: [BUS_MCP_ENTRY],
    env: { SWITCHYARD_HOME, SWITCHYARD_NODE: '$SWITCHYARD_NODE' },
  };
  writeJson(agyMcpConfigPath(), { ...cfg, mcpServers: servers });
}

export function removeAgyMcpEntry(): boolean {
  if (!existsSync(agyMcpConfigPath())) return false;
  const cfg = readJson(agyMcpConfigPath());
  const servers = (cfg.mcpServers as Record<string, unknown> | undefined) ?? {};
  if (!('switchyard' in servers)) return false;
  delete servers.switchyard;
  writeJson(agyMcpConfigPath(), { ...cfg, mcpServers: servers });
  return true;
}

export function hasAgyMcpEntry(): boolean {
  try {
    const servers =
      (readJson(agyMcpConfigPath()).mcpServers as Record<string, unknown> | undefined) ?? {};
    return 'switchyard' in servers;
  } catch {
    return false;
  }
}

/** Opt-in only (Settings button): agy reads hooks from hooks.json files, not a per-process flag. */
export function installAgyHooks(): void {
  const cfg = readJson(agyHooksConfigPath());
  const cmd = (ev: string) => `"${process.execPath}" "${HOOK_RELAY_ENTRY}" agy - ${ev}`;
  cfg['switchyard-status'] = {
    SessionStart: [{ command: cmd('SessionStart'), timeout: 10 }],
    PreInvocation: [{ command: cmd('PreInvocation'), timeout: 10 }],
    PostToolUse: [{ matcher: '', hooks: [{ command: cmd('PostToolUse'), timeout: 10 }] }],
    Stop: [{ command: cmd('Stop'), timeout: 10 }],
  };
  writeJson(agyHooksConfigPath(), cfg);
}

export function removeAgyHooks(): boolean {
  if (!existsSync(agyHooksConfigPath())) return false;
  const cfg = readJson(agyHooksConfigPath());
  if (!('switchyard-status' in cfg)) return false;
  delete cfg['switchyard-status'];
  writeJson(agyHooksConfigPath(), cfg);
  return true;
}

export function hasAgyHooks(): boolean {
  try {
    return 'switchyard-status' in readJson(agyHooksConfigPath());
  } catch {
    return false;
  }
}

/** agy stream-json lines look like {"event":"step_update","step_update":{...}}; tolerate a flat shape too. */
export function normalizeAgyLine(obj: Record<string, unknown>): {
  events: NormalizedEvent[];
  conversationId?: string;
  result?: Record<string, unknown>;
} {
  const ev = (obj.event ?? obj.type) as string | undefined;
  const payload = ((ev && (obj[ev] as Record<string, unknown>)) ?? obj) as Record<string, unknown>;
  const events: NormalizedEvent[] = [];
  const conversationId =
    (payload.conversation_id as string | undefined) ?? (obj.conversation_id as string | undefined);
  if (ev === 'step_update') {
    if (typeof payload.text_delta === 'string' && payload.text_delta) {
      events.push({ kind: 'text', delta: payload.text_delta });
    }
    const ti = payload.tool_info as
      { name?: string; parameters?: unknown; output?: string; error?: string } | undefined;
    if (ti?.name && payload.state === 'DONE') {
      events.push({
        kind: 'tool',
        name: ti.name,
        input: ti.parameters,
        output: ti.error ?? ti.output,
      });
    }
  }
  if (ev === 'result') return { events, conversationId, result: payload };
  return { events, conversationId };
}

export const agy: Harness = {
  id: 'agy',
  label: 'Antigravity CLI',
  isAgent: true,
  needsInputPatterns: [
    /\(y\/n\)/i,
    /Allow (this|once|always)/i,
    /Do you want to/i,
    /waiting for (your )?(approval|input)/i,
  ],

  async detect() {
    const path = which('agy');
    if (!path) {
      return {
        installed: false,
        installHint: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
        loginHint:
          'Then run `agy` once in a terminal; it opens a browser to sign in and caches the token in Keychain.',
      };
    }
    const v = await runCapture(path, ['--version']);
    const notes: string[] = [];
    if (hasAgyMcpEntry())
      notes.push('switchyard MCP entry present in ~/.gemini/config/mcp_config.json');
    if (hasAgyHooks())
      notes.push('switchyard status hooks installed in ~/.gemini/config/hooks.json');
    return {
      installed: v.code === 0,
      path,
      version: (v.stdout || v.stderr).trim().split('\n')[0],
      loggedIn: undefined,
      notes,
      loginHint: 'If an agy node asks you to sign in, run `agy` once in a terminal.',
    };
  },

  terminalLaunch(ctx: NodeCtx): TerminalLaunch {
    ensureAgyMcpEntry();
    const args: string[] = [];
    if (ctx.node.yolo) args.push('--dangerously-skip-permissions');
    if (ctx.resumeRef) args.push('--conversation', ctx.resumeRef);
    return { cmd: bin(), args, env: busEnv(ctx.node.id), cwd: ctx.cwd };
  },

  async runTurn(opts: TurnOptions): Promise<TurnResult> {
    if (opts.nodeId) ensureAgyMcpEntry();
    const prompt =
      !opts.sessionId && opts.nodeId && opts.appendSystemPrompt
        ? `${opts.appendSystemPrompt}\n\n---\n\n${opts.prompt}`
        : opts.prompt;
    const args = ['-p', prompt, '--output-format', 'stream-json', '--print-timeout', '15m'];
    if (opts.sessionId) args.push('--conversation', opts.sessionId);
    if (opts.schema) args.push('--json-schema', JSON.stringify(opts.schema));
    if (opts.yolo) args.push('--dangerously-skip-permissions');
    let text = '';
    let sessionId: string | null = opts.sessionId ?? null;
    let result: Record<string, unknown> | undefined;
    const emit = (e: NormalizedEvent) => opts.onEvent?.(e);
    emit({ kind: 'status', state: 'working' });
    const run = await runNdjson(bin(), args, {
      cwd: opts.cwd,
      env: opts.nodeId ? busEnv(opts.nodeId) : {},
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onLine: (obj) => {
        const n = normalizeAgyLine(obj);
        if (n.conversationId) sessionId = n.conversationId;
        if (n.result) result = n.result;
        for (const e of n.events) {
          if (e.kind === 'text') text += e.delta;
          emit(e);
        }
      },
    });
    const status = (result?.status as string | undefined) ?? (run.code === 0 ? 'SUCCESS' : 'ERROR');
    const finalText = (result?.response as string | undefined) ?? text;
    let structured = result?.structured_output;
    if (opts.schema && structured === undefined) structured = extractJson(finalText);
    if (status === 'WAITING') emit({ kind: 'status', state: 'needs_input' });
    const ok = status === 'SUCCESS' && !run.aborted && !run.timedOut;
    emit({ kind: 'result', text: finalText, sessionId, usage: result?.usage });
    emit({ kind: 'status', state: 'idle' });
    return {
      ok,
      text: finalText,
      structured,
      sessionId,
      usage: result?.usage,
      error: ok
        ? undefined
        : ((result?.error as string | undefined) ??
          (run.aborted ? 'stopped' : run.stderr.slice(-2000) || status)),
    };
  },
};

export function agyBlurb(nodeId: string, title: string): string {
  return coordinationBlurb(nodeId, title);
}
