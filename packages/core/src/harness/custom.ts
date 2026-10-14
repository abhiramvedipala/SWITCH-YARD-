import { basename } from 'node:path';
import type { NodeRec } from '../store.js';
import type {
  CustomSpec,
  Harness,
  NodeCtx,
  NormalizedEvent,
  PresetInfo,
  TerminalLaunch,
  TurnOptions,
  TurnResult,
} from './types.js';
import { which, runCapture, busEnv, busMcpServerSpec } from './util.js';

/** Per-process bus attachment for one node: extra argv and env. Never a config file. */
type Attach = (nodeId: string) => { args: string[]; env: Record<string, string> };

export interface Preset {
  id: string;
  label: string;
  command: string;
  /** Interactive launch argv (prefilled in the dialog, owner-editable). */
  args: string[];
  install: string;
  docs: string;
  needsInputPatterns: RegExp[];
  /** Documented per-process MCP attachment; undefined = the tool has no such flag. */
  attach?: Attach;
  bus: string;
  /** Documented non-interactive mode: full argv for one prompt, plain text on stdout. */
  turn?: (prompt: string) => string[];
  /** Resume argv when the tool documents one. */
  resume?: (ref: string) => string[];
}

const NO_BUS =
  'bus tools: not available for this tool (no documented per-process MCP flag; Switchyard never edits its config files)';
// ponytail: prompt wording below is from memory of each TUI, not from docs (marked unverified in the report); refine per tool.
const GENERIC_PROMPTS = [/\(y\/n\)/i, /\[Y\/n\]/i, /\[y\/N\]/i];

/** goose: `--with-extension "[name:]ENV=val … command args…"` on both `session` and `run` (goose-cli-commands.md). */
const gooseAttach: Attach = (nodeId) => {
  const s = busMcpServerSpec(nodeId);
  const env = Object.entries(s.env).map(([k, v]) => `${k}=${v}`);
  // ponytail: goose splits this string on spaces; a bus-mcp path with a space in it is unverified.
  return {
    args: ['--with-extension', ['switchyard:' + env.join(' '), s.command, ...s.args].join(' ')],
    env: {},
  };
};

/** opencode: OPENCODE_CONFIG_CONTENT is inline config ("runtime overrides", docs/config); mcp shape from docs/mcp-servers. */
const opencodeAttach: Attach = (nodeId) => {
  const s = busMcpServerSpec(nodeId);
  const mcp = { type: 'local', command: [s.command, ...s.args], environment: s.env, enabled: true };
  return {
    args: [],
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { switchyard: mcp } }) },
  };
};

export const PRESETS: Record<string, Preset> = {
  aider: {
    id: 'aider',
    label: 'Aider',
    command: 'aider',
    args: [],
    install: 'python -m pip install aider-install && aider-install',
    docs: 'https://aider.chat/docs/config/options.html',
    needsInputPatterns: [/\(Y\)es\/\(N\)o/i, ...GENERIC_PROMPTS],
    bus: NO_BUS,
    turn: (prompt) => ['--message', prompt],
    resume: () => ['--restore-chat-history'],
  },
  goose: {
    id: 'goose',
    label: 'Goose',
    command: 'goose',
    args: ['session'],
    install: 'brew install block-goose-cli',
    docs: 'https://block.github.io/goose/docs/guides/goose-cli-commands',
    needsInputPatterns: [/do you allow\?/i, ...GENERIC_PROMPTS],
    attach: gooseAttach,
    bus: 'bus tools: attached per process with --with-extension (nothing is written to ~/.config/goose)',
    turn: (prompt) => ['run', '--no-session', '--quiet', '-t', prompt],
    resume: (id) => ['--resume', '--session-id', id],
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    args: [],
    install: 'curl -fsSL https://opencode.ai/install | bash   (or: npm install -g opencode-ai)',
    docs: 'https://opencode.ai/docs/cli/',
    needsInputPatterns: GENERIC_PROMPTS,
    attach: opencodeAttach,
    bus: 'bus tools: attached per process through OPENCODE_CONFIG_CONTENT (inline config, no file is written)',
    turn: (prompt) => ['run', prompt],
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    command: 'copilot',
    args: [],
    install: 'npm install -g @github/copilot   (or: brew install copilot-cli)',
    docs: 'https://docs.github.com/copilot/concepts/agents/about-copilot-cli',
    needsInputPatterns: [/\b1\.\s*Yes\b/, ...GENERIC_PROMPTS],
    bus: NO_BUS,
    turn: (prompt) => ['-p', prompt],
    resume: (id) => ['--resume', id],
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor CLI (agent)',
    command: 'agent',
    args: [],
    install: 'curl https://cursor.com/install -fsS | bash',
    docs: 'https://cursor.com/docs/cli/reference/parameters',
    needsInputPatterns: GENERIC_PROMPTS,
    bus: NO_BUS,
    turn: (prompt) => ['-p', '--output-format', 'text', prompt],
    resume: (id) => ['--resume', id],
  },
  other: {
    id: 'other',
    label: 'Other',
    command: '',
    args: [],
    install: 'any command on your PATH',
    docs: '',
    needsInputPatterns: GENERIC_PROMPTS,
    bus: NO_BUS,
  },
};

