import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { loadOrCreateUiToken, constantTimeEqual } from './auth/token.js';
import { WEB_DIST_DIR } from './paths.js';
import { createCore, type Core } from './core.js';
import { registerBusRoutes } from './api/bus.js';
import { registerUiRoutes } from './api/ui.js';
import { registerWs } from './ws.js';
import { getSetting } from './db/index.js';
import { ptys } from './pty/manager.js';

const HOST = '127.0.0.1'; // never 0.0.0.0 — hard safety rule #3

/**
 * Anything that didn't come straight from this machine's loopback is "remote" (e.g. a phone via `tailscale serve`,
 * which proxies to 127.0.0.1 but adds forwarding headers / a non-loopback Host).
 */
export function isRemoteRequest(req: FastifyRequest, port: number): boolean {
  if (
    req.headers['x-forwarded-for'] ||
    req.headers['tailscale-user-login'] ||
    req.headers['x-forwarded-host']
  )
    return true;
  const host = (req.headers.host ?? '').toLowerCase();
  return !(
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === '127.0.0.1' ||
    host === 'localhost'
  );
}

class LoginLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max = 8,
    private windowMs = 60_000,
  ) {}
  allow(key: string): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.hits.set(key, arr);
    return arr.length <= this.max;
  }
}

export async function buildServer(opts: { port?: number; dbPath?: string; quiet?: boolean } = {}) {
  const port = opts.port ?? Number(process.env.SWITCHYARD_PORT ?? 4777);
  const { token, created } = loadOrCreateUiToken();
  if (created && !opts.quiet) {
    console.log(
      `\nSwitchyard UI token (shown once, also saved to ~/.switchyard/ui-session):\n  ${token}\n`,
    );
  }
  const coreUrl = `http://${HOST}:${port}`;
  const core: Core = createCore({ dbPath: opts.dbPath, coreUrl });
  const isRemote = (req: FastifyRequest) => isRemoteRequest(req, port);
  const limiter = new LoginLimiter();

  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  await app.register(fastifyWebsocket);
  if (existsSync(WEB_DIST_DIR)) {
    await app.register(fastifyStatic, { root: WEB_DIST_DIR, prefix: '/', index: ['index.html'] });
  }

  const isAuthorized = (authHeader: string | undefined) => {
    if (!authHeader?.startsWith('Bearer ')) return false;
    return constantTimeEqual(authHeader.slice('Bearer '.length).trim(), token);
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/auth/login') return;
    if (!isAuthorized(req.headers.authorization))
      return reply.code(401).send({ error: 'unauthorized' });
  });

  app.post<{ Body: { token?: string } }>('/api/auth/login', async (req, reply) => {
    const key = String(req.headers['x-forwarded-for'] ?? req.ip);
    if (!limiter.allow(key)) return reply.code(429).send({ ok: false, error: 'too_many_attempts' });
    if (constantTimeEqual(String(req.body?.token ?? ''), token)) return reply.send({ ok: true });
    return reply.code(401).send({ ok: false, error: 'invalid_token' });
  });
  app.get('/api/auth/check', async (req, reply) =>
    reply.send({
      ok: true,
      remote: isRemote(req),
      readOnly: isRemote(req) && getSetting(core.db, 'remoteReadOnly', true),
    }),
  );

  registerBusRoutes(app, core);
  registerUiRoutes(app, core, { isRemote });
  registerWs(app, {
    token,
    isRemote,
    remoteReadOnly: () => getSetting(core.db, 'remoteReadOnly', true),
    onUserInput: (id) => core.monitor.noteUserInput(id),
    canAttach: (id) => {
      const n = core.store.getNode(id);
      return !!n && core.nodes.isPtyNode(n);
    },
    ensureStarted: (id, cols, rows) => {
      const n = core.store.getNode(id);
      // Plain shells come back automatically after a core restart; agents wait for an explicit Restart.
      if (n && n.type === 'terminal' && !ptys.has(id)) {
        try {
          core.nodes.start(id, { cols, rows });
        } catch {
          // folder may be gone; the node shows as exited
        }
      }
    },
  });

  app.setNotFoundHandler((req, reply) => {
    if (
      req.method === 'GET' &&
      !req.url.startsWith('/api/') &&
      !req.url.startsWith('/bus/') &&
      existsSync(WEB_DIST_DIR)
    ) {
      return reply.sendFile('index.html', WEB_DIST_DIR);
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  app.addHook('onClose', async () => {
    core.monitor.stopLoop();
    ptys.killAll();
    core.db.close();
  });

  return { app, core, token, port };
}

async function main() {
  const { app, core, port } = await buildServer();
  core.monitor.startLoop();
  void core.refreshDetections();
  await app.listen({ host: HOST, port });
  console.log(`Switchyard core listening on http://${HOST}:${port}`);
  const shutdown = () => {
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
