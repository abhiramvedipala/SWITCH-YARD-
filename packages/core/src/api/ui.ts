import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Core } from '../core.js';
import { BusError } from '../bus/service.js';
import { ptys } from '../pty/manager.js';
import { hub } from '../events.js';
import { planReply, rawKeyBytes } from '../pty/input.js';
import { getSetting, setSetting } from '../db/index.js';
import {
  ensureAgyMcpEntry,
  removeAgyMcpEntry,
  installAgyHooks,
  removeAgyHooks,
  hasAgyHooks,
  hasAgyMcpEntry,
  closeAgySessions,
} from '../harness/agy.js';
import { DEFAULT_ALLOWED_TOOLS } from '../chat/service.js';
import { PROVIDERS, keyStatus, removeKey, writeKey } from '../harness/api.js';
import { harnesses } from '../harness/index.js';
import { listClaudeSessions } from '../sessions/claude.js';
import { listAgySessions } from '../sessions/agy.js';
import { parseExport, conversationToMarkdown } from '../sessions/exports.js';
import { runCapture } from '../harness/util.js';
import { scratchRoot, assertSafeCwd } from '../paths.js';
import {
  addAllowRules,
  removeAllowRules,
  allowRuleState,
  BUS_RULE,
  TEST_COMMAND_RULE,
  writeRuleFor,
} from '../harness/agy-settings.js';
import {
  desktopStatus,
  connectClaudeDesktop,
  removeClaudeDesktop,
} from '../harness/claude-desktop.js';
import type { NodeType } from '../store.js';
import { usageSummary } from '../usage/index.js';

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof BusError)
    return reply.code(err.status).send({ error: err.code, message: err.message });
  if (err instanceof z.ZodError) {
    return reply.code(400).send({
      error: 'invalid_input',
      message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
  }
  return reply.code(400).send({ error: 'failed', message: String((err as Error).message ?? err) });
}

const NODE_TYPES = ['terminal', 'agent-terminal', 'agent-chat', 'note', 'doc', 'browser'] as const;

export const SETTINGS_DEFAULTS = {
  autoNudge: true,
  remoteReadOnly: true,
  remoteOwnerLogin: '', // pinned by the first verified phone login; only clearable from the computer
  macNotifications: false, // macOS banner for each new question/permission/prompt; only changeable on the computer
  projectChatHarness: 'agy',
  runTestsForEvidence: true,
  allowedTools: DEFAULT_ALLOWED_TOOLS,
  defaultBuilder: 'claude',
  defaultReviewer: 'agy',
  // F8: one long-lived agy process per chat node / run step. Off until a real agy has been run in this mode.
  agyPersistentSessions: false,
};

export interface UiDeps {
  isRemote: (req: FastifyRequest) => boolean;
}

/** Endpoints a read-only (remote) session may still call: answering the human-needed items. */
const REMOTE_WRITE_ALLOW = [
  /^\/api\/auth\//,
  /^\/api\/questions\/[^/]+\/(answer|dismiss)$/,
  /^\/api\/nodes\/[^/]+\/reply$/,
  /^\/api\/permissions\/[^/]+\/decide$/,
];

export function registerUiRoutes(app: FastifyInstance, core: Core, deps: UiDeps): void {
  const { store, bus, nodes, chat, runs, monitor } = core;

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.method === 'GET' || req.method === 'HEAD') return;
    if (!deps.isRemote(req) || !getSetting(core.db, 'remoteReadOnly', true)) return;
    const path = req.url.split('?')[0]!;
    if (REMOTE_WRITE_ALLOW.some((re) => re.test(path))) return;
    return reply.code(403).send({
      error: 'read_only',
      message: 'Remote access is read-only. Turn it off in Settings on the computer itself.',
    });
  });

  const h =
    (fn: (req: FastifyRequest) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.send((await fn(req)) ?? { ok: true });
      } catch (err) {
        return fail(reply, err);
      }
    };
  const p = <T>(req: FastifyRequest) => req.params as T;

  // ---------------------------------------------------------------- meta
  app.get(
    '/api/meta',
    h((req) => ({
      remote: deps.isRemote(req),
      readOnly: deps.isRemote(req) && getSetting(core.db, 'remoteReadOnly', true),
      home: homedir(),
      scratchDir: scratchRoot(),
      platform: process.platform,
    })),
  );

  // ---------------------------------------------------------------- settings
  app.get(
    '/api/settings',
    h(() => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) out[k] = getSetting(core.db, k, v);
      return out;
    }),
  );
  app.patch(
    '/api/settings',
    h((req) => {
      const body = z.record(z.string(), z.unknown()).parse(req.body);
      for (const [k, v] of Object.entries(body)) {
        if (!(k in SETTINGS_DEFAULTS)) throw new Error(`unknown setting ${k}`);
        if (k === 'remoteReadOnly' && deps.isRemote(req))
          throw new Error('remote read-only can only be changed on the computer itself');
        if (k === 'macNotifications' && deps.isRemote(req))
          throw new Error('Mac notifications can only be changed on the computer itself');
        if (k === 'remoteOwnerLogin' && (deps.isRemote(req) || v !== ''))
          throw new Error(
            'the remote owner is pinned by the first verified phone login; it can only be cleared, on the computer itself',
          );
        setSetting(core.db, k, v);
      }
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------------- harnesses
  app.get(
    '/api/harnesses',
    h(async (req) => {
      if ((req.query as { refresh?: string }).refresh || Object.keys(core.detections).length === 0)
        await core.refreshDetections();
      return {
        detections: core.detections,
        available: runs.available,
        agy: { mcpEntry: hasAgyMcpEntry(), hooks: hasAgyHooks(), permissions: allowRuleState() },
      };
    }),
  );
  app.post(
    '/api/agy/mcp',
    h((req) => {
      const { action } = z.object({ action: z.enum(['install', 'remove']) }).parse(req.body);
      if (action === 'install') ensureAgyMcpEntry();
      else removeAgyMcpEntry();
      return { mcpEntry: hasAgyMcpEntry() };
    }),
  );
  app.post(
    '/api/agy/hooks',
    h((req) => {
      const { action } = z.object({ action: z.enum(['install', 'remove']) }).parse(req.body);
      if (action === 'install') installAgyHooks();
      else removeAgyHooks();
      return { hooks: hasAgyHooks() };
    }),
  );
  /** Opt-in allow rules in agy's global settings.json. Each call is one explicit click in Settings. */
  app.post(
    '/api/agy/permissions',
    h((req) => {
      const b = z
        .object({
          action: z.enum(['allow-bus', 'allow-tests', 'remove']),
          dir: z.string().optional(),
        })
        .parse(req.body);
      if (b.action === 'allow-bus') addAllowRules([BUS_RULE]);
      else if (b.action === 'allow-tests') {
        if (!b.dir) throw new Error('allow-tests needs the folder agents may write in');
        // Same guard as everything else: never grant write access inside the app's own folders.
        assertSafeCwd(b.dir);
        addAllowRules([TEST_COMMAND_RULE, writeRuleFor(resolve(b.dir))]);
      } else removeAllowRules();
      return allowRuleState();
    }),
  );

  // ---------------------------------------------------------------- API keys
  // Opt-in API-key chat participants. Keys live only in ~/.switchyard/keys/<provider> (0600); no route ever returns
  // one (status is configured + last 4). Computer only, like remoteReadOnly: a phone session can't read or set them.
  const keyRoute =
    (fn: (provider: (typeof PROVIDERS)[number], req: FastifyRequest) => void) =>
    async (req: FastifyRequest) => {
      if (deps.isRemote(req))
        throw new BusError(
          'local_only',
          'API keys can only be managed on the computer itself.',
          403,
        );
      const provider = z.enum(PROVIDERS).parse(p<{ provider: string }>(req).provider);
      fn(provider, req);
      // Only this harness's detection changes; no need to re-probe the CLIs.
      core.detections[`api-${provider}`] = await harnesses[`api-${provider}`].detect();
      return keyStatus(provider);
    };
  app.get(
    '/api/keys',
    h((req) => {
      if (deps.isRemote(req))
        throw new BusError(
          'local_only',
          'API keys can only be managed on the computer itself.',
          403,
        );
      return Object.fromEntries(PROVIDERS.map((pr) => [pr, keyStatus(pr)]));
    }),
  );
  app.post(
    '/api/keys/:provider',
    h(
      keyRoute((provider, req) =>
        writeKey(provider, z.object({ key: z.string().max(1000) }).parse(req.body).key),
      ),
    ),
  );
  app.delete('/api/keys/:provider', h(keyRoute((provider) => removeKey(provider))));

  /** Opt-in Claude Desktop connector (Settings card). Writes outside the repo, so only from the computer itself. */
  app.get(
    '/api/claude-desktop',
    h(() => desktopStatus(core)),
  );
  app.post(
    '/api/claude-desktop',
    h((req) => {
      if (deps.isRemote(req))
        throw new Error('Claude Desktop can only be connected or removed on the computer itself');
      const b = z
        .object({ action: z.enum(['connect', 'remove']), workspaceId: z.string().optional() })
        .parse(req.body);
      if (b.action === 'remove') return removeClaudeDesktop(core);
      if (!b.workspaceId) throw new Error('pick the workspace Claude Desktop joins');
      return connectClaudeDesktop(core, b.workspaceId);
    }),
  );

  // ---------------------------------------------------------------- filesystem (folder picker)
  app.get(
    '/api/fs/list',
    h((req) => {
      const q = req.query as { path?: string };
      const dir = resolve(q.path || homedir());
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('not a folder');
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 500);
      return { path: dir, parent: dirname(dir) !== dir ? dirname(dir) : null, dirs: entries };
    }),
  );
  app.post(
    '/api/fs/mkdir',
    h((req) => {
      const { path } = z.object({ path: z.string().min(1) }).parse(req.body);
      mkdirSync(resolve(path), { recursive: true });
      return { path: resolve(path) };
    }),
  );

  // ---------------------------------------------------------------- workspaces
  app.get(
    '/api/workspaces',
    h(() => ({ workspaces: store.listWorkspaces() })),
  );
  app.post(
    '/api/workspaces',
    h((req) => {
      const b = z
        .object({ name: z.string().min(1).max(100).optional(), rootDir: z.string().min(1) })
        .parse(req.body);
      const root = resolve(b.rootDir);
      if (!existsSync(root) || !statSync(root).isDirectory())
        throw new Error(`folder does not exist: ${root}`);
      return store.createWorkspace(b.name?.trim() || basename(root) || root, root);
    }),
  );
  app.patch(
    '/api/workspaces/:id',
    h((req) => {
      const b = z
        .object({ name: z.string().min(1).max(100).optional(), rootDir: z.string().optional() })
        .parse(req.body);
      store.updateWorkspace(p<{ id: string }>(req).id, b);
      return store.getWorkspace(p<{ id: string }>(req).id);
    }),
  );
  app.delete(
    '/api/workspaces/:id',
    h((req) => {
      const id = p<{ id: string }>(req).id;
      for (const n of store.listNodes(id)) nodes.remove(n.id);
      store.deleteWorkspace(id);
    }),
  );
  app.get(
    '/api/workspaces/:id/graph',
    h((req) => {
      const id = p<{ id: string }>(req).id;
      if (!store.getWorkspace(id)) throw new Error('unknown workspace');
      const list = store.listNodes(id).filter((n) => !n.data.project);
      return {
        workspace: store.getWorkspace(id),
        nodes: list.map((n) => ({
          ...n,
          alive: ptys.isAlive(n.id),
          busy: chat.isBusy(n.id),
          unread: bus.pendingFor(n.id).length,
        })),
        edges: store.listEdges(id),
      };
    }),
  );

  // ---------------------------------------------------------------- nodes
  app.post(
    '/api/workspaces/:id/nodes',
    h((req) => {
      const b = z
        .object({
          type: z.enum(NODE_TYPES),
          harness: z.string().optional(),
          title: z.string().max(100).optional(),
          cwd: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          w: z.number().optional(),
          h: z.number().optional(),
          yolo: z.boolean().optional(),
          allowOwnFolder: z.boolean().optional(),
          data: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(req.body);
      return nodes.create(p<{ id: string }>(req).id, { ...b, type: b.type as NodeType });
    }),
  );
  app.patch(
    '/api/nodes/:id',
    h((req) => {
      const b = z
        .object({
          title: z.string().min(1).max(100).optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          w: z.number().min(120).max(4000).optional(),
          h: z.number().min(80).max(4000).optional(),
          yolo: z.boolean().optional(),
          data: z.record(z.string(), z.unknown()).optional(),
          harness: z.enum(['claude', 'agy', 'mock']).optional(),
        })
        .parse(req.body);
      const cur = store.getNode(p<{ id: string }>(req).id);
      if (!cur) throw new Error('unknown node');
      if (b.data && cur.data.readOnly === true) delete b.data.content;
      if (b.harness && cur.type !== 'agent-chat')
        throw new Error('only chat nodes can switch harness');
      if (b.harness && b.harness !== cur.harness) closeAgySessions(cur.id);
      const patch = {
        ...b,
        data: b.data ? { ...cur.data, ...b.data } : undefined,
        sessionRef: b.harness && b.harness !== cur.harness ? null : undefined,
      };
      return store.updateNode(
        cur.id,
        Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      );
    }),
  );
  app.put(
    '/api/layout',
    h((req) => {
      const items = z
        .array(
          z.object({
            id: z.string(),
            x: z.number(),
            y: z.number(),
            w: z.number().optional(),
            h: z.number().optional(),
          }),
        )
        .max(500)
        .parse(req.body);
      store.db.transaction(() => {
        for (const it of items)
          store.updateNode(
            it.id,
            Object.fromEntries(
              Object.entries({ x: it.x, y: it.y, w: it.w, h: it.h }).filter(
                ([, v]) => v !== undefined,
              ),
            ),
            { silent: true },
          );
      })();
    }),
  );
  app.delete(
    '/api/nodes/:id',
    h((req) => nodes.remove(p<{ id: string }>(req).id)),
  );
  app.post(
    '/api/nodes/:id/restart',
    h((req) => {
      const b = z.object({ fresh: z.boolean().optional() }).parse(req.body ?? {});
      nodes.restart(p<{ id: string }>(req).id, b);
    }),
  );
  app.post(
    '/api/nodes/:id/stop',
    h((req) => nodes.stop(p<{ id: string }>(req).id)),
  );
  /** Reply box in "Needs you": types into the node's terminal (or sends a chat turn). */
  app.post(
    '/api/nodes/:id/reply',
    h(async (req) => {
      const b = z
        .object({
          text: z.string().max(10_000),
          submit: z.boolean().optional(),
          raw: z.boolean().optional(),
        })
        .parse(req.body);
      const n = store.getNode(p<{ id: string }>(req).id);
      if (!n) throw new Error('unknown node');
      if (n.type === 'agent-chat') {
        void chat.send(n.id, b.text);
        return { ok: true };
      }
      if (!ptys.isAlive(n.id)) throw new Error('terminal is not running');
      if (b.raw) {
        // The explicit key buttons (1/2/3/y/n/Enter/Esc/arrows): the only input accepted at a prompt.
        const bytes = rawKeyBytes(b.text);
        if (bytes === null)
          throw new BusError(
            'bad_key',
            'raw input must be a named key or a single letter/digit',
            400,
          );
        monitor.noteUserInput(n.id);
        ptys.write(n.id, bytes);
        return { ok: true };
      }
      // While the agent shows a permission/trust/elicitation prompt, free text could answer it by accident.
      if (n.state === 'needs_input')
        throw new BusError(
          'needs_input_keys_only',
          'This node is waiting at a prompt. Use the key buttons (or Allow/Deny), not free text.',
          409,
        );
      const plan = planReply(b.text, b.submit !== false);
      if (!plan)
        throw new BusError('empty_reply', 'nothing to send after removing control characters', 400);
      monitor.noteUserInput(n.id);
      ptys.write(n.id, plan.body);
      if (plan.submit) setTimeout(() => ptys.write(n.id, '\r'), 120);
      return { ok: true };
    }),
  );
  app.post(
    '/api/nodes/:id/message',
    h((req) => {
      const b = z
        .object({
          body: z
            .string()
            .min(1)
            .max(64 * 1024),
          intent: z.enum(['notify', 'request']).optional(),
        })
        .parse(req.body);
      return bus.sendFromUser(p<{ id: string }>(req).id, {
        intent: b.intent ?? 'request',
        body: b.body,
      });
    }),
  );
  app.get(
    '/api/workspaces/:id/messages',
    h((req) => ({ messages: bus.recentMessages(p<{ id: string }>(req).id) })),
  );

  // ---------------------------------------------------------------- edges
  app.post(
    '/api/workspaces/:id/edges',
    h((req) => {
      const b = z
        .object({ from: z.string(), to: z.string(), kind: z.string().optional() })
        .parse(req.body);
      return store.createEdge(p<{ id: string }>(req).id, b.from, b.to, b.kind);
    }),
  );
  app.delete(
    '/api/edges/:id',
    h((req) => store.deleteEdge(p<{ id: string }>(req).id)),
  );

  // ---------------------------------------------------------------- tasks
  app.get(
    '/api/workspaces/:id/tasks',
    h((req) => ({ tasks: bus.listTasks(p<{ id: string }>(req).id) })),
  );
  app.post(
    '/api/workspaces/:id/tasks',
    h((req) => {
      const b = z
        .object({
          title: z.string().min(1).max(300),
          body: z.string().max(20_000).optional(),
          dependsOn: z.array(z.string()).optional(),
        })
        .parse(req.body);
      return bus.addTask(p<{ id: string }>(req).id, b, null);
    }),
  );
  app.patch(
    '/api/tasks/:id',
    h((req) => {
      const b = z
        .object({
          title: z.string().min(1).max(300).optional(),
          body: z.string().max(20_000).optional(),
          status: z.enum(['open', 'claimed', 'done']).optional(),
          position: z.number().optional(),
        })
        .parse(req.body);
      return bus.updateTaskFromUi(p<{ id: string }>(req).id, b);
    }),
  );
  app.delete(
    '/api/tasks/:id',
    h((req) => bus.deleteTask(p<{ id: string }>(req).id)),
  );
  app.post(
    '/api/tasks/:id/assign',
    h((req) => {
      const { nodeId } = z.object({ nodeId: z.string() }).parse(req.body);
      const taskId = p<{ id: string }>(req).id;
      const t = bus
        .listTasks(store.getNode(nodeId)?.workspaceId ?? '')
        .find((x) => x.id === taskId);
      if (!t) throw new Error('task and node must be in the same workspace');
      const msg = bus.sendFromUser(nodeId, {
        intent: 'request',
        body: `Please take task ${t.id}: "${t.title}".${t.body ? `\n\n${t.body}` : ''}\n\nClaim it with claim_task("${t.id}"), do the work, then complete_task("${t.id}", result) and reply to this message with a short summary.`,
      });
      return { ...msg, taskId };
    }),
  );

  // ---------------------------------------------------------------- attention / questions
  /** Items plus a short hash of their content (createdAt is excluded: it can be "now" for some kinds). */
  const attentionSnapshot = (workspaceId?: string) => {
    const items = monitor.attention(workspaceId);
    const hash = createHash('sha1')
      .update(JSON.stringify(items.map(({ createdAt: _t, ...rest }) => rest)))
      .digest('hex')
      .slice(0, 16);
    return { items, hash };
  };

  /** Resolve when something may have changed (any event, or a 1 s tick for screen-only changes) or the client left. */
  const nextTick = (gone: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        hub.off('event', done);
        gone.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, 1000);
      hub.on('event', done);
      gone.addEventListener('abort', done, { once: true });
    });

  /**
   * The feed. Cheap to poll: send If-None-Match (or ?since=<hash>) and get a 304 when nothing changed.
   * With &wait=<seconds> (max 30) the server holds the request until the content changes, so an idle watcher
   * costs about one request per 30 s and still wakes instantly.
   */
  app.get('/api/attention', async (req, reply) => {
    const q = req.query as { workspaceId?: string; since?: string; wait?: string };
    const since =
      (q.since ?? String(req.headers['if-none-match'] ?? '')).replace(/"/g, '') || undefined;
    const deadline = Date.now() + Math.min(Math.max(Number(q.wait) || 0, 0), 30) * 1000;
    const gone = new AbortController();
    reply.raw.once('close', () => gone.abort());
    let snap = attentionSnapshot(q.workspaceId);
    while (since && snap.hash === since && Date.now() < deadline && !gone.signal.aborted) {
      await nextTick(gone.signal);
      snap = attentionSnapshot(q.workspaceId);
    }
    reply.header('ETag', `"${snap.hash}"`).header('Cache-Control', 'no-store');
    if (since && snap.hash === since) return reply.code(304).send();
    return reply.send({ items: snap.items, hash: snap.hash });
  });
  /** Tiny read for widgets (the notch, a menu-bar icon): how many things need the human, by kind. */
  app.get(
    '/api/attention/summary',
    h((req) => {
      const { items, hash } = attentionSnapshot(
        (req.query as { workspaceId?: string }).workspaceId,
      );
      const byKind: Record<string, number> = {};
      for (const i of items) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
      return { count: items.length, byKind, hash };
    }),
  );
  /** Spend so far: total, or for one node / run (`?nodeId=` / `?runId=`). */
  app.get(
    '/api/usage',
    h((req) => {
      const q = req.query as { nodeId?: string; runId?: string };
      return usageSummary(core.db, { nodeId: q.nodeId, runId: q.runId });
    }),
  );
  app.post(
    '/api/questions/:id/answer',
    h((req) => {
      const { answer } = z.object({ answer: z.string().min(1).max(20_000) }).parse(req.body);
      return bus.answerQuestion(p<{ id: string }>(req).id, answer);
    }),
  );
  /** The human clicked Allow / Deny / Ask-in-terminal on a held permission request. */
  app.post(
    '/api/permissions/:id/decide',
    h((req) => {
      const { decision } = z.object({ decision: z.enum(['allow', 'deny', 'ask']) }).parse(req.body);
      if (!core.permissions.decide(p<{ id: string }>(req).id, decision)) {
        throw new BusError(
          'gone',
          'That request is no longer waiting (it timed out, or was answered in the terminal).',
          404,
        );
      }
      return { ok: true };
    }),
  );
  app.post(
    '/api/questions/:id/dismiss',
    h((req) => bus.dismissQuestion(p<{ id: string }>(req).id)),
  );

  // ---------------------------------------------------------------- chat
  app.post(
    '/api/nodes/:id/chat',
    h((req) => {
      const { text } = z.object({ text: z.string().min(1).max(100_000) }).parse(req.body);
      const id = p<{ id: string }>(req).id;
      if (chat.isBusy(id)) throw new Error('this agent is still answering');
      void chat.send(id, text);
      return { ok: true };
    }),
  );
  app.post(
    '/api/nodes/:id/chat/stop',
    h((req) => chat.stop(p<{ id: string }>(req).id)),
  );
  app.post(
    '/api/nodes/:id/chat/clear',
    h((req) => chat.clear(p<{ id: string }>(req).id)),
  );
  app.get(
    '/api/nodes/:id',
    h((req) => {
      const n = store.getNode(p<{ id: string }>(req).id);
      if (!n) throw new Error('unknown node');
      return {
        ...n,
        busy: chat.isBusy(n.id),
        alive: ptys.isAlive(n.id),
        unread: bus.pendingFor(n.id).length,
      };
    }),
  );
  app.post(
    '/api/workspaces/:id/project-chat',
    h((req) => {
      const b = z
        .object({ harness: z.enum(['claude', 'agy', 'mock']).optional() })
        .parse(req.body ?? {});
      const n = chat.projectChatNode(p<{ id: string }>(req).id, b.harness);
      return { ...n, busy: chat.isBusy(n.id) };
    }),
  );

  // ---------------------------------------------------------------- runs
  app.get(
    '/api/workspaces/:id/runs',
    h((req) => ({ runs: runs.list(p<{ id: string }>(req).id) })),
  );
  app.post(
    '/api/workspaces/:id/runs',
    h(async (req) => {
      const b = z
        .object({
          goal: z.string().min(1).max(20_000),
          location: z.enum(['workspace', 'scratch']).optional(),
          planner: z.string().optional(),
          builder: z.string().optional(),
          reviewer: z.string().optional(),
          allowOwnFolder: z.boolean().optional(),
        })
        .parse(req.body);
      if (Object.keys(core.detections).length === 0) await core.refreshDetections();
      return runs.create(p<{ id: string }>(req).id, {
        ...b,
        builder: b.builder ?? getSetting(core.db, 'defaultBuilder', 'claude'),
        reviewer: b.reviewer ?? getSetting(core.db, 'defaultReviewer', 'agy'),
      });
    }),
  );
  app.get(
    '/api/runs/:id',
    h((req) => {
      const r = runs.get(p<{ id: string }>(req).id);
      if (!r) throw new Error('unknown run');
      return r;
    }),
  );
  app.patch(
    '/api/runs/:id/steps/:stepId',
    h((req) => {
      const b = z
        .object({
          instruction: z.string().min(1).max(4000).optional(),
          harness: z.string().optional(),
        })
        .parse(req.body);
      const { id, stepId } = p<{ id: string; stepId: string }>(req);
      return runs.updateStep(id, stepId, b);
    }),
  );
  app.post(
    '/api/runs/:id/steps',
    h((req) => {
      const b = z
        .object({
          role: z.enum(['plan', 'build', 'review', 'verify']),
          harness: z.string(),
          instruction: z.string().min(1).max(4000),
          dependsOn: z.array(z.string()).optional(),
        })
        .parse(req.body);
      return runs.addStep(p<{ id: string }>(req).id, b);
    }),
  );
  app.delete(
    '/api/runs/:id/steps/:stepId',
    h((req) => {
      const { id, stepId } = p<{ id: string; stepId: string }>(req);
      return runs.removeStep(id, stepId);
    }),
  );
  for (const action of ['start', 'pause', 'resume', 'stop'] as const) {
    app.post(
      `/api/runs/:id/${action}`,
      h((req) => {
        runs[action](p<{ id: string }>(req).id);
        return runs.get(p<{ id: string }>(req).id);
      }),
    );
  }
  app.delete(
    '/api/runs/:id',
    h((req) => runs.delete(p<{ id: string }>(req).id)),
  );

  // ---------------------------------------------------------------- sessions
  app.get(
    '/api/sessions/claude',
    h(() => ({ sessions: listClaudeSessions() })),
  );
  app.get(
    '/api/sessions/agy',
    h(() => listAgySessions()),
  );
  app.post(
    '/api/workspaces/:id/resume',
    h((req) => {
      const b = z
        .object({
          harness: z.enum(['claude', 'agy']),
          sessionId: z.string().optional(),
          continueLatest: z.boolean().optional(),
          cwd: z.string().optional(),
          title: z.string().optional(),
        })
        .parse(req.body);
      const wsId = p<{ id: string }>(req).id;
      const ws = store.getWorkspace(wsId);
      if (!ws) throw new Error('unknown workspace');
      const cwd = b.cwd && existsSync(b.cwd) ? b.cwd : ws.rootDir;
      const n = nodes.create(wsId, {
        type: 'agent-terminal',
        harness: b.harness,
        title: b.title?.slice(0, 60) || `Resumed ${b.harness === 'claude' ? 'Claude' : 'agy'}`,
        cwd,
        sessionRef: b.sessionId ?? null,
        resumeRef: b.continueLatest ? null : (b.sessionId ?? null),
      });
      if (b.continueLatest && !b.sessionId) {
        // agy -c / claude --continue: restart the PTY with the continue flag.
        const s = ptys.get(n.id);
        if (s) {
          ptys.spawn(n.id, {
            ...s.spec,
            args: [...s.spec.args, b.harness === 'agy' ? '-c' : '--continue'],
          });
        }
      }
      return n;
    }),
  );
  app.post(
    '/api/import/parse',
    { bodyLimit: 200 * 1024 * 1024 },
    h((req) => {
      const { json } = z.object({ json: z.string() }).parse(req.body);
      const convs = parseExport(JSON.parse(json));
      return {
        conversations: convs.map((c, index) => ({
          index,
          title: c.title,
          source: c.source,
          turns: c.turns.length,
          createdAt: c.createdAt,
        })),
      };
    }),
  );
  app.post(
    '/api/workspaces/:id/import',
    { bodyLimit: 200 * 1024 * 1024 },
    h((req) => {
      const b = z
        .object({ json: z.string(), indices: z.array(z.number().int().min(0)).max(50) })
        .parse(req.body);
      const convs = parseExport(JSON.parse(b.json));
      const wsId = p<{ id: string }>(req).id;
      const created = [];
      let i = 0;
      for (const idx of b.indices) {
        const c = convs[idx];
        if (!c) continue;
        created.push(
          nodes.create(wsId, {
            type: 'doc',
            title: c.title.slice(0, 80),
            x: 120 + i * 40,
            y: 120 + i * 40,
            data: { content: conversationToMarkdown(c), readOnly: true, importedFrom: c.source },
          }),
        );
        i++;
      }
      return { nodes: created };
    }),
  );

  // ---------------------------------------------------------------- worktrees
  app.post(
    '/api/workspaces/:id/worktree',
    h(async (req) => {
      const b = z
        .object({
          harness: z.enum(['claude', 'agy', 'mock']),
          branch: z.string().regex(/^[A-Za-z0-9._/-]{1,80}$/),
        })
        .parse(req.body);
      const ws = store.getWorkspace(p<{ id: string }>(req).id);
      if (!ws) throw new Error('unknown workspace');
      const top = await runCapture('git', ['-C', ws.rootDir, 'rev-parse', '--show-toplevel']);
      if (top.code !== 0) throw new Error('workspace folder is not a git repository');
      const repoRoot = top.stdout.trim();
      const dir = join(
        dirname(repoRoot),
        `${basename(repoRoot)}-wt-${b.branch.replace(/[/]/g, '-')}`,
      );
      if (existsSync(dir)) throw new Error(`${dir} already exists`);
      const add = await runCapture(
        'git',
        ['-C', repoRoot, 'worktree', 'add', '-b', b.branch, dir],
        { timeoutMs: 60_000 },
      );
      if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`);
      return nodes.create(ws.id, {
        type: 'agent-terminal',
        harness: b.harness,
        title: `${b.harness} @ ${b.branch}`,
        cwd: dir,
      });
    }),
  );
}
