import type {
  Harness,
  NodeCtx,
  TerminalLaunch,
  TurnOptions,
  TurnResult,
  NormalizedEvent,
} from './types.js';
import {
  which,
  runCapture,
  runNdjson,
  busEnv,
  busMcpServerSpec,
  coordinationBlurb,
  extractJson,
} from './util.js';

/** SWITCHYARD_CODEX_BIN overrides the lookup (tests point it at a fake; never at the real binary). */
function bin(): string {
  return process.env.SWITCHYARD_CODEX_BIN || (which('codex') ?? 'codex');
}

const INSTALL_HINT = 'npm install -g @openai/codex   (or: brew install --cask codex)';
const LOGIN_HINT =
  'Run `codex login` in a terminal and choose "Sign in with ChatGPT" (uses your ChatGPT plan).';

/** `--config` values parse as TOML; a JSON string or string array is valid TOML, so JSON.stringify is the encoder. */
const toml = (v: string | string[]) => JSON.stringify(v);

/**
 * The bus MCP server as per-process `--config mcp_servers.switchyard.*` overrides, so nothing is written to
 * ~/.codex/config.toml. env is explicit because Codex forwards only listed variables to MCP servers.
 */
export function codexMcpOverrides(nodeId: string): string[] {
  const s = busMcpServerSpec(nodeId);
  const env = Object.entries(s.env)
    .map(([k, v]) => `${k}=${toml(v)}`)
    .join(',');
  return [
    '--config',
    `mcp_servers.switchyard.command=${toml(s.command)}`,
    '--config',
    `mcp_servers.switchyard.args=${toml(s.args)}`,
    '--config',
    `mcp_servers.switchyard.env={${env}}`,
  ];
}

/**
 * argv for one driven `codex exec` turn; the prompt goes on stdin (as OpenAI's own SDK does).
 * Default: workspace-write sandbox and approval_policy "never" (nobody can answer a prompt, so anything that
 * would need approval is not escalated). The bypass flag only with the node's YOLO switch.
 * Options come before `resume <id>`, the order OpenAI's SDK uses.
 */
export function codexTurnArgs(opts: TurnOptions): string[] {
  const args = ['exec', '--json'];
  if (opts.nodeId) args.push(...codexMcpOverrides(opts.nodeId));
  if (opts.appendSystemPrompt && !opts.sessionId)
    args.push('--config', `developer_instructions=${toml(opts.appendSystemPrompt)}`);
  if (opts.yolo) args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('--sandbox', 'workspace-write', '--config', 'approval_policy="never"');
  if (opts.sessionId) args.push('resume', opts.sessionId);
  return args;
}

export interface CodexLine {
  events: NormalizedEvent[];
  threadId?: string;
  /** agent_message text (the last one is the turn's answer). */
  message?: string;
  usage?: Record<string, unknown>;
  /** turn.failed: the turn did not complete. */
  failed?: string;
}

/** Map one `codex exec --json` line (thread.started, item.completed, turn.completed, turn.failed, error). */
export function normalizeCodexLine(obj: Record<string, unknown>): CodexLine {
  switch (obj.type) {
    case 'thread.started':
      return { events: [], threadId: String(obj.thread_id) };
    case 'turn.completed':
      return { events: [], usage: obj.usage as Record<string, unknown> };
    case 'turn.failed': {
      const message = (obj.error as { message?: string } | undefined)?.message ?? 'turn failed';
      return { events: [{ kind: 'error', message }], failed: message };
    }
    case 'error':
      return { events: [{ kind: 'error', message: String(obj.message) }] };
    case 'item.completed':
      break;
    default:
      return { events: [] };
  }
  const it = (obj.item ?? {}) as Record<string, unknown>;
  const out = (s: unknown) => String(s ?? '').slice(0, 4000);
  switch (it.type) {
    case 'agent_message':
      return { events: [], message: String(it.text ?? '') };
    case 'command_execution':
      return {
        events: [
          {
            kind: 'tool',
            name: 'command',
            input: { command: it.command },
            output: out(it.aggregated_output),
          },
        ],
      };
    case 'file_change':
      return {
        events: [
          {
            kind: 'tool',
            name: 'file_change',
            input: { changes: it.changes },
            output: out(it.status),
          },
        ],
      };
    case 'mcp_tool_call': {
      const r = it.result as { content?: Array<{ text?: string }> } | undefined;
      const err = (it.error as { message?: string } | undefined)?.message;
      return {
        events: [
          {
            kind: 'tool',
            name: `mcp__${String(it.server)}__${String(it.tool)}`,
            input: it.arguments,
            output: out(err ?? r?.content?.map((c) => c.text ?? '').join('')),
          },
        ],
      };
    }
    case 'web_search':
      return { events: [{ kind: 'tool', name: 'web_search', input: { query: it.query } }] };
    case 'error':
      return { events: [{ kind: 'error', message: String(it.message) }] };
    default:
      return { events: [] }; // reasoning, todo_list
  }
}

