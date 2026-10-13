import type { NodeRec, Workspace } from '../store.js';

export type HarnessId = 'claude' | 'agy' | 'shell' | 'mock';

export interface Detection {
  installed: boolean;
  version?: string;
  path?: string;
  loggedIn?: boolean;
  notes?: string[];
  installHint?: string;
  loginHint?: string;
}

export interface NodeCtx {
  node: NodeRec;
  workspace: Workspace;
  cwd: string;
  /** Resume an existing agent session in this terminal instead of starting fresh. */
  resumeRef?: string | null;
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
  schema?: Record<string, unknown>;
  yolo?: boolean;
  allowedTools?: string[];
  appendSystemPrompt?: string;
  onEvent?: (e: NormalizedEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TurnResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  sessionId: string | null;
  usage?: unknown;
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
  /** Text patterns in PTY output that mean "a human needs to answer something". */
  needsInputPatterns?: RegExp[];
}
