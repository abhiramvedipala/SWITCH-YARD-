import { HOOK_RELAY_ENTRY } from '../paths.js';
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

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
];

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Per-process settings JSON: hooks that relay lifecycle events to core. Never touches ~/.claude/settings.json. */
export function claudeHookSettings(nodeId: string): string {
  const hooks: Record<string, unknown> = {};
  for (const ev of HOOK_EVENTS) {
    hooks[ev] = [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `${shq(process.execPath)} ${shq(HOOK_RELAY_ENTRY)} claude ${shq(nodeId)} ${ev}`,
            timeout: 10,
          },
        ],
      },
    ];
  }
  // `mcp__switchyard` allows every tool of the switchyard server, so bus calls never prompt.
  // Nothing else is allowed by default; this lives only in this process's --settings.
  return JSON.stringify({ hooks, permissions: { allow: ['mcp__switchyard'] } });
}

export function claudeMcpConfig(nodeId: string): string {
  return JSON.stringify({
    mcpServers: { switchyard: { type: 'stdio', ...busMcpServerSpec(nodeId) } },
  });
}

function bin(): string {
  return which('claude') ?? 'claude';
}

/** Map one stream-json line from `claude -p --output-format stream-json --verbose` to normalized events. */
export function normalizeClaudeLine(obj: Record<string, unknown>): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const type = obj.type;
  if (type === 'stream_event') {
    const ev = obj.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (ev?.delta?.type === 'text_delta' && ev.delta.text)
      out.push({ kind: 'text', delta: ev.delta.text });
    return out;
  }
  if (type === 'assistant') {
    const content = ((obj.message as { content?: unknown[] })?.content ?? []) as Array<
      Record<string, unknown>
    >;
    for (const block of content) {
      if (block.type === 'tool_use')
        out.push({ kind: 'tool', name: String(block.name), input: block.input });
    }
    return out;
  }
  if (type === 'user') {
    const content = ((obj.message as { content?: unknown[] })?.content ?? []) as Array<
      Record<string, unknown>
    >;
    for (const block of content) {
      if (block.type === 'tool_result') {
        const c = block.content;
        const text =
          typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c.map((x) => (x as { text?: string }).text ?? '').join('')
              : '';
        out.push({ kind: 'tool', name: 'result', output: text.slice(0, 4000) });
      }
    }
    return out;
  }
  if (type === 'system' && obj.subtype === 'permission_denied') {
    out.push({ kind: 'error', message: `permission denied: ${JSON.stringify(obj).slice(0, 300)}` });
  }
  return out;
}

/**
 * argv for one driven (headless) Claude turn. No human can answer a prompt here, so
 * --permission-prompts none denies anything not pre-approved (and tells Claude not to retry).
 * Bypass mode is only used when the node's YOLO switch is on.
 */
export function claudeTurnArgs(opts: TurnOptions): string[] {
  const args = [
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.schema) args.push('--json-schema', JSON.stringify(opts.schema));
  if (opts.nodeId) {
    args.push('--mcp-config', claudeMcpConfig(opts.nodeId));
    args.push('--settings', claudeHookSettings(opts.nodeId));
  }
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.yolo) {
    args.push('--permission-mode', 'bypassPermissions');
  } else {
    args.push('--permission-mode', 'acceptEdits', '--permission-prompts', 'none');
    if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
  }
  return args;
}

/** One readable line per denied tool call, from a result's permission_denials or a permission_denied event. */
export function describeDenials(obj: Record<string, unknown>): string[] {
  const raw = (obj.permission_denials ??
    (obj.subtype === 'permission_denied' ? [obj] : [])) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.map((d) => {
    const r = d as { tool_name?: string; tool?: string; tool_input?: Record<string, unknown> };
    const name = r.tool_name ?? r.tool ?? 'tool';
    const input = r.tool_input ?? {};
    const detail = String(input.command ?? input.file_path ?? input.path ?? input.url ?? '').slice(
      0,
      120,
    );
    return detail ? `${name}: ${detail}` : name;
  });
}