/** Shell-ish split for the dialog's one-line args field: quotes group words, nothing else is interpreted. */
export function splitArgs(s: string): string[] {
  // ponytail: no escapes or mid-word quotes (foo'bar'); good enough for flags and one quoted script.
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^(["'])(.*)\1$/s, '$2'));
}

/** A node's resolved preset, command and interactive argv. Throws when there is nothing to run. */
export function customSpec(data: Record<string, unknown> | undefined): {
  preset: Preset;
  command: string;
  args: string[];
} {
  const raw = (data?.custom ?? {}) as Partial<CustomSpec>;
  const preset = PRESETS[String(raw.preset ?? 'other')] ?? PRESETS.other!;
  const command =
    typeof raw.command === 'string' && raw.command.trim() ? raw.command.trim() : preset.command;
  if (!command) throw new Error('Other CLI agent: enter the command to run');
  const args =
    raw.args === undefined
      ? preset.args
      : Array.isArray(raw.args)
        ? raw.args.map(String)
        : splitArgs(String(raw.args));
  return { preset, command, args };
}

export function customTitle(data: Record<string, unknown> | undefined): string {
  const { preset, command } = customSpec(data);
  return preset.id === 'other' ? basename(command) : preset.label;
}

export function presetInfos(): PresetInfo[] {
  return Object.values(PRESETS).map((p) => {
    const path = p.command ? which(p.command) : null;
    return {
      id: p.id,
      label: p.label,
      command: p.command,
      args: p.args,
      install: p.install,
      docs: p.docs,
      installed: p.id === 'other' || !!path,
      path: path ?? undefined,
      drivable: !!p.turn,
      bus: p.bus,
    };
  });
}

/**
 * "Any CLI agent": a preset (or a command the owner types) in a PTY with the bus env, plus the bus MCP server
 * where the tool documents a per-process way to attach one. No bypass flag is ever passed: node.yolo is ignored,
 * because each tool's "skip approvals" switch means something different and nobody here has verified them.
 */
export const custom: Harness = {
  id: 'custom',
  label: 'Other CLI agent',
  isAgent: true,
  perNodeConfig: true,
  needsInputPatternsFor: (node: NodeRec) => customSpec(node.data).preset.needsInputPatterns,

  async detect() {
    const presets = presetInfos();
    const known = presets.filter((p) => p.id !== 'other');
    const n = known.filter((p) => p.installed).length;
    return {
      installed: n > 0,
      presets,
      notes: [`${n} of ${known.length} known tools on PATH; "Other" runs any command you type`],
    };
  },

  terminalLaunch(ctx: NodeCtx): TerminalLaunch {
    const { preset, command, args } = customSpec(ctx.node.data);
    const a = preset.attach?.(ctx.node.id);
    const resume = ctx.resumeRef && preset.resume ? preset.resume(ctx.resumeRef) : [];
    return {
      cmd: command,
      args: [...args, ...(a?.args ?? []), ...resume],
      env: { ...busEnv(ctx.node.id), ...(a?.env ?? {}) },
      cwd: ctx.cwd,
    };
  },

  /**
   * One driven turn for presets with a documented non-interactive mode: the preset's own argv (the node's
   * interactive args do not apply), prompt as an argument, stdout as the answer. Stateless: no session id is
   * parsed from plain text, so each turn starts fresh.
   */
  async runTurn(opts: TurnOptions): Promise<TurnResult> {
    const { preset, command } = customSpec({ custom: opts.custom });
    if (!preset.turn)
      return {
        ok: false,
        text: '',
        sessionId: null,
        error: `${preset.label} has no documented non-interactive mode; add it as a terminal agent instead`,
      };
    const a = opts.nodeId ? preset.attach?.(opts.nodeId) : undefined;
    // The coordination blurb names the switchyard tools, so it only goes where those tools are attached.
    const prompt =
      a && opts.appendSystemPrompt && !opts.sessionId
        ? `${opts.appendSystemPrompt}\n\n---\n\n${opts.prompt}`
        : opts.prompt;
    const emit = (e: NormalizedEvent) => opts.onEvent?.(e);
    emit({ kind: 'status', state: 'working' });
    // ponytail: the prompt rides in argv (visible in `ps`, ARG_MAX-bound); stdin forms exist for some tools (aider
    // --message-file, goose -i -) if a long prompt ever bites.
    const run = await runCapture(command, [...preset.turn(prompt), ...(a?.args ?? [])], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.nodeId ? busEnv(opts.nodeId) : {}), ...(a?.env ?? {}) },
      timeoutMs: opts.timeoutMs ?? 15 * 60_000,
      signal: opts.signal,
    });
    const text = run.stdout.trim();
    const aborted = !!opts.signal?.aborted;
    const ok = run.code === 0 && !aborted;
    emit({ kind: 'result', text, sessionId: null });
    emit({ kind: 'status', state: 'idle' });
    return {
      ok,
      text,
      sessionId: null,
      error: ok
        ? undefined
        : aborted
          ? 'stopped'
          : run.stderr.trim().slice(-2000) || `exit ${run.code}`,
    };
  },
};
