import { getToken } from './api.js';

export type ServerEvent =
  | { t: 'hello'; remote: boolean; readOnly: boolean }
  | { t: 'pty.data'; id: string; data: string }
  | { t: 'pty.replay'; id: string; data: string; alive: boolean }
  | { t: 'pty.exit'; id: string; code: number | null }
  | { t: 'change'; entity: string; workspaceId?: string; id?: string }
  | { t: 'status'; nodeId: string; state: string }
  | { t: 'run'; runId: string; event: unknown }
  | {
      t: 'chat';
      nodeId: string;
      event: { type: string; replyId?: string; delta?: string; message?: unknown; tool?: unknown };
    }
  | {
      t: 'room';
      roomId: string;
      event: {
        type: string;
        participantId?: string;
        replyId?: string;
        delta?: string;
        message?: unknown;
        busy?: boolean;
        error?: string | null;
      };
    }
  | { t: 'pong' };

type Listener = (e: ServerEvent) => void;

/** One authenticated socket for the whole UI; reconnects and re-attaches terminals after drops. */
class Socket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private attached = new Map<string, { cols?: number; rows?: number }>();
  private queue: string[] = [];
  private ready = false;
  private retry = 0;
  connected = false;
  private statusListeners = new Set<(c: boolean) => void>();

  connect(): void {
    if (this.ws) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'auth', token: getToken() }));
    };
    ws.onmessage = (m) => {
      let e: ServerEvent;
      try {
        e = JSON.parse(String(m.data)) as ServerEvent;
      } catch {
        return;
      }
      if (e.t === 'hello') {
        this.ready = true;
        this.retry = 0;
        this.setConnected(true);
        for (const [id, size] of this.attached) this.sendNow({ t: 'pty.attach', id, ...size });
        for (const q of this.queue.splice(0)) ws.send(q);
      }
      for (const l of this.listeners) l(e);
    };
    ws.onclose = () => {
      this.ws = null;
      this.ready = false;
      this.setConnected(false);
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private setConnected(c: boolean) {
    this.connected = c;
    for (const l of this.statusListeners) l(c);
  }

  onStatus(fn: (c: boolean) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private sendNow(obj: unknown) {
    this.ws?.send(JSON.stringify(obj));
  }

  send(obj: Record<string, unknown>): void {
    const s = JSON.stringify(obj);
    if (this.ready && this.ws) this.ws.send(s);
    else if (obj.t !== 'pty.input') this.queue.push(s);
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private refs = new Map<string, number>();

  attach(id: string, cols?: number, rows?: number): void {
    this.refs.set(id, (this.refs.get(id) ?? 0) + 1);
    this.attached.set(id, { cols, rows });
    if (this.ready) this.sendNow({ t: 'pty.attach', id, cols, rows });
  }

  detach(id: string): void {
    const n = (this.refs.get(id) ?? 1) - 1;
    if (n <= 0) {
      this.refs.delete(id);
      this.attached.delete(id);
    } else this.refs.set(id, n);
  }
}

export const socket = new Socket();