export const claude: Harness = {
  id: 'claude',
  label: 'Claude Code',
  isAgent: true,
  needsInputPatterns: [
    /Do you want to (proceed|make this edit|create)/i,
    /❯\s*1\.\s*Yes/,
    /\(y\/n\)/i,
  ],

  async detect() {
    const path = which('claude');
    if (!path) {
      return {
        installed: false,
        installHint: 'npm install -g @anthropic-ai/claude-code   (or see https://code.claude.com)',
        loginHint: 'Run `claude` once in a terminal and sign in with your Claude account.',
      };
    }
    const v = await runCapture(path, ['--version']);
    return {
      installed: v.code === 0,
      path,
      version: v.stdout.trim().split('\n')[0],
      // Sign-in state lives in the keychain/credentials, which Switchyard never reads.
      loggedIn: undefined,
      loginHint:
        'If a Claude node says you are not logged in, run `claude` once in a terminal and sign in.',
    };
  },

  terminalLaunch(ctx: NodeCtx): TerminalLaunch {
    const args = [
      '--mcp-config',
      claudeMcpConfig(ctx.node.id),
      '--settings',
      claudeHookSettings(ctx.node.id),
      '--append-system-prompt',
      coordinationBlurb(ctx.node.id, ctx.node.title),
    ];
    if (ctx.node.yolo) args.push('--permission-mode', 'bypassPermissions');
    if (ctx.resumeRef) args.push('--resume', ctx.resumeRef);
    return { cmd: bin(), args, env: busEnv(ctx.node.id), cwd: ctx.cwd };
  },

  async runTurn(opts: TurnOptions): Promise<TurnResult> {
    const args = claudeTurnArgs(opts);

    let text = '';
    let finalText = '';
    let sessionId: string | null = opts.sessionId ?? null;
    let structured: unknown;
    let usage: unknown;
    let isError = false;
    let errMsg: string | undefined;
    const denials = new Set<string>();
    const emit = (e: NormalizedEvent) => opts.onEvent?.(e);
    emit({ kind: 'status', state: 'working' });
    const run = await runNdjson(bin(), args, {
      cwd: opts.cwd,
      env: opts.nodeId ? busEnv(opts.nodeId) : {},
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onLine: (obj) => {
        if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string') {
          sessionId = obj.session_id;
        }
        if (obj.type === 'result') {
          finalText = typeof obj.result === 'string' ? obj.result : '';
          if (typeof obj.session_id === 'string') sessionId = obj.session_id;
          structured = obj.structured_output;
          usage = { total_cost_usd: obj.total_cost_usd, usage: obj.usage };
          isError =
            obj.is_error === true || (typeof obj.subtype === 'string' && obj.subtype !== 'success');
          if (isError) errMsg = finalText || String(obj.subtype);
          for (const d of describeDenials(obj)) denials.add(d);
          return;
        }
        if (obj.type === 'system') for (const d of describeDenials(obj)) denials.add(d);
        for (const e of normalizeClaudeLine(obj)) {
          if (e.kind === 'text') text += e.delta;
          emit(e);
        }
      },
    });
    const resultText = finalText || text;
    if (opts.schema && structured === undefined) structured = extractJson(resultText);
    const ok = !isError && !run.aborted && !run.timedOut && run.code === 0;
    if (!ok && !errMsg)
      errMsg = run.aborted
        ? 'stopped'
        : run.timedOut
          ? 'timed out'
          : run.stderr.slice(-2000) || `exit ${run.code}`;
    emit({ kind: 'result', text: resultText, sessionId, usage });
    emit({ kind: 'status', state: 'idle' });
    return {
      ok,
      text: resultText,
      structured,
      sessionId,
      usage,
      denials: [...denials],
      error: ok ? undefined : errMsg,
    };
  },
};
