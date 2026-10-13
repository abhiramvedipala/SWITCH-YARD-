export type NodeType = 'terminal' | 'agent-terminal' | 'agent-chat' | 'note' | 'doc' | 'browser';
export type NodeState = 'working' | 'idle' | 'needs_input' | 'exited' | 'starting';
export type HarnessId = 'claude' | 'agy' | 'shell' | 'mock';

export interface Workspace {
  id: string;
  name: string;
  rootDir: string;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  tools?: { name: string; input?: unknown; output?: string }[];
  at: number;
  error?: string;
}

export interface SNode {
  id: string;
  workspaceId: string;
  type: NodeType;
  harness: HarnessId | null;
  title: string;
  cwd: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  state: NodeState;
  sessionRef: string | null;
  yolo: boolean;
  data: Record<string, unknown> & {
    messages?: ChatMessage[];
    text?: string;
    content?: string;
    url?: string;
    readOnly?: boolean;
  };
  summary: string;
  alive?: boolean;
  busy?: boolean;
  unread?: number;
}

export interface SEdge {
  id: string;
  workspaceId: string;
  from: string;
  to: string;
  kind: string;
}

export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  status: 'open' | 'claimed' | 'done';
  ownerNode: string | null;
  createdBy: string | null;
  dependsOn: string[];
  result: string | null;
  position: number;
  blocked?: boolean;
}

export interface AttentionItem {
  kind: 'question' | 'needs_input' | 'unread' | 'permission';
  id: string;
  nodeId: string;
  nodeTitle: string;
  workspaceId: string;
  text: string;
  createdAt: number;
  count?: number;
  /** permission items only */
  toolName?: string;
  source?: 'claude' | 'agy';
  options?: ('allow' | 'deny' | 'ask')[];
  /** needs_input items only: a known dialog the UI can answer with one button (trust = Enter). */
  prompt?: 'trust';
}

export interface Detection {
  installed: boolean;
  version?: string;
  path?: string;
  loggedIn?: boolean;
  notes?: string[];
  installHint?: string;
  loginHint?: string;
}

export type RunStatus =
  'planning' | 'awaiting_approval' | 'running' | 'paused' | 'done' | 'failed' | 'stopped';

export interface RunStep {
  id: string;
  key: string;
  harness: HarnessId;
  role: 'plan' | 'build' | 'review' | 'verify';
  instruction: string;
  dependsOn: string[];
  status: 'pending' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped';
  output: string | null;
  evidence: { rounds?: { round: number; approve: boolean; findings: Finding[] }[] } | null;
  log: { at: number; text: string }[];
  round: number;
  usage: UsageTotals;
}

/** Summed over turns; costUsd is 0 when no turn reported a price (mock, agy). */
export interface UsageTotals {
  turns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Finding {
  severity: string;
  file: string;
  line?: number;
  note: string;
}

export interface RunResult {
  summary: string;
  approved: boolean | null;
  reviewRounds: number;
  files?: { added: string[]; modified: string[]; deleted: string[] };
  git?: { diffStat: string; status: string } | null;
  tests?: { command?: string; exitCode?: number | null; output?: string; unverified?: string };
  findings?: Finding[];
  errors?: string[];
  denials?: string[];
}

export interface Run {
  id: string;
  workspaceId: string;
  goal: string;
  status: RunStatus;
  plan: { summary: string } | null;
  cwd: string;
  result: RunResult | null;
  createdAt: number;
  steps: RunStep[];
  usage: UsageTotals;
}

export interface Settings {
  autoNudge: boolean;
  remoteReadOnly: boolean;
  remoteOwnerLogin: string;
  macNotifications: boolean;
  projectChatHarness: HarnessId;
  runTestsForEvidence: boolean;
  allowedTools: string[];
  defaultBuilder: HarnessId;
  defaultReviewer: HarnessId;
  agyPersistentSessions: boolean;
}

export interface SessionSummary {
  harness: 'claude' | 'agy';
  sessionId: string;
  title: string;
  cwd: string | null;
  path?: string;
  mtime: number;
  messageCount?: number;
}
