import { EventEmitter } from 'node:events';
import type { Store, NodeRec, NodeState } from '../store.js';
import { randomId } from '../auth/token.js';
import { hub } from '../events.js';

export class BusError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export type Intent = 'notify' | 'request' | 'response';

export interface MessageRec {
  id: string;
  workspaceId: string;
  from: string;
  to: string;
  intent: Intent;
  responseTo: string | null;
  body: string;
  createdAt: number;
  deliveredAt: number | null;
  expiresAt: number | null;
}

export interface TaskRec {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  status: 'open' | 'claimed' | 'done';
  ownerNode: string | null;
  createdBy: string | null;
  dependsOn: string[];
  result: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
  blocked?: boolean;
}

export interface QuestionRec {
  id: string;
  nodeId: string;
  workspaceId: string;
  text: string;
  answer: string | null;
  createdAt: number;
  answeredAt: number | null;
}

interface MsgRow {
  id: string;
  workspace_id: string;
  from_node: string;
  to_node: string;
  intent: Intent;
  response_to: string | null;
  body: string;
  created_at: number;
  delivered_at: number | null;
  expires_at: number | null;
}

interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  body: string;
  status: TaskRec['status'];
  owner_node: string | null;
  created_by: string | null;
  depends_on_json: string;
  result: string | null;
  position: number;
  created_at: number;
  updated_at: number;
}

const toMsg = (r: MsgRow): MessageRec => ({
  id: r.id,
  workspaceId: r.workspace_id,
  from: r.from_node,
  to: r.to_node,
  intent: r.intent,
  responseTo: r.response_to,
  body: r.body,
  createdAt: r.created_at,
  deliveredAt: r.delivered_at,
  expiresAt: r.expires_at,
});

