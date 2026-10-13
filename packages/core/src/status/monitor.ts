import type { Store, NodeRec, NodeState } from '../store.js';
import type { Bus } from '../bus/service.js';
import { ptys } from '../pty/manager.js';
import { getHarness } from '../harness/index.js';
import { getSetting } from '../db/index.js';

const QUIET_MS = 8_000;
const NUDGE_THROTTLE_MS = 30_000;

/* eslint-disable no-control-regex -- matching terminal escape sequences is the point */
const ANSI =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g;
/* eslint-enable no-control-regex */

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '').replace(/\r/g, '');
}

export function screenTail(nodeId: string, lines = 12): string {
  const raw = ptys.scrollback(nodeId).slice(-6000);
  return stripAnsi(raw)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-lines)
    .join('\n');
}

export interface AttentionItem {
  kind: 'question' | 'needs_input' | 'unread';
  id: string;
  nodeId: string;
  nodeTitle: string;
  workspaceId: string;
  text: string;
  createdAt: number;
  count?: number;
}

/**
 * Decides working / idle / needs_input for terminal agents.
 * Claude: hooks are authoritative for working/idle; PTY prompt patterns flag needs_input fast.
 * agy / mock / shell: quiet heuristic (no output for 8s => idle) + prompt patterns, unless agy hooks report in.
 */
