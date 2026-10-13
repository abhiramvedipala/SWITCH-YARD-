import type { Store, NodeBrief, NodeState } from '../store.js';
import type { Bus } from '../bus/service.js';
import { ptys } from '../pty/manager.js';
import { getHarness } from '../harness/index.js';
import { getSetting } from '../db/index.js';

const QUIET_MS = 8_000;
const NEEDS_INPUT_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);
const NUDGE_THROTTLE_MS = 30_000;

/* eslint-disable no-control-regex -- matching terminal escape sequences is the point */
const ANSI =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g;
/* eslint-enable no-control-regex */

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '').replace(/\r/g, '');
}

/**
 * Claude Code's folder-trust dialog ("Do you trust the files in this folder?" with "1. Yes, proceed" / "2. No, exit").
 * Both the question and the first option are required so ordinary output cannot match. Checked on every terminal,
 * since a human may also start `claude` by hand in a Shell node.
 */
export const TRUST_PROMPT =
  /Do you trust the files in this folder\?[\s\S]{0,1500}\b1\.\s+Yes, proceed\b/;
export const TRUST_PROMPT_TEXT = 'Accept the folder trust prompt in this node';
/** The trust dialog is ~14 lines; the generic prompt patterns look at the last 8. */
const TRUST_LINES = 20;

