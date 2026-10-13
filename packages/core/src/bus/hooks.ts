import type { Store } from '../store.js';
import type { Bus } from './service.js';
import type { StatusMonitor } from '../status/monitor.js';
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
  ) {}

  backlog(nodeId: string): Backlog {
    const pending = this.bus.pendingFor(nodeId);
    const requests = pending.filter((m) => m.intent === 'request').length;
    return { requests, notifies: pending.length - requests };
  }

  /** Handle one Claude hook event for a node whose hook secret was already verified. */
  async claude(nodeId: string, payload: Payload): Promise<Record<string, unknown>> {
    const node = this.store.getNode(nodeId);
    if (!node) return {};
    // Subagent events say nothing about the node's own state or turn boundary.
    if (typeof payload.agent_id === 'string' && payload.agent_id) return {};
    const event = String(payload.hook_event_name ?? '');
    if (event === 'Stop') return this.claudeStop(nodeId, payload);
    if (event === 'UserPromptSubmit') this.blocks.reset(nodeId);
    this.monitor.onHook(nodeId, 'claude', event, payload);
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
  async agy(nodeId: string, event: string, payload: Payload): Promise<Record<string, unknown>> {
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
      default:
        this.monitor.onHook(nodeId, 'agy', event, payload);
        return {};
    }
  }

  forget(nodeId: string): void {
    this.blocks.reset(nodeId);
  }
}