export class StatusMonitor {
  private hookDriven = new Set<string>();
  private lastInputAt = new Map<string, number>();
  private lastNudgeAt = new Map<string, number>();
  private needsInputSince = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private bus: Bus,
  ) {
    bus.onMessageFor((nodeId) => this.later(() => this.maybeNudge(nodeId), 250));
  }

  private disposed = false;

  /** Deferred work that must not outlive the monitor (the DB closes on shutdown). */
  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      if (this.disposed) return;
      try {
        fn();
      } catch {
        // node may have been deleted in the meantime
      }
    }, ms);
    t.unref();
  }

  startLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  stopLoop(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  noteUserInput(nodeId: string): void {
    this.lastInputAt.set(nodeId, Date.now());
    // Whatever prompt is on screen now has been answered; don't re-flag it until the screen changes.
    if (this.store.getNode(nodeId)?.state === 'needs_input')
      this.dismissedTail.set(nodeId, screenTail(nodeId, 8));
  }

  private dismissedTail = new Map<string, string>();

  private set(nodeId: string, state: NodeState): void {
    const prev = this.store.getNode(nodeId)?.state;
    if (prev === state) return;
    if (state === 'needs_input') this.needsInputSince.set(nodeId, Date.now());
    else this.needsInputSince.delete(nodeId);
    this.bus.setStatus(nodeId, state);
    if (state === 'idle') this.later(() => this.maybeNudge(nodeId), 500);
  }

  tick(): void {
    for (const n of this.store.allNodes()) {
      if (n.type !== 'agent-terminal' && n.type !== 'terminal') continue;
      const s = ptys.get(n.id);
      if (!s) continue;
      if (s.exited) {
        this.set(n.id, 'exited');
        continue;
      }
      const h = getHarness(n.harness);
      const tail = screenTail(n.id, 8);
      const prompting =
        tail !== this.dismissedTail.get(n.id) &&
        (h.needsInputPatterns ?? []).some((re) => re.test(tail));
      if (prompting) {
        this.set(n.id, 'needs_input');
        continue;
      }
      if (n.state === 'needs_input' && !prompting) {
        // Prompt is gone from the screen: someone answered it.
        this.set(n.id, this.hookDriven.has(n.id) ? 'working' : 'idle');
      }
      if (this.hookDriven.has(n.id)) continue;
      const quietFor = Date.now() - s.lastOutputAt;
      const sinceStart = Date.now() - s.startedAt;
      if (quietFor < QUIET_MS && sinceStart > 1500) {
        const typedRecently = Date.now() - (this.lastInputAt.get(n.id) ?? 0) < 1500;
        if (!typedRecently) this.set(n.id, 'working');
      } else if (quietFor >= QUIET_MS) {
        this.set(n.id, 'idle');
      }
    }
  }

  /** Set a node's state from an authoritative hook decision (marks the node hook-driven). */
  setHookState(nodeId: string, state: NodeState): void {
    if (!this.store.getNode(nodeId)) return;
    this.hookDriven.add(nodeId);
    this.set(nodeId, state);
  }

  /** Hook relay events from agents (POST /bus/hook). */
  onHook(nodeId: string, harness: string, event: string, payload: Record<string, unknown>): void {
    const node = this.store.getNode(nodeId);
    if (!node) return;
    this.hookDriven.add(nodeId);
    const sessionId =
      (payload.session_id as string | undefined) ?? (payload.conversationId as string | undefined);
    if (
      sessionId &&
      node.sessionRef !== sessionId &&
      (event === 'SessionStart' || !node.sessionRef)
    ) {
      this.store.updateNode(nodeId, { sessionRef: sessionId }, { silent: true });
    }
    switch (event) {
      case 'SessionStart':
        this.set(nodeId, 'idle');
        break;
      case 'UserPromptSubmit':
      case 'PostToolUse':
      case 'PreInvocation':
        this.set(nodeId, 'working');
        break;
      case 'Notification': {
        const t = String(payload.notification_type ?? '');
        if (t === 'idle_prompt' || t === 'agent_completed') this.set(nodeId, 'idle');
        else if (
          t !== 'auth_success' &&
          !t.startsWith('quota_') &&
          t !== 'elicitation_complete' &&
          t !== 'elicitation_response'
        ) {
          this.set(nodeId, 'needs_input');
        }
        break;
      }
      case 'Stop':
        this.set(nodeId, 'idle');
        break;
      case 'SessionEnd':
        this.set(nodeId, 'exited');
        break;
    }
    void harness;
  }

  /** How many PTY nudges were typed since start (tests assert this stays 0 on the hook path). */
  nudgeCount = 0;

  /** Whether a PTY nudge may be typed into this node right now. Last resort only. */
  canNudge(nodeId: string): boolean {
    const n = this.store.getNode(nodeId);
    if (!n || n.type !== 'agent-terminal' || n.state !== 'idle') return false;
    if (!getSetting(this.store.db, 'autoNudge', true)) return false;
    if (n.data.autoNudge === false) return false;
    // Claude is served by its Stop hook; typing is opt-in per node.
    if (n.harness === 'claude' && n.data.autoNudge !== true) return false;
    // Only where "idle" is authoritative (hook-driven) or the mock; never on the quiet-output guess.
    if (n.harness !== 'mock' && !this.hookDriven.has(nodeId)) return false;
    return ptys.isAlive(nodeId);
  }

  /** Queued delivery of last resort: poke an idle agent terminal that has unread messages. */
  maybeNudge(nodeId: string): void {
    if (!this.canNudge(nodeId)) return;
    const pending = this.bus.pendingFor(nodeId).length;
    if (pending === 0) return;
    const last = this.lastNudgeAt.get(nodeId) ?? 0;
    if (Date.now() - last < NUDGE_THROTTLE_MS) return;
    this.lastNudgeAt.set(nodeId, Date.now());
    this.nudgeCount++;
    const text = `[switchyard] ${pending} new message${pending === 1 ? '' : 's'} — call check_inbox`;
    ptys.write(nodeId, text);
    setTimeout(() => ptys.write(nodeId, '\r'), 150);
  }

  attention(workspaceId?: string): AttentionItem[] {
    const items: AttentionItem[] = [];
    const nodes = workspaceId ? this.store.listNodes(workspaceId) : this.store.allNodes();
    const byId = new Map(nodes.map((n) => [n.id, n] as [string, NodeRec]));
    for (const q of this.bus.openQuestions(workspaceId)) {
      const n = byId.get(q.nodeId);
      if (!n) continue;
      items.push({
        kind: 'question',
        id: q.id,
        nodeId: n.id,
        nodeTitle: n.title,
        workspaceId: n.workspaceId,
        text: q.text,
        createdAt: q.createdAt,
      });
    }
    for (const n of nodes) {
      if (n.state === 'needs_input') {
        items.push({
          kind: 'needs_input',
          id: `ni-${n.id}`,
          nodeId: n.id,
          nodeTitle: n.title,
          workspaceId: n.workspaceId,
          text:
            n.type === 'agent-terminal' || n.type === 'terminal'
              ? screenTail(n.id, 10)
              : 'Waiting for input',
          createdAt: this.needsInputSince.get(n.id) ?? Date.now(),
        });
      }
      if ((n.type === 'agent-terminal' || n.type === 'agent-chat') && n.state === 'idle') {
        const count = this.bus.pendingFor(n.id).length;
        if (count > 0) {
          items.push({
            kind: 'unread',
            id: `un-${n.id}`,
            nodeId: n.id,
            nodeTitle: n.title,
            workspaceId: n.workspaceId,
            text: `${count} unread message${count === 1 ? '' : 's'} while idle`,
            createdAt: Date.now(),
            count,
          });
        }
      }
    }
    return items.sort((a, b) => a.createdAt - b.createdAt);
  }
}
