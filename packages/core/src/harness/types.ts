import type { NodeRec, Workspace } from '../store.js';

export type HarnessId =
  | 'claude'
  | 'agy'
  | 'codex'
  | 'shell'
  | 'mock'
  | 'custom'
  | 'api-anthropic'
  | 'api-openai'
  | 'api-gemini';

/** One entry of the `custom` harness's preset table, as the UI sees it (install state included). */
export interface PresetInfo {
  id: string;
  label: string;
  command: string;
  args: string[];
  install: string;
  docs: string;
  installed: boolean;
  path?: string;
  /** Has a documented non-interactive mode (can back a chat node). */
  drivable: boolean;
  /** How the bus MCP server is attached per process, or why it is not. */
  bus: string;
}

export interface Detection {
  installed: boolean;
  version?: string;
  path?: string;
  loggedIn?: boolean;
  notes?: string[];
  installHint?: string;
  loginHint?: string;
  /** Chat-only API harnesses: model IDs to suggest; the first is the default. */
  models?: string[];
  /** `custom` only: every preset with its install state. */
  presets?: PresetInfo[];
}

/** `custom` nodes: data.custom. `args` may arrive as one string from the dialog; customSpec() splits it. */
export interface CustomSpec {
  preset: string;
  command: string;
  args: string[] | string;
}

export interface NodeCtx {
  node: NodeRec;
  workspace: Workspace;
  cwd: string;
  /** Resume an existing agent session in this terminal instead of starting fresh. */
  resumeRef?: string | null;
  /** A first prompt the interactive session starts with (hand-offs: "Read HANDOFF-….md first"). */
  initialPrompt?: string;
  /** Claude HTTP-hook URL for this node (contains the per-node hook secret). */
  hookUrl?: string;
}

export interface TerminalLaunch {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export type NormalizedEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'tool'; name: string; input?: unknown; output?: string }
  | { kind: 'status'; state: 'working' | 'idle' | 'needs_input' | 'exited' }
  | { kind: 'result'; text: string; sessionId: string | null; usage?: unknown }
  | { kind: 'ask'; question: string }
  | { kind: 'error'; message: string };

export interface TurnOptions {
  prompt: string;
  cwd: string;
  /** Node whose bus identity this turn should carry (gives the agent the switchyard tools). */
  nodeId?: string;
  sessionId?: string | null;
  /** API harnesses only: model ID override (chat node data.model). */
  model?: string;
  /** custom only: the node's preset/command (chat node data.custom). */
  custom?: CustomSpec;
  schema?: Record<string, unknown>;
  yolo?: boolean;
  allowedTools?: string[];
  appendSystemPrompt?: string;
  onEvent?: (e: NormalizedEvent) => void;
  /** agy only: run this turn in the long-lived stream-json process kept under this key (Settings: agyPersistentSessions). */
  sessionKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TurnResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  sessionId: string | null;
  usage?: unknown;
  /** Tool calls that were denied because nobody could approve them (driven turns only). */
  denials?: string[];
  error?: string;
}

export interface Harness {
  id: HarnessId;
  label: string;
  /** Can run as an interactive terminal agent with bus access. */
  isAgent: boolean;
  detect(): Promise<Detection>;
  terminalLaunch(ctx: NodeCtx): TerminalLaunch;
  /** One driven turn (headless, NDJSON). Undefined for harnesses that can't be driven. */
  runTurn?(opts: TurnOptions): Promise<TurnResult>;
  /** runTurn needs per-node data (TurnOptions.custom): rooms and run steps carry none, so they skip it. */
  perNodeConfig?: boolean;
  /** Text patterns in PTY output that mean "a human needs to answer something". */
  needsInputPatterns?: RegExp[];
  /** Per-node override of needsInputPatterns (custom: the node's preset decides). */
  needsInputPatternsFor?(node: NodeRec): RegExp[];
}
