import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { hub, type HubEvent } from './events.js';
import { ptys } from './pty/manager.js';
import { constantTimeEqual } from './auth/token.js';

export interface WsDeps {
  token: string;
  isRemote: (req: FastifyRequest) => boolean;
  remoteReadOnly: () => boolean;
  onUserInput: (nodeId: string) => void;
  canAttach: (nodeId: string) => boolean;
  ensureStarted: (nodeId: string, cols?: number, rows?: number) => void;
}

/** Same-origin check: a page on another site can't open our socket even though WS ignores CORS. */
export function originAllowed(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients
  try {
    const o = new URL(origin);
    const hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean);
    if (hosts.includes(o.host)) return true;
    // Loopback, or a Tailscale MagicDNS name (tailscale serve may rewrite Host when proxying).
    // The socket still needs the UI token in its first message, so this is defense in depth.
    return (
      o.hostname === '127.0.0.1' || o.hostname === 'localhost' || o.hostname.endsWith('.ts.net')
    );
  } catch {
    return false;
  }
}

/** A `https://<machine>.<tailnet>.ts.net` origin, i.e. the page was served through Tailscale Serve. */
export function isTailnetOrigin(req: FastifyRequest): boolean {
  try {
    return new URL(req.headers.origin ?? '').hostname.endsWith('.ts.net');
  } catch {
    return false;
  }
}

export function registerWs(app: FastifyInstance, deps: WsDeps): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    // A remote upgrade only reaches this handler after the server's onRequest hook verified its
    // tailnet identity, so `remote` here means "verified remote". A ts.net origin without that
    // (e.g. any Funnel-published page on the internet) is refused.
    const remote = deps.isRemote(req);
    if (!originAllowed(req) || (isTailnetOrigin(req) && !remote)) {
      socket.close(4403, 'origin not allowed');
      return;
    }
    let authed = false;
    const authTimer = setTimeout(() => !authed && socket.close(4401, 'auth timeout'), 5000);
    const send = (obj: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
    };
    const onEvent = (e: HubEvent) => send(e);

    socket.on('message', (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!authed) {
        if (
          msg.t === 'auth' &&
          typeof msg.token === 'string' &&
          constantTimeEqual(msg.token, deps.token)
        ) {
          authed = true;
          clearTimeout(authTimer);
          hub.on('event', onEvent);
          send({ t: 'hello', remote, readOnly: remote && deps.remoteReadOnly() });
        } else {
          socket.close(4401, 'bad token');
        }
        return;
      }
      const id = typeof msg.id === 'string' ? msg.id : '';
      switch (msg.t) {
        case 'pty.attach': {
          if (!deps.canAttach(id)) return;
          deps.ensureStarted(id, Number(msg.cols) || undefined, Number(msg.rows) || undefined);
          send({ t: 'pty.replay', id, data: ptys.scrollback(id), alive: ptys.isAlive(id) });
          break;
        }
        case 'pty.input': {
          if (remote && deps.remoteReadOnly()) return;
          if (typeof msg.data === 'string' && ptys.write(id, msg.data)) deps.onUserInput(id);
          break;
        }
        case 'pty.resize': {
          if (remote && deps.remoteReadOnly()) return;
          ptys.resize(id, Number(msg.cols), Number(msg.rows));
          break;
        }
        case 'ping':
          send({ t: 'pong' });
          break;
      }
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      hub.off('event', onEvent);
    });
  });
}
