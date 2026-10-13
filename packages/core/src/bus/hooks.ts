import type { Store } from '../store.js';
import type { Bus } from './service.js';
import type { StatusMonitor } from '../status/monitor.js';
import {
  describeToolInput,
  permissionTimeoutMs,
  type PermissionBroker,
} from '../status/permissions.js';
import {
  BlockCounter,
  claudeStopDecision,
  agyPreInvocationDecision,
  agyStopDecision,
  type Backlog,
} from './delivery.js';

type Payload = Record<string, unknown>;

/**
 * Turns hook payloads from Claude Code into (a) node status/summary updates and (b) the JSON the hook expects back.
 * Bus messages are delivered here, at turn boundaries, instead of by typing into the terminal.
 */
export class HookRouter {
  private blocks = new BlockCounter();

  constructor(
    private store: Store,
    private bus: Bus,
    private monitor: StatusMonitor,
    private permissions: PermissionBroker,
  ) {}

  backlog(nodeId: string): Backlog {
    const pending = this.bus.pendingFor(nodeId);
    const requests = pending.filter((m) => m.intent === 'request').length;
    return { requests, notifies: pending.length - requests };
  }

  /** Handle one Claude hook event for a node whose hook secret was already verified. */
  async claude(
    nodeId: string,
    payload: Payload,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const node = this.store.getNode(nodeId);
    if (!node) return {};
    // Subagent events say nothing about the node's own state or turn boundary.
    if (typeof payload.agent_id === 'string' && payload.agent_id) return {};
    const event = String(payload.hook_event_name ?? '');
    if (event === 'Stop') return this.claudeStop(nodeId, payload);
    if (event === 'PermissionRequest') return this.claudePermission(nodeId, payload, signal);
    if (event === 'UserPromptSubmit') this.blocks.reset(nodeId);
    this.monitor.onHook(nodeId, 'claude', event, payload);
    return {};
  }

  /**
   * Claude is about to show a permission prompt. Keep the hook request open and let the human decide in the sidebar.
   * Never auto-allows: on timeout or a dropped connection we answer {} so Claude's own terminal prompt takes over.
   */
  private async claudePermission(
    nodeId: string,
    payload: Payload,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const node = this.store.getNode(nodeId);
    if (!node) return {};
    const toolName = String(payload.tool_name ?? 'tool');
    const { id, outcome } = this.permissions.request(
      {
        nodeId,
        workspaceId: node.workspaceId,
        source: 'claude',
        toolName,
        detail: describeToolInput(toolName, payload.tool_input),
        options: ['allow', 'deny'],
      },
      permissionTimeoutMs('claude'),
    );
    this.monitor.setHookState(nodeId, 'needs_input');
    signal?.addEventListener('abort', () => this.permissions.cancel(id), { once: true });
    const result = await outcome;
    // Don't clobber a state that moved on (e.g. the node exited) while we waited.
    if (this.store.getNode(nodeId)?.state === 'needs_input' && !this.permissions.hasOpen(nodeId)) {
      this.monitor.setHookState(nodeId, 'working');
    }
    if (result === 'allow' || result === 'deny') {
      return {
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: result } },
      };
    }
    return {};
  }

  private claudeStop(nodeId: string, payload: Payload): Record<string, unknown> {
    const last = payload.last_assistant_message;
    if (typeof last === 'string' && last.trim()) this.bus.publishSummary(nodeId, last.trim());
    const backlog = this.backlog(nodeId);
    const decision = claudeStopDecision({
      stopHookActive: payload.stop_hook_active === true,
      backlog,
      consecutiveBlocks: this.blocks.get(nodeId),
    });
    this.blocks.record(nodeId, decision, backlog);
    // A block keeps Claude working, so the node is not idle yet.
    if (decision.blocked) this.monitor.setHookState(nodeId, 'working');
    else this.monitor.onHook(nodeId, 'claude', 'Stop', payload);
    return decision.output;
  }

  /** Handle one Antigravity hook event (capability-authenticated; node already resolved by the relay). */
  async agy(
    nodeId: string,
    event: string,
    payload: Payload,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.store.getNode(nodeId)) return {};
    const key = typeof payload.conversationId === 'string' ? payload.conversationId : nodeId;
    const backlog = this.backlog(nodeId);
    switch (event) {
      case 'PreInvocation': {
        this.monitor.onHook(nodeId, 'agy', 'PreInvocation', payload);
        return agyPreInvocationDecision(backlog).output;
      }
      case 'Stop': {
        const fullyIdle = payload.fullyIdle === true;
        const d = agyStopDecision({
          fullyIdle,
          backlog,
          consecutiveBlocks: this.blocks.get(key),
        });
        this.blocks.record(key, d, backlog);
        // Only a fully idle agent is idle; a Stop in the middle of a multi-execution turn is still working.
        if (fullyIdle && !d.blocked) this.monitor.onHook(nodeId, 'agy', 'Stop', payload);
        else this.monitor.setHookState(nodeId, 'working');
        return d.output;
      }
      case 'PreToolUse':
        return this.agyPermission(nodeId, payload, signal);
      default:
        this.monitor.onHook(nodeId, 'agy', event, payload);
        return {};
    }
  }

  /**
   * agy asks the human (ask_permission / ask_question). Hold the hook open so the sidebar can answer it.
   * Default and timeout answer is "ask", which leaves the prompt to agy's own terminal UI. Never auto-allows.
   */
  private async agyPermission(
    nodeId: string,
    payload: Payload,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const call = (payload.toolCall ?? {}) as { name?: string; args?: unknown };
    const name = String(call.name ?? '');
    if (name !== 'ask_permission' && name !== 'ask_question') return {};
    const node = this.store.getNode(nodeId);
    if (!node) return {};
    const { id, outcome } = this.permissions.request(
      {
        nodeId,
        workspaceId: node.workspaceId,
        source: 'agy',
        toolName: name,
        detail: describeToolInput(name, call.args),
        options: ['allow', 'deny', 'ask'],
      },
      permissionTimeoutMs('agy'),
    );
    this.monitor.setHookState(nodeId, 'needs_input');
    signal?.addEventListener('abort', () => this.permissions.cancel(id), { once: true });
    const result = await outcome;
    if (this.store.getNode(nodeId)?.state === 'needs_input' && !this.permissions.hasOpen(nodeId)) {
      this.monitor.setHookState(nodeId, 'working');
    }
    const decision = result === 'allow' || result === 'deny' ? result : 'ask';
    return {
      decision,
      reason:
        decision === 'ask'
          ? 'Left to the terminal prompt.'
          : `Decided by the human in Switchyard (${decision}).`,
    };
  }

  forget(nodeId: string): void {
    this.blocks.reset(nodeId);
  }
}