const toTask = (r: TaskRow): TaskRec => ({
  id: r.id,
  workspaceId: r.workspace_id,
  title: r.title,
  body: r.body,
  status: r.status,
  ownerNode: r.owner_node,
  createdBy: r.created_by,
  dependsOn: JSON.parse(r.depends_on_json) as string[],
  result: r.result,
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const MAX_BODY = 64 * 1024;
export const USER_NODE = 'user';
const MAX_WAIT_MS = 600_000;
/** One wait_inbox request stays under fetch's header timeout; bus-mcp loops for longer stand-bys. */
const MAX_INBOX_WAIT_MS = 55_000;

export class Bus {
  /** Internal wakeups for long-polls; never leaves the process. */
  private signals = new EventEmitter();

  constructor(
    private store: Store,
    private now: () => number = Date.now,
  ) {
    this.signals.setMaxListeners(1000);
  }

  private get db() {
    return this.store.db;
  }

  private requireNode(id: string): NodeRec {
    const n = this.store.getNode(id);
    if (!n) throw new BusError('unknown_node', `no node ${id}`, 404);
    return n;
  }

  private requireConnected(self: string, peer: string): NodeRec {
    const p = this.store.getNode(peer);
    // Same error for "doesn't exist" and "not connected" so unconnected nodes can't probe for each other.
    if (!p || !this.store.areConnected(self, peer)) {
      throw new BusError('not_connected', `node ${peer} is not connected to you`, 403);
    }
    return p;
  }

  // ---------------------------------------------------------------- peers
  listPeers(self: string) {
    this.requireNode(self);
    return this.store
      .connectedNodeIds(self)
      .map((id) => this.store.getNode(id))
      .filter((n): n is NodeRec => !!n)
      .map((n) => ({
        nodeId: n.id,
        title: n.title,
        harness: n.harness ?? n.type,
        type: n.type,
        state: n.state,
        summary: n.summary,
      }));
  }

  getPeerContext(self: string, peerId: string) {
    const peer = this.requireConnected(self, peerId);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE (from_node=? AND to_node=?) OR (from_node=? AND to_node=?)
         ORDER BY created_at DESC LIMIT 5`,
      )
      .all(self, peerId, peerId, self) as MsgRow[];
    return {
      nodeId: peer.id,
      title: peer.title,
      harness: peer.harness ?? peer.type,
      state: peer.state,
      summary: peer.summary,
      recentMessages: rows.map((r) => ({
        id: r.id,
        direction: r.from_node === self ? 'sent' : 'received',
        intent: r.intent,
        subject: r.body.split('\n')[0]!.slice(0, 80),
        createdAt: r.created_at,
      })),
    };
  }

  publishSummary(self: string, text: string) {
    this.requireNode(self);
    const summary = String(text ?? '').slice(0, 800);
    this.store.updateNode(self, { summary });
    return { ok: true };
  }

  // ---------------------------------------------------------------- messages
  sendMessage(
    self: string,
    input: {
      peerId: string;
      intent: Intent;
      body: string;
      responseTo?: string;
      expiresInSec?: number;
    },
  ): { messageId: string } {
    const me = this.requireNode(self);
    // Agents may answer the human's requests; otherwise only edge-connected peers are reachable.
    if (!(input.peerId === USER_NODE && input.intent === 'response'))
      this.requireConnected(self, input.peerId);
    if (!['notify', 'request', 'response'].includes(input.intent)) {
      throw new BusError('bad_intent', 'intent must be notify, request or response');
    }
    const body = String(input.body ?? '');
    if (body.length === 0) throw new BusError('empty_body', 'body must not be empty');
    if (body.length > MAX_BODY) throw new BusError('body_too_large', 'body exceeds 64KB');
    let responseTo: string | null = null;
    if (input.intent === 'response') {
      if (!input.responseTo) throw new BusError('missing_response_to', 'response needs responseTo');
      const orig = this.getMessage(input.responseTo);
      // You can only answer a request that peer actually sent you.
      if (!orig || orig.intent !== 'request' || orig.from !== input.peerId || orig.to !== self) {
        throw new BusError('bad_response_to', 'responseTo must be a request that peer sent you');
      }
      responseTo = orig.id;
    } else if (input.responseTo) {
      responseTo = input.responseTo;
    }
    const createdAt = this.now();
    const expiresAt =
      input.expiresInSec && input.expiresInSec > 0 ? createdAt + input.expiresInSec * 1000 : null;
    const id = randomId(9);
    // Persist before acking — the ack means the message is durable.
    this.db
      .prepare(
        `INSERT INTO messages(id, workspace_id, from_node, to_node, intent, response_to, body, created_at, delivered_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,NULL,?)`,
      )
      .run(
        id,
        me.workspaceId,
        self,
        input.peerId,
        input.intent,
        responseTo,
        body,
        createdAt,
        expiresAt,
      );
    this.signals.emit('message', input.peerId);
    hub.emitHub({ t: 'change', entity: 'messages', workspaceId: me.workspaceId, id });
    return { messageId: id };
  }

  /** The human (UI) is not a node and isn't edge-scoped; its messages arrive as from "user". */
  sendFromUser(
    toNode: string,
    input: { intent: 'notify' | 'request'; body: string },
  ): { messageId: string } {
    const to = this.requireNode(toNode);
    const body = String(input.body ?? '').slice(0, MAX_BODY);
    if (!body) throw new BusError('empty_body', 'body must not be empty');
    const id = randomId(9);
    this.db
      .prepare(
        `INSERT INTO messages(id, workspace_id, from_node, to_node, intent, response_to, body, created_at, delivered_at, expires_at)
         VALUES (?,?,?,?,?,NULL,?,?,NULL,NULL)`,
      )
      .run(id, to.workspaceId, USER_NODE, toNode, input.intent, body, this.now());
    this.signals.emit('message', toNode);
    hub.emitHub({ t: 'change', entity: 'messages', workspaceId: to.workspaceId, id });
    return { messageId: id };
  }

  getMessage(id: string): MessageRec | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as MsgRow | undefined;
    return r ? toMsg(r) : undefined;
  }

  /** Undelivered, unexpired messages for this node, oldest first. */
  pendingFor(nodeId: string): MessageRec[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM messages WHERE to_node=? AND delivered_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY created_at, rowid`,
        )
        .all(nodeId, this.now()) as MsgRow[]
    ).map(toMsg);
  }

  checkInbox(self: string, markRead = true) {
    const me = this.requireNode(self);
    const msgs = this.pendingFor(self);
    if (markRead && msgs.length > 0) {
      const at = this.now();
      const stmt = this.db.prepare('UPDATE messages SET delivered_at=? WHERE id=?');
      this.db.transaction(() => {
        for (const m of msgs) stmt.run(at, m.id);
      })();
      hub.emitHub({ t: 'change', entity: 'messages', workspaceId: me.workspaceId });
    }
    return msgs.map((m) => {
      const from = this.store.getNode(m.from);
      return {
        messageId: m.id,
        from: m.from,
        fromTitle:
          m.from === USER_NODE ? 'The human supervising this canvas' : (from?.title ?? m.from),
        intent: m.intent,
        responseTo: m.responseTo,
        body: m.body,
        createdAt: m.createdAt,
        needsReply: m.intent === 'request',
      };
    });
  }

  private findResponse(self: string, messageId: string): MessageRec | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM messages WHERE response_to=? AND to_node=? AND intent='response' ORDER BY created_at LIMIT 1`,
      )
      .get(messageId, self) as MsgRow | undefined;
    return r ? toMsg(r) : undefined;
  }

  async waitForReply(self: string, messageId: string, timeoutSec: number) {
    this.requireNode(self);
    const orig = this.getMessage(messageId);
    if (!orig || orig.from !== self || orig.intent !== 'request') {
      throw new BusError('bad_message', 'messageId must be a request you sent');
    }
    const timeoutMs = Math.min(Math.max(0, timeoutSec) * 1000, MAX_WAIT_MS);
    const take = () => {
      const resp = this.findResponse(self, messageId);
      if (!resp) return null;
      if (resp.deliveredAt == null) {
        this.db.prepare('UPDATE messages SET delivered_at=? WHERE id=?').run(this.now(), resp.id);
      }
      return {
        status: 'replied' as const,
        messageId: resp.id,
        from: resp.from,
        body: resp.body,
        createdAt: resp.createdAt,
      };
    };
    const got = await this.waitFor(take, 'message', (target) => target === self, timeoutMs);
    return got ?? { status: 'timeout' as const, messageId };
  }

  /**
   * Long-poll check_inbox: resolves with the inbox (marked delivered, as check_inbox does) as soon as it is
   * non-empty, else `{messages: [], timedOut: true}` after timeoutMs (capped at 55 s). `gone` is the client
   * leaving: the wait ends at once and nothing is marked delivered, so the messages wait for the next call.
   */
  async waitForInbox(self: string, timeoutMs: number, gone?: AbortSignal) {
    this.requireNode(self);
    const check = () => {
      const msgs = this.checkInbox(self);
      return msgs.length > 0 ? msgs : null;
    };
    const msgs = await this.waitFor(
      check,
      'message',
      (target) => target === self,
      Math.min(Math.max(0, timeoutMs), MAX_INBOX_WAIT_MS),
      gone,
    );
    return { messages: msgs ?? [], timedOut: msgs === null };
  }

  private waitFor<T>(
    check: () => T | null,
    signal: string,
    filter: (arg: unknown) => boolean,
    timeoutMs: number,
    gone?: AbortSignal,
  ): Promise<T | null> {
    // A client that already left gets nothing; check() must not run for it (it may have side effects).
    if (gone?.aborted) return Promise.resolve(null);
    const first = check();
    if (first !== null || timeoutMs <= 0) return Promise.resolve(first);
    return new Promise((resolve) => {
      const onSignal = (arg: unknown) => {
        if (!filter(arg)) return;
        const v = check();
        if (v !== null) done(v);
      };
      const timer = setTimeout(() => done(check()), timeoutMs);
      const onGone = () => done(null);
      const done = (v: T | null) => {
        clearTimeout(timer);
        this.signals.off(signal, onSignal);
        gone?.removeEventListener('abort', onGone);
        resolve(v);
      };
      this.signals.on(signal, onSignal);
      gone?.addEventListener('abort', onGone, { once: true });
    });
  }

  // ---------------------------------------------------------------- tasks
  private taskRow(id: string): TaskRec | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow | undefined;
    return r ? toTask(r) : undefined;
  }

  private withBlocked(tasks: TaskRec[]): TaskRec[] {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return tasks.map((t) => ({
      ...t,
      blocked: t.dependsOn.some((d) => {
        const dep = byId.get(d) ?? this.taskRow(d);
        return !dep || dep.status !== 'done';
      }),
    }));
  }

  listTasks(workspaceId: string, status?: string): TaskRec[] {
    const rows = (
      status
        ? this.db
            .prepare(
              'SELECT * FROM tasks WHERE workspace_id=? AND status=? ORDER BY position, created_at',
            )
            .all(workspaceId, status)
        : this.db
            .prepare('SELECT * FROM tasks WHERE workspace_id=? ORDER BY position, created_at')
            .all(workspaceId)
    ) as TaskRow[];
    return this.withBlocked(rows.map(toTask));
  }

  listTasksFor(self: string, status?: string) {
    return this.listTasks(this.requireNode(self).workspaceId, status);
  }

  addTask(
    workspaceId: string,
    input: { title: string; body?: string; dependsOn?: string[] },
    createdBy: string | null,
  ): TaskRec {
    const title = String(input.title ?? '')
      .trim()
      .slice(0, 300);
    if (!title) throw new BusError('empty_title', 'title is required');
    const deps = (input.dependsOn ?? []).filter(Boolean);
    for (const d of deps) {
      const t = this.taskRow(d);
      if (!t || t.workspaceId !== workspaceId)
        throw new BusError('bad_dependency', `unknown task ${d}`);
    }
    const now = this.now();
    const id = randomId(6);
    const pos =
      (
        this.db
          .prepare('SELECT MAX(position) AS p FROM tasks WHERE workspace_id=?')
          .get(workspaceId) as {
          p: number | null;
        }
      ).p ?? 0;
    this.db
      .prepare(
        `INSERT INTO tasks(id, workspace_id, title, body, status, owner_node, created_by, depends_on_json, result, position, created_at, updated_at)
         VALUES (?,?,?,?, 'open', NULL, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        title,
        String(input.body ?? ''),
        createdBy,
        JSON.stringify(deps),
        pos + 1,
        now,
        now,
      );
    this.signals.emit('task', workspaceId);
    hub.emitHub({ t: 'change', entity: 'tasks', workspaceId, id });
    return this.withBlocked([this.taskRow(id)!])[0]!;
  }

  claimTask(self: string, taskId: string): TaskRec {
    const me = this.requireNode(self);
    const t = this.taskRow(taskId);
    if (!t || t.workspaceId !== me.workspaceId)
      throw new BusError('unknown_task', `no task ${taskId}`, 404);
    const [withB] = this.withBlocked([t]);
    if (withB!.blocked) throw new BusError('blocked', 'task has unfinished dependencies', 409);
    // Atomic: the WHERE clause is the lock.
    const res = this.db
      .prepare(
        `UPDATE tasks SET status='claimed', owner_node=?, updated_at=? WHERE id=? AND status='open'`,
      )
      .run(self, this.now(), taskId);
    if (res.changes !== 1) {
      const cur = this.taskRow(taskId)!;
      throw new BusError(
        'already_claimed',
        `task is ${cur.status}${cur.ownerNode ? ` by ${cur.ownerNode}` : ''}`,
        409,
      );
    }
    hub.emitHub({ t: 'change', entity: 'tasks', workspaceId: me.workspaceId, id: taskId });
    return this.withBlocked([this.taskRow(taskId)!])[0]!;
  }

  completeTask(self: string | null, taskId: string, result?: string): TaskRec {
    const t = this.taskRow(taskId);
    if (!t) throw new BusError('unknown_task', `no task ${taskId}`, 404);
    if (self !== null) {
      const me = this.requireNode(self);
      if (t.workspaceId !== me.workspaceId)
        throw new BusError('unknown_task', `no task ${taskId}`, 404);
      if (t.status === 'claimed' && t.ownerNode !== self) {
        throw new BusError('not_owner', 'task is claimed by another node', 409);
      }
    }
    if (t.status === 'done') return this.withBlocked([t])[0]!;
    this.db
      .prepare(
        `UPDATE tasks SET status='done', owner_node=COALESCE(owner_node, ?), result=?, updated_at=? WHERE id=?`,
      )
      .run(self, result ?? null, this.now(), taskId);
    this.signals.emit('task', t.workspaceId);
    hub.emitHub({ t: 'change', entity: 'tasks', workspaceId: t.workspaceId, id: taskId });
    return this.withBlocked([this.taskRow(taskId)!])[0]!;
  }

  /** UI-side edits (drag between columns, rename). Not exposed to agents. */
  updateTaskFromUi(
    taskId: string,
    patch: {
      title?: string;
      body?: string;
      status?: TaskRec['status'];
      ownerNode?: string | null;
      position?: number;
    },
  ): TaskRec {
    const t = this.taskRow(taskId);
    if (!t) throw new BusError('unknown_task', `no task ${taskId}`, 404);
    const next = { ...t, ...patch };
    if (next.status === 'open') next.ownerNode = patch.ownerNode ?? null;
    this.db
      .prepare(
        `UPDATE tasks SET title=?, body=?, status=?, owner_node=?, position=?, updated_at=? WHERE id=?`,
      )
      .run(next.title, next.body, next.status, next.ownerNode, next.position, this.now(), taskId);
    this.signals.emit('task', t.workspaceId);
    hub.emitHub({ t: 'change', entity: 'tasks', workspaceId: t.workspaceId, id: taskId });
    return this.withBlocked([this.taskRow(taskId)!])[0]!;
  }

  deleteTask(taskId: string): void {
    const t = this.taskRow(taskId);
    this.db.prepare('DELETE FROM tasks WHERE id=?').run(taskId);
    if (t) hub.emitHub({ t: 'change', entity: 'tasks', workspaceId: t.workspaceId });
  }

  // ---------------------------------------------------------------- status
  setStatus(nodeId: string, state: NodeState): void {
    const n = this.store.getNode(nodeId);
    if (!n || n.state === state) return;
    this.store.updateNode(nodeId, { state }, { silent: true });
    this.signals.emit('status', nodeId);
    hub.emitHub({ t: 'status', nodeId, state });
  }

  getNodeStatus(self: string, nodeId: string) {
    if (nodeId !== self) this.requireConnected(self, nodeId);
    const n = this.requireNode(nodeId);
    return { nodeId, state: n.state };
  }

  async waitForNodes(self: string, nodeIds: string[], timeoutSec: number) {
    for (const id of nodeIds) if (id !== self) this.requireConnected(self, id);
    const settled = () => {
      const states = nodeIds.map((id) => ({
        nodeId: id,
        state: this.store.getNode(id)?.state ?? 'exited',
      }));
      // An external node (Claude Desktop) never reports work, so waiting on it would only time out.
      return states.every((s) => ['idle', 'exited', 'external'].includes(s.state)) ? states : null;
    };
    const timeoutMs = Math.min(Math.max(0, timeoutSec) * 1000, MAX_WAIT_MS);
    const res = await this.waitFor(
      settled,
      'status',
      (id) => nodeIds.includes(id as string),
      timeoutMs,
    );
    if (res) return { status: 'settled' as const, nodes: res };
    return {
      status: 'timeout' as const,
      nodes: nodeIds.map((id) => ({
        nodeId: id,
        state: this.store.getNode(id)?.state ?? 'exited',
      })),
    };
  }

  // ---------------------------------------------------------------- ask_user
  private questionRow(id: string): QuestionRec | undefined {
    const r = this.db.prepare('SELECT * FROM questions WHERE id=?').get(id) as
      | {
          id: string;
          node_id: string;
          workspace_id: string;
          text: string;
          answer: string | null;
          created_at: number;
          answered_at: number | null;
        }
      | undefined;
    return r
      ? {
          id: r.id,
          nodeId: r.node_id,
          workspaceId: r.workspace_id,
          text: r.text,
          answer: r.answer,
          createdAt: r.created_at,
          answeredAt: r.answered_at,
        }
      : undefined;
  }

  createQuestion(self: string, text: string): QuestionRec {
    const me = this.requireNode(self);
    const q = String(text ?? '')
      .trim()
      .slice(0, 4000);
    if (!q) throw new BusError('empty_question', 'question is required');
    const id = randomId(6);
    this.db
      .prepare(
        'INSERT INTO questions(id, node_id, workspace_id, text, answer, created_at, answered_at) VALUES (?,?,?,?,NULL,?,NULL)',
      )
      .run(id, self, me.workspaceId, q, this.now());
    hub.emitHub({ t: 'change', entity: 'questions', workspaceId: me.workspaceId, id });
    return this.questionRow(id)!;
  }

  async askUser(
    self: string,
    input: { question?: string; questionId?: string; timeoutSec?: number },
  ) {
    let q: QuestionRec | undefined;
    if (input.questionId) {
      q = this.questionRow(input.questionId);
      if (!q || q.nodeId !== self)
        throw new BusError('unknown_question', 'no such question for you', 404);
    } else {
      q = this.createQuestion(self, input.question ?? '');
    }
    const id = q.id;
    const timeoutMs = Math.min(Math.max(0, input.timeoutSec ?? 600) * 1000, MAX_WAIT_MS);
    const check = () => {
      const cur = this.questionRow(id);
      return cur && cur.answer !== null ? cur : null;
    };
    const answered = await this.waitFor(check, 'answer', (qid) => qid === id, timeoutMs);
    if (answered) return { questionId: id, answer: answered.answer };
    return { questionId: id, pending: true };
  }

  answerQuestion(questionId: string, answer: string): QuestionRec {
    const q = this.questionRow(questionId);
    if (!q) throw new BusError('unknown_question', 'no such question', 404);
    if (q.answer === null) {
      this.db
        .prepare('UPDATE questions SET answer=?, answered_at=? WHERE id=?')
        .run(String(answer), this.now(), questionId);
      this.signals.emit('answer', questionId);
      if (this.store.getNode(q.nodeId)?.state === 'needs_input')
        this.setStatus(q.nodeId, 'working');
      hub.emitHub({ t: 'change', entity: 'questions', workspaceId: q.workspaceId, id: questionId });
    }
    return this.questionRow(questionId)!;
  }

  openQuestions(workspaceId?: string): QuestionRec[] {
    const rows = (
      workspaceId
        ? this.db
            .prepare(
              'SELECT id FROM questions WHERE answer IS NULL AND workspace_id=? ORDER BY created_at',
            )
            .all(workspaceId)
        : this.db.prepare('SELECT id FROM questions WHERE answer IS NULL ORDER BY created_at').all()
    ) as { id: string }[];
    return rows.map((r) => this.questionRow(r.id)!).filter((q) => !!this.store.getNode(q.nodeId));
  }

  dismissQuestion(questionId: string): void {
    this.answerQuestion(questionId, '[dismissed by user without an answer]');
  }

  /** Messages in a workspace, newest first — for the UI's message log. */
  recentMessages(workspaceId: string, limit = 100): MessageRec[] {
    return (
      this.db
        .prepare('SELECT * FROM messages WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?')
        .all(workspaceId, limit) as MsgRow[]
    ).map(toMsg);
  }

  onMessageFor(fn: (nodeId: string) => void): void {
    this.signals.on('message', fn);
  }
}
