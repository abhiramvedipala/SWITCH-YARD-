import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Core } from '../core.js';
import { BusError } from '../bus/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    busNode?: string;
  }
}

const CLAUDE_HOOK_PREFIX = '/bus/hook/claude/';
/** One answer for every auth failure (unknown node, stale or foreign capability, wrong hook secret). */
const UNAUTHORIZED = {
  error: 'unauthorized',
  message: 'unknown node, stale capability or wrong secret',
};

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof BusError)
    return reply.code(err.status).send({ error: err.code, message: err.message });
  if (err instanceof z.ZodError)
    return reply.code(400).send({
      error: 'invalid_input',
      message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
  return reply
    .code(500)
    .send({ error: 'internal', message: String((err as Error).message ?? err) });
}

const sendSchema = z.object({
  peerId: z.string().min(1),
  intent: z.enum(['notify', 'request', 'response']),
  body: z
    .string()
    .min(1)
    .max(64 * 1024),
  responseTo: z.string().optional(),
  expiresInSec: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 3600)
    .optional(),
});

/** Routes bus-mcp calls on behalf of one agent node. Authenticated by that node's capability, never the UI token. */
export function registerBusRoutes(app: FastifyInstance, core: Core): void {
  const { bus } = core;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/bus/')) return;
    // Claude HTTP hooks cannot send our headers; they carry a per-node secret in the path instead (checked below).
    if (req.url.startsWith(CLAUDE_HOOK_PREFIX)) return;
    const nodeId = req.headers['x-switchyard-node'];
    const cap = req.headers['x-switchyard-cap'];
    if (typeof nodeId !== 'string' || typeof cap !== 'string' || !core.caps.verify(nodeId, cap)) {
      return reply.code(401).send(UNAUTHORIZED);
    }
    req.busNode = nodeId;
  });

  app.post('/bus/hook/claude/:nodeId/:secret', async (req, reply) => {
    const { nodeId, secret } = req.params as { nodeId: string; secret: string };
    // Same answer as the capability check above: a caller cannot tell which case it hit.
    if (!core.caps.verifyHook(nodeId, secret)) return reply.code(401).send(UNAUTHORIZED);
    const body =
      req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    // If Claude drops the connection (user answered in the terminal), stop waiting on a human.
    const gone = new AbortController();
    reply.raw.once('close', () => gone.abort());
    return reply.send(await core.hooks.claude(nodeId, body, gone.signal));
  });

  const wrap =
    (fn: (req: FastifyRequest, self: string) => unknown) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.send(await fn(req, req.busNode!));
      } catch (err) {
        return fail(reply, err);
      }
    };

  app.get(
    '/bus/whoami',
    wrap((_req, self) => {
      const n = core.store.getNode(self)!;
      return { nodeId: n.id, title: n.title, workspaceId: n.workspaceId, harness: n.harness };
    }),
  );
  app.get(
    '/bus/peers',
    wrap((_req, self) => ({ peers: bus.listPeers(self) })),
  );
  app.get(
    '/bus/peers/:peerId',
    wrap((req, self) => bus.getPeerContext(self, (req.params as { peerId: string }).peerId)),
  );
  app.post(
    '/bus/messages',
    wrap((req, self) => bus.sendMessage(self, sendSchema.parse(req.body))),
  );
  app.post(
    '/bus/inbox',
    wrap((req, self) => {
      const { markRead } = z.object({ markRead: z.boolean().optional() }).parse(req.body ?? {});
      return { messages: bus.checkInbox(self, markRead ?? true) };
    }),
  );
  app.post(
    '/bus/wait-reply',
    wrap((req, self) => {
      const b = z
        .object({ messageId: z.string(), timeoutSec: z.number().min(0).max(600) })
        .parse(req.body);
      return bus.waitForReply(self, b.messageId, b.timeoutSec);
    }),
  );
  app.post(
    '/bus/summary',
    wrap((req, self) =>
      bus.publishSummary(self, z.object({ text: z.string().max(800) }).parse(req.body).text),
    ),
  );
  app.get(
    '/bus/tasks',
    wrap((req, self) => ({
      tasks: bus.listTasksFor(self, (req.query as { status?: string }).status),
    })),
  );
  app.post(
    '/bus/tasks',
    wrap((req, self) => {
      const b = z
        .object({
          title: z.string().min(1).max(300),
          body: z.string().max(20_000).optional(),
          dependsOn: z.array(z.string()).optional(),
        })
        .parse(req.body);
      return bus.addTask(core.store.getNode(self)!.workspaceId, b, self);
    }),
  );
  app.post(
    '/bus/tasks/:taskId/claim',
    wrap((req, self) => bus.claimTask(self, (req.params as { taskId: string }).taskId)),
  );
  app.post(
    '/bus/tasks/:taskId/complete',
    wrap((req, self) => {
      const b = z.object({ result: z.string().max(20_000).optional() }).parse(req.body ?? {});
      return bus.completeTask(self, (req.params as { taskId: string }).taskId, b.result);
    }),
  );
  app.get(
    '/bus/nodes/:nodeId/status',
    wrap((req, self) => bus.getNodeStatus(self, (req.params as { nodeId: string }).nodeId)),
  );
  app.post(
    '/bus/wait-nodes',
    wrap((req, self) => {
      const b = z
        .object({ nodeIds: z.array(z.string()).min(1), timeoutSec: z.number().min(0).max(600) })
        .parse(req.body);
      return bus.waitForNodes(self, b.nodeIds, b.timeoutSec);
    }),
  );
  app.post(
    '/bus/ask',
    wrap((req, self) => {
      const b = z
        .object({
          question: z.string().max(4000).optional(),
          questionId: z.string().optional(),
          timeoutSec: z.number().min(0).max(600).optional(),
        })
        .parse(req.body);
      if (!b.question && !b.questionId)
        throw new BusError('missing_question', 'question or questionId is required');
      return bus.askUser(self, b);
    }),
  );
  // Rooms: an agent sees only the rooms of its own workspace; anything else is "unknown room".
  const roomFor = (self: string, roomId: string) => {
    const room = core.rooms.get(roomId);
    if (!room || room.workspaceId !== core.store.getNode(self)!.workspaceId)
      throw new BusError('unknown_room', 'no such room in your workspace', 404);
    return room;
  };
  app.get(
    '/bus/rooms',
    wrap((_req, self) => ({
      rooms: core.rooms.list(core.store.getNode(self)!.workspaceId).map((r) => ({
        roomId: r.id,
        title: r.title,
        mode: r.mode,
        participants: core.rooms.participants(r.id).map((p) => ({
          name: p.displayName,
          harness: p.harness,
        })),
      })),
    })),
  );
  app.get(
    '/bus/rooms/:roomId/messages',
    wrap((req, self) => {
      const room = roomFor(self, (req.params as { roomId: string }).roomId);
      const since = (req.query as { since?: string }).since;
      return {
        messages: core.rooms.messages(room.id, since || undefined, 200).map((m) => ({
          messageId: m.id,
          author: m.authorName,
          authorKind: m.authorKind,
          text: m.text,
          createdAt: m.createdAt,
        })),
      };
    }),
  );
  app.post(
    '/bus/rooms/:roomId/messages',
    wrap((req, self) => {
      const room = roomFor(self, (req.params as { roomId: string }).roomId);
      const { text } = z
        .object({
          text: z
            .string()
            .trim()
            .min(1)
            .max(64 * 1024),
        })
        .parse(req.body);
      const n = core.store.getNode(self)!;
      const m = core.rooms.post(room.id, { kind: 'agent', id: n.id, name: n.title }, text);
      return { messageId: m.id };
    }),
  );
  app.post(
    '/bus/agy/hook',
    wrap((req, self) => {
      const b = z
        .object({
          event: z.string().max(64),
          payload: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(req.body);
      const gone = new AbortController();
      // The socket closes only when the client really leaves (req 'close' fires once the body is read).
      req.raw.socket.once('close', () => gone.abort());
      return core.hooks.agy(self, b.event, b.payload ?? {}, gone.signal);
    }),
  );
  app.post(
    '/bus/hook',
    wrap((req, self) => {
      const b = z
        .object({
          harness: z.string(),
          event: z.string(),
          payload: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(req.body);
      core.monitor.onHook(self, b.harness, b.event, b.payload ?? {});
      return { ok: true };
    }),
  );
}
