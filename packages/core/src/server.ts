import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { loadOrCreateUiToken, constantTimeEqual } from './auth/token.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST_DIR = resolve(__dirname, '../../web/dist');

const HOST = '127.0.0.1'; // never 0.0.0.0 — see hard safety rule #3
const PORT = Number(process.env.SWITCHYARD_PORT ?? 4777);

export async function buildServer() {
  const { token, created } = loadOrCreateUiToken();
  if (created) {
    console.log(
      `\nSwitchyard UI token (shown once, also saved to ~/.switchyard/ui-session):\n  ${token}\n`,
    );
  }

  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, {
    root: WEB_DIST_DIR,
    prefix: '/',
    index: ['index.html'],
  });

  function isAuthorized(authHeader: string | undefined): boolean {
    if (!authHeader?.startsWith('Bearer ')) return false;
    const presented = authHeader.slice('Bearer '.length).trim();
    return constantTimeEqual(presented, token);
  }
  app.decorate('isAuthorized', isAuthorized);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/auth/login') return;
    if (!isAuthorized(req.headers.authorization)) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.post<{ Body: { token?: string } }>('/api/auth/login', async (req, reply) => {
    const presented = req.body?.token ?? '';
    if (constantTimeEqual(presented, token)) {
      return reply.send({ ok: true });
    }
    return reply.code(401).send({ ok: false, error: 'invalid_token' });
  });

  app.get('/api/auth/check', async (_req, reply) => {
    return reply.send({ ok: true });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.sendFile('index.html', WEB_DIST_DIR);
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  return app;
}

async function main() {
  const app = await buildServer();
  await app.listen({ host: HOST, port: PORT });
  console.log(`Switchyard core listening on http://${HOST}:${PORT}`);
}

// Only auto-start when run directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
