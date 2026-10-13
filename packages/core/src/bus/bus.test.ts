import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db/index.js';
import { Store } from '../store.js';
import { Bus, BusError } from './service.js';

function setup(dbPath = ':memory:', clock = { t: 1_000_000 }) {
  const store = new Store(openDb(dbPath));
  const bus = new Bus(store, () => clock.t);
  const ws = store.createWorkspace('t', tmpdir());
  const mk = (title: string) =>
    store.insertNode({
      workspaceId: ws.id,
      type: 'agent-chat',
      harness: 'mock',
      title,
      cwd: tmpdir(),
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      state: 'idle',
      sessionRef: null,
      yolo: false,
      data: {},
      summary: '',
    });
  const a = mk('A');
  const b = mk('B');
  const c = mk('C');
  store.createEdge(ws.id, a.id, b.id);
  return { store, bus, ws, a, b, c, clock };
}

describe('bus: edge scoping', () => {
  it('list_peers only returns edge-connected nodes, in both directions', () => {
    const { bus, a, b, c } = setup();
    expect(bus.listPeers(a.id).map((p) => p.nodeId)).toEqual([b.id]);
    expect(bus.listPeers(b.id).map((p) => p.nodeId)).toEqual([a.id]);
    expect(bus.listPeers(c.id)).toEqual([]);
  });

  it('cannot message or inspect an unconnected node, and the error does not reveal whether it exists', () => {
    const { bus, a, c } = setup();
    const e1 = (() => {
      try {
        bus.sendMessage(a.id, { peerId: c.id, intent: 'notify', body: 'hi' });
      } catch (e) {
        return e as BusError;
      }
    })();
    const e2 = (() => {
      try {
        bus.sendMessage(a.id, { peerId: 'does-not-exist', intent: 'notify', body: 'hi' });
      } catch (e) {
        return e as BusError;
      }
    })();
    expect(e1?.code).toBe('not_connected');
    expect(e2?.code).toBe('not_connected');
    expect(() => bus.getPeerContext(a.id, c.id)).toThrow(BusError);
    expect(() => bus.getNodeStatus(a.id, c.id)).toThrow(BusError);
  });

  it('removing the edge revokes reachability', () => {
    const { store, bus, ws, a, b } = setup();
    const edge = store.listEdges(ws.id)[0]!;
    store.deleteEdge(edge.id);
    expect(() => bus.sendMessage(a.id, { peerId: b.id, intent: 'notify', body: 'x' })).toThrow(
      /not connected/,
    );
  });
});

describe('bus: messages', () => {
  it('request/response correlation and wait_for_reply', async () => {
    const { bus, a, b } = setup();
    const { messageId } = bus.sendMessage(a.id, {
      peerId: b.id,
      intent: 'request',
      body: 'say pong',
    });
    const waiting = bus.waitForReply(a.id, messageId, 5);
    const inbox = bus.checkInbox(b.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ messageId, intent: 'request', from: a.id, needsReply: true });
    bus.sendMessage(b.id, {
      peerId: a.id,
      intent: 'response',
      responseTo: messageId,
      body: 'pong',
    });
    const reply = await waiting;
    expect(reply).toMatchObject({ status: 'replied', body: 'pong', from: b.id });
  });

  it('a response must point at a request the peer actually sent you', () => {
    const { bus, a, b } = setup();
    const { messageId: notify } = bus.sendMessage(a.id, {
      peerId: b.id,
      intent: 'notify',
      body: 'fyi',
    });
    expect(() =>
      bus.sendMessage(b.id, { peerId: a.id, intent: 'response', responseTo: notify, body: 'x' }),
    ).toThrow(/responseTo/);
    const { messageId: req } = bus.sendMessage(a.id, {
      peerId: b.id,
      intent: 'request',
      body: 'q',
    });
    // A can't "answer" its own request
    expect(() =>
      bus.sendMessage(a.id, { peerId: b.id, intent: 'response', responseTo: req, body: 'x' }),
    ).toThrow(/responseTo/);
    expect(() => bus.sendMessage(b.id, { peerId: a.id, intent: 'response', body: 'x' })).toThrow(
      /responseTo/,
    );
  });

  it('wait_for_reply times out cleanly', async () => {
    const { bus, a, b } = setup();
    const { messageId } = bus.sendMessage(a.id, { peerId: b.id, intent: 'request', body: 'q' });
    expect(await bus.waitForReply(a.id, messageId, 0.05)).toMatchObject({ status: 'timeout' });
  });

  it('inbox is oldest-first and markRead delivers exactly once', () => {
    const { bus, a, b, clock } = setup();
    bus.sendMessage(a.id, { peerId: b.id, intent: 'notify', body: 'one' });
    clock.t += 1;
    bus.sendMessage(a.id, { peerId: b.id, intent: 'notify', body: 'two' });
    expect(bus.checkInbox(b.id, false).map((m) => m.body)).toEqual(['one', 'two']);
    expect(bus.checkInbox(b.id).map((m) => m.body)).toEqual(['one', 'two']);
    expect(bus.checkInbox(b.id)).toEqual([]);
  });

  it('expired messages are dropped from the inbox', () => {
    const { bus, a, b, clock } = setup();
    bus.sendMessage(a.id, { peerId: b.id, intent: 'notify', body: 'stale soon', expiresInSec: 10 });
    bus.sendMessage(a.id, { peerId: b.id, intent: 'notify', body: 'forever' });
    clock.t += 11_000;
    expect(bus.checkInbox(b.id).map((m) => m.body)).toEqual(['forever']);
  });

  it('messages are durable: persisted before ack and survive reopening the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sy-bus-'));
    const path = join(dir, 'db.sqlite');
    const first = setup(path);
    first.bus.sendMessage(first.a.id, {
      peerId: first.b.id,
      intent: 'request',
      body: 'still here?',
    });
    first.store.db.close();
    const store2 = new Store(openDb(path));
    const bus2 = new Bus(store2);
    expect(bus2.checkInbox(first.b.id).map((m) => m.body)).toEqual(['still here?']);
  });
});