export const codex: Harness = {
  id: 'codex',
  label: 'Codex (ChatGPT)',
  isAgent: true,
  // ponytail: approval-prompt wording from the Codex TUI, not from its docs; refine once a real codex is installed.
  needsInputPatterns: [/Would you like to (run|make|apply)/i, /Yes, proceed/i, /\(y\/n\)/i],

  async detect() {
    const path = which('codex');
    if (!path) return { installed: false, installHint: INSTALL_HINT, loginHint: LOGIN_HINT };
    const [v, s] = await Promise.all([
      runCapture(path, ['--version']),
      runCapture(path, ['login', 'status']),
    ]);
    // Documented: `codex login status` exits 0 when signed in. Its text is only matched, never shown
    // (an API-key login prints a masked key).
    const status = s.stdout + s.stderr;
    const notes = [
      'bus tools are attached per process with --config mcp_servers.switchyard.* (nothing is written to ~/.codex)',
    ];
    if (s.code === 0 && /api key/i.test(status))
      notes.push('signed in with an API key, not a ChatGPT plan: turns are billed to that key');
    return {
      installed: v.code === 0,
      path,
      version: (v.stdout || v.stderr).trim().split('\n')[0],
      loggedIn: s.code === 0,
      notes,
      loginHint: s.code === 0 ? undefined : LOGIN_HINT,
    };
  },

  terminalLaunch(ctx: NodeCtx): TerminalLaunch {
    const args = [
      ...codexMcpOverrides(ctx.node.id),
      '--config',
      `developer_instructions=${toml(coordinationBlurb(ctx.node.id, ctx.node.title))}`,
    ];
    if (ctx.node.yolo) args.push('--dangerously-bypass-approvals-and-sandbox');
    if (ctx.resumeRef) args.push('resume', ctx.resumeRef);
    return { cmd: bin(), args, env: busEnv(ctx.node.id), cwd: ctx.cwd };
  },

  async runTurn(opts: TurnOptions): Promise<TurnResult> {
    // ponytail: no --output-schema (OpenAI strict schemas reject ours); the schema rides in the prompt instead.
    const prompt = opts.schema
      ? `${opts.prompt}\n\nReply with only a JSON object matching this JSON Schema:\n${JSON.stringify(opts.schema)}`
      : opts.prompt;
    let text = '';
    let message = '';
    let sessionId: string | null = opts.sessionId ?? null;
    let usage: Record<string, unknown> | undefined;
    let failed: string | undefined;
    let lastError: string | undefined;
    const emit = (e: NormalizedEvent) => opts.onEvent?.(e);
    emit({ kind: 'status', state: 'working' });
    const run = await runNdjson(bin(), codexTurnArgs(opts), {
      cwd: opts.cwd,
      env: opts.nodeId ? busEnv(opts.nodeId) : {},
      stdin: prompt,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onLine: (obj) => {
        const n = normalizeCodexLine(obj);
        if (n.threadId) sessionId = n.threadId;
        if (n.usage) usage = n.usage;
        if (n.failed) failed = n.failed;
        if (n.message !== undefined) {
          // exec reports whole messages, not deltas; keep separate messages apart in the chat.
          const delta = text ? `\n\n${n.message}` : n.message;
          text += delta;
          message = n.message;
          emit({ kind: 'text', delta });
        }
        for (const e of n.events) {
          if (e.kind === 'error') lastError = e.message;
          emit(e);
        }
      },
    });
    const finalText = message || text;
    const structured = opts.schema ? extractJson(finalText) : undefined;
    const ok = !failed && !run.aborted && !run.timedOut && run.code === 0;
    const error = ok
      ? undefined
      : run.aborted
        ? 'stopped'
        : run.timedOut
          ? 'timed out'
          : (failed ?? lastError ?? (run.stderr.slice(-2000) || `exit ${run.code}`));
    emit({ kind: 'result', text: finalText, sessionId, usage });
    emit({ kind: 'status', state: 'idle' });
    return { ok, text: finalText, structured, sessionId, usage, error };
  },
};
