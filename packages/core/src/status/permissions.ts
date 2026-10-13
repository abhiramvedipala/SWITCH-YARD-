import { randomId } from '../auth/token.js';
import { hub } from '../events.js';

export type PermissionDecision = 'allow' | 'deny' | 'ask';
export type PermissionOutcome = PermissionDecision | 'timeout' | 'cancelled';

/** How long a hook request may stay open before the agent's own terminal prompt takes over (just under each hook timeout). */
export const CLAUDE_PERMISSION_TIMEOUT_MS = 590_000;
export const AGY_PERMISSION_TIMEOUT_MS = 290_000;

/** Tests shorten the wait with SWITCHYARD_PERMISSION_TIMEOUT_MS; real runs never set it. */
export function permissionTimeoutMs(source: 'claude' | 'agy'): number {
  const o = Number(process.env.SWITCHYARD_PERMISSION_TIMEOUT_MS);
  if (Number.isFinite(o) && o > 0) return o;
  return source === 'claude' ? CLAUDE_PERMISSION_TIMEOUT_MS : AGY_PERMISSION_TIMEOUT_MS;
}

export interface PermissionItem {
  id: string;
  nodeId: string;
  workspaceId: string;
  source: 'claude' | 'agy';
  toolName: string;
  /** Human-readable form of the tool input (for Bash: the command). */
  detail: string;
  createdAt: number;
  /** Decisions the sidebar may offer. Claude: allow/deny; agy also "ask in terminal". */
  options: PermissionDecision[];
}

interface Pending extends PermissionItem {
  resolve: (o: PermissionOutcome) => void;
  timer: NodeJS.Timeout;
}

const MAX_DETAIL = 1200;

function clip(s: string, n = MAX_DETAIL): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Readable summary of a tool call's input: the command for Bash, the path/url for file and web tools, else compact JSON. */
export function describeToolInput(toolName: string, input: unknown): string {
  if (typeof input === 'string') return clip(input);
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
  const command = str('command') || str('cmd') || str('CommandLine');
  if (command) {
    const why = str('description');
    return clip(why ? `${command}\n# ${why}` : command);
  }
  const target =
    str('file_path') || str('path') || str('url') || str('AbsolutePath') || str('TargetFile');
  if (target) {
    const body = str('content') || str('new_string') || str('CodeContent');
    return clip(body ? `${target}\n${body.slice(0, 400)}` : target);
  }
  const question = str('question') || str('prompt') || str('message');
  if (question) return clip(question);
  try {
    return clip(JSON.stringify(o, null, 2));
  } catch {
    return `(${toolName} input could not be shown)`;
  }
}

/**
 * Holds hook requests open until the human decides in the Needs-you sidebar.
 * It never decides by itself: on timeout the caller returns "no decision" and the agent's own prompt proceeds.
 */
export class PermissionBroker {
  private pending = new Map<string, Pending>();

  request(
    info: Omit<PermissionItem, 'id' | 'createdAt'>,
    timeoutMs: number,
  ): { id: string; outcome: Promise<PermissionOutcome> } {
    const id = randomId(9);
    const outcome = new Promise<PermissionOutcome>((resolve) => {
      const done = (o: PermissionOutcome) => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        resolve(o);
        this.changed(p.workspaceId);
      };
      const timer = setTimeout(() => done('timeout'), timeoutMs);
      timer.unref();
      this.pending.set(id, {
        ...info,
        id,
        createdAt: Date.now(),
        resolve: done,
        timer,
      });
      this.changed(info.workspaceId);
    });
    return { id, outcome };
  }

  /** The human clicked. Returns false if the request is gone (already timed out or cancelled). */
  decide(id: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(id);
    if (!p || !p.options.includes(decision)) return false;
    p.resolve(decision);
    return true;
  }

  /** The agent no longer waits (answered in the terminal, hook connection dropped). */
  cancel(id: string): void {
    this.pending.get(id)?.resolve('cancelled');
  }

  /** Drop everything for a node (it exited or was restarted). */
  cancelNode(nodeId: string): void {
    for (const p of [...this.pending.values()]) if (p.nodeId === nodeId) p.resolve('cancelled');
  }

  open(workspaceId?: string): PermissionItem[] {
    return [...this.pending.values()]
      .filter((p) => !workspaceId || p.workspaceId === workspaceId)
      .map((p) => ({
        id: p.id,
        nodeId: p.nodeId,
        workspaceId: p.workspaceId,
        source: p.source,
        toolName: p.toolName,
        detail: p.detail,
        createdAt: p.createdAt,
        options: p.options,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  hasOpen(nodeId: string): boolean {
    return [...this.pending.values()].some((p) => p.nodeId === nodeId);
  }

  private changed(workspaceId: string): void {
    // The UI already refetches the attention feed on 'questions' changes.
    hub.emitHub({ t: 'change', entity: 'questions', workspaceId });
  }
}