/** Last `lines` non-empty screen lines; `newChars` limits the look-back to the most recent output (Infinity = all). */
export function screenTail(nodeId: string, lines = 12, newChars = Infinity): string {
  if (newChars <= 0) return '';
  const raw = ptys.scrollback(nodeId).slice(-Math.min(6000, newChars));
  return stripAnsi(raw)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-lines)
    .join('\n');
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
  /** needs_input items only: a known dialog with a one-key answer the UI can offer as a button (Accept = Enter). */
  prompt?: 'trust';
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

  /** 1 s while terminals exist (status needs to feel live), 5 s when there is nothing to watch. */
  startLoop(): void {
    if (this.timer || this.disposed) return;
    const next = () => {
      this.timer = setTimeout(
        () => {
          if (this.disposed) return;
          this.tick();
          next();
        },
        ptys.ids().length > 0 ? 1000 : 5000,
      );
      this.timer.unref();
    };
    next();
  }

  stopLoop(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  noteUserInput(nodeId: string): void {
    this.lastInputAt.set(nodeId, Date.now());
    this.scannedAt.delete(nodeId); // re-read the screen: the dismissed prompt changes the answer
    // Whatever prompt is on screen now has been answered: from here on only output written after this
    // counts, so the same dialog (still in the raw scrollback) is not re-flagged by a later line.
    const s = ptys.get(nodeId);
    if (s && this.store.getNode(nodeId)?.state === 'needs_input')
      this.answered.set(nodeId, { startedAt: s.startedAt, chars: s.totalBytes });
  }

  /** Where the human last answered a prompt, per PTY process (a respawn starts over). */
  private answered = new Map<string, { startedAt: number; chars: number }>();

  /** Screen tail limited to output since the last answered prompt. */
  private freshTail(nodeId: string, lines: number): string {
    const s = ptys.get(nodeId);
    const a = this.answered.get(nodeId);
    const since = s && a && a.startedAt === s.startedAt ? s.totalBytes - a.chars : Infinity;
    return screenTail(nodeId, lines, since);
  }

  private set(nodeId: string, state: NodeState): void {
    const prev = this.store.getNode(nodeId)?.state;
    if (prev === state) return;
    if (state === 'needs_input') this.needsInputSince.set(nodeId, Date.now());
    else this.needsInputSince.delete(nodeId);
    this.bus.setStatus(nodeId, state);
    if (state === 'idle') this.later(() => this.maybeNudge(nodeId), 500);
  }

  /** lastOutputAt of each terminal when its screen was last scanned for prompts (skip unchanged screens). */
  private scannedAt = new Map<string, number>();
  private prompting = new Map<string, false | 'prompt' | 'trust'>();

  tick(): void {
    // Iterate live terminals only (not every node row: chat nodes carry whole transcripts in data_json).
    for (const id of ptys.ids()) {
      const s = ptys.get(id);
      const n = s && this.store.getNode(id);
      if (!s || !n) continue;
      if (s.exited) {
        this.set(id, 'exited');
        continue;
      }
      if (this.scannedAt.get(id) !== s.lastOutputAt) {
        this.scannedAt.set(id, s.lastOutputAt);
        const h = getHarness(n.harness);
        const wide = this.freshTail(id, TRUST_LINES);
        const tail = wide.split('\n').slice(-8).join('\n');
        this.prompting.set(
          id,
          TRUST_PROMPT.test(wide)
            ? 'trust'
            : (h.needsInputPatterns ?? []).some((re) => re.test(tail)) && 'prompt',
        );
      }
      const prompting = !!this.prompting.get(id);
      if (prompting) {
        this.set(id, 'needs_input');
        continue;
      }
      if (n.state === 'needs_input' && !prompting) {
        // Prompt is gone from the screen: someone answered it.
        this.set(id, this.hookDriven.has(id) ? 'working' : 'idle');
      }
      if (this.hookDriven.has(id)) continue;
      const quietFor = Date.now() - s.lastOutputAt;
      const sinceStart = Date.now() - s.startedAt;
      if (quietFor < QUIET_MS && sinceStart > 1500) {
        const typedRecently = Date.now() - (this.lastInputAt.get(id) ?? 0) < 1500;
        if (!typedRecently) this.set(id, 'working');
      } else if (quietFor >= QUIET_MS) {
        this.set(id, 'idle');
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
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PreInvocation':
        this.set(nodeId, 'working');
        break;
      case 'Notification': {
        // Only these types mean "a human has to act". Anything else (auth_success, quota_*, elicitation_complete,
        // elicitation_response, unknown future types) must not flip the node to needs_input.
        const t = String(payload.notification_type ?? '');
        if (t === 'idle_prompt' || t === 'agent_completed') this.set(nodeId, 'idle');
        else if (NEEDS_INPUT_NOTIFICATIONS.has(t)) this.set(nodeId, 'needs_input');
        break;
      }
      case 'StopFailure': {
        // The turn ended with an API error: idle again, but remember why so the UI can show it.
        const err = String(payload.error ?? payload.error_type ?? 'error').slice(0, 120);
        this.store.updateNode(nodeId, { data: { ...node.data, lastError: err } }, { silent: true });
        this.set(nodeId, 'idle');
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

  /** Set by core: open permission requests are surfaced in the attention feed. */
  permissions?: import('./permissions.js').PermissionBroker;

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
    const nodes = this.store.listNodeBriefs(workspaceId);
    const byId = new Map(nodes.map((n) => [n.id, n] as [string, NodeBrief]));
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
    for (const p of this.permissions?.open(workspaceId) ?? []) {
      const n = byId.get(p.nodeId);
      if (!n) continue;
      items.push({
        kind: 'permission',
        id: p.id,
        nodeId: n.id,
        nodeTitle: n.title,
        workspaceId: n.workspaceId,
        text: p.detail,
        createdAt: p.createdAt,
        toolName: p.toolName,
        source: p.source,
        options: p.options,
      });
    }
    for (const n of nodes) {
      // A permission card already says what is needed; don't also show the raw screen for the same wait.
      if (n.state === 'needs_input' && !this.permissions?.hasOpen(n.id)) {
        const trust = this.prompting.get(n.id) === 'trust';
        items.push({
          kind: 'needs_input',
          id: `ni-${n.id}`,
          nodeId: n.id,
          nodeTitle: n.title,
          workspaceId: n.workspaceId,
          text: trust
            ? TRUST_PROMPT_TEXT
            : n.type === 'agent-terminal' || n.type === 'terminal'
              ? screenTail(n.id, 10)
              : 'Waiting for input',
          createdAt: this.needsInputSince.get(n.id) ?? Date.now(),
          ...(trust ? { prompt: 'trust' as const } : {}),
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