describe('bus: tasks', () => {
  it('claim is atomic: second claimer fails', () => {
    const { bus, ws, a, b } = setup();
    const t = bus.addTask(ws.id, { title: 'do it' }, a.id);
    expect(bus.claimTask(a.id, t.id).ownerNode).toBe(a.id);
    expect(() => bus.claimTask(b.id, t.id)).toThrow(/claimed/);
  });

  it('dependencies block claiming until done, and completing unblocks dependents', () => {
    const { bus, ws, a, b } = setup();
    const first = bus.addTask(ws.id, { title: 'first' }, a.id);
    const second = bus.addTask(ws.id, { title: 'second', dependsOn: [first.id] }, a.id);
    expect(bus.listTasks(ws.id).find((t) => t.id === second.id)?.blocked).toBe(true);
    expect(() => bus.claimTask(b.id, second.id)).toThrow(/dependencies/);
    bus.claimTask(a.id, first.id);
    expect(() => bus.completeTask(b.id, first.id)).toThrow(/another node/);
    bus.completeTask(a.id, first.id, 'ok');
    expect(bus.listTasks(ws.id).find((t) => t.id === second.id)?.blocked).toBe(false);
    expect(bus.claimTask(b.id, second.id).status).toBe('claimed');
  });
});

describe('bus: ask_user and status', () => {
  it('ask_user blocks until answered', async () => {
    const { bus, a } = setup();
    const p = bus.askUser(a.id, { question: 'Ship it?', timeoutSec: 5 });
    const [q] = bus.openQuestions();
    expect(q?.text).toBe('Ship it?');
    bus.answerQuestion(q!.id, 'yes');
    expect(await p).toMatchObject({ answer: 'yes' });
    expect(bus.openQuestions()).toEqual([]);
  });

  it('ask_user returns pending on timeout and can be resumed by questionId', async () => {
    const { bus, a } = setup();
    const first = (await bus.askUser(a.id, { question: 'Later?', timeoutSec: 0.05 })) as {
      pending: boolean;
      questionId: string;
    };
    expect(first.pending).toBe(true);
    bus.answerQuestion(first.questionId, 'now');
    expect(await bus.askUser(a.id, { questionId: first.questionId, timeoutSec: 1 })).toMatchObject({
      answer: 'now',
    });
  });

  it('wait_for_nodes resolves when connected nodes go idle', async () => {
    const { bus, a, b } = setup();
    bus.setStatus(b.id, 'working');
    const p = bus.waitForNodes(a.id, [b.id], 5);
    setTimeout(() => bus.setStatus(b.id, 'idle'), 20);
    expect(await p).toMatchObject({ status: 'settled' });
  });

  it('the human can message any node, and agents can answer the human', () => {
    const { bus, c } = setup();
    const { messageId } = bus.sendFromUser(c.id, { intent: 'request', body: 'status?' });
    const [m] = bus.checkInbox(c.id);
    expect(m).toMatchObject({ from: 'user', needsReply: true });
    expect(
      bus.sendMessage(c.id, {
        peerId: 'user',
        intent: 'response',
        responseTo: messageId,
        body: 'fine',
      }).messageId,
    ).toBeTruthy();
    // ...but cannot use "user" as a back door to notify arbitrary things
    expect(() => bus.sendMessage(c.id, { peerId: 'user', intent: 'notify', body: 'x' })).toThrow();
  });
});
