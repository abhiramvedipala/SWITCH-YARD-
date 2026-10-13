import { EventEmitter } from 'node:events';

/** Everything the UI needs to hear about flows through here and out over the WebSocket. */
export type HubEvent =
  | { t: 'pty.data'; id: string; data: string }
  | { t: 'pty.exit'; id: string; code: number | null }
  | { t: 'change'; entity: string; workspaceId?: string; id?: string }
  | { t: 'status'; nodeId: string; state: string }
  | { t: 'run'; runId: string; event: unknown }
  | { t: 'chat'; nodeId: string; event: unknown };

class Hub extends EventEmitter {
  emitHub(e: HubEvent): void {
    this.emit('event', e);
  }
}

export const hub = new Hub();
hub.setMaxListeners(100);
