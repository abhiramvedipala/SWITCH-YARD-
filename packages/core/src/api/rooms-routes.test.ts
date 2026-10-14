import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Rooms over HTTP: the bus tools see only the agent's own workspace, and a phone can read and post only.
type Built = Awaited<ReturnType<typeof import('../server.js').buildServer>>;
const PORT = 4795;
let built: Built;
let node: string;
let cap: string;
let mine: string;
let theirs: string;

beforeAll(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-roomroutes-home-'));
  const { buildServer } = await import('../server.js');
  built = await buildServer({
    port: PORT,
    dbPath: ':memory:',
    quiet: true,
    whois: async (ip) => (ip === '100.64.0.9' ? 'phone@x' : null),
  });
  const { store, caps, rooms } = built.core;
  const ws = store.createWorkspace('mine', mkdtempSync(join(tmpdir(), 'sy-rr-a-')));
  const other = store.createWorkspace('other', mkdtempSync(join(tmpdir(), 'sy-rr-b-')));
  node = store.insertNode({
    workspaceId: ws.id,
    type: 'agent-terminal',
    harness: 'mock',
    title: 'Builder',
    cwd: ws.rootDir,
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    state: 'idle',
    sessionRef: null,
    yolo: false,
    data: {},
    summary: '',
  }).id;
  cap = caps.issue(node, ws.id).capability;
  mine = rooms.create(ws.id, { title: 'Mine' }).id;
  rooms.addParticipant(mine, { harness: 'mock', displayName: 'Mock A' });
  theirs = rooms.create(other.id, { title: 'Theirs' }).id;
  rooms.post(theirs, { kind: 'human', id: null, name: 'Human' }, 'secret plans');
});
afterAll(async () => {
  await built.app.close();
});

const host = { host: `127.0.0.1:${PORT}` };
const bus = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  built.app.inject({
    method,
    url,
    payload: payload as never,
    headers: { ...host, 'x-switchyard-node': node, 'x-switchyard-cap': cap },
  });
const ui = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, phone = false) =>
  built.app.inject({
    method,
    url,
    payload: payload as never,
    headers: {
      ...host,
      authorization: `Bearer ${built.token}`,
      ...(phone ? { 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': 'phone@x' } : {}),
    },
  });

describe('rooms bus tools: scoped to the agent’s workspace', () => {
  it('list_rooms shows only rooms of its own workspace', async () => {
    const r = (await bus('GET', '/bus/rooms')).json();
    expect(r.rooms).toEqual([
      {
        roomId: mine,
        title: 'Mine',
        mode: 'all',
        participants: [{ name: 'Mock A', harness: 'mock' }],
      },
    ]);
  });

  it('a room of another workspace cannot be read or posted to, and looks like a missing room', async () => {
    const read = await bus('GET', `/bus/rooms/${theirs}/messages`);
    const post = await bus('POST', `/bus/rooms/${theirs}/messages`, { text: 'let me in' });
    const ghost = await bus('GET', '/bus/rooms/ghost/messages');
    for (const r of [read, post, ghost]) {
      expect(r.statusCode).toBe(404);
      expect(r.json().error).toBe('unknown_room');
    }
    expect(read.body).not.toContain('secret');
    expect(built.core.rooms.messages(theirs)).toHaveLength(1);
  });

  it('post_to_room posts as the agent; without an @mention nobody is started; read_room since=', async () => {
    const posted = (
      await bus('POST', `/bus/rooms/${mine}/messages`, { text: 'build is green' })
    ).json();
    expect(built.core.rooms.busy(mine)).toBe(false);
    const all = (await bus('GET', `/bus/rooms/${mine}/messages`)).json().messages;
    expect(all.at(-1)).toMatchObject({
      messageId: posted.messageId,
      author: 'Builder',
      authorKind: 'agent',
      text: 'build is green',
    });
    built.core.rooms.post(mine, { kind: 'human', id: null, name: 'Human' }, '@Nobody thanks');
    const since = (
      await bus('GET', `/bus/rooms/${mine}/messages?since=${posted.messageId}`)
    ).json();
    expect(since.messages.map((m: { text: string }) => m.text)).toEqual(['@Nobody thanks']);
  });
});

describe('rooms over the UI API from a phone (remote read-only)', () => {
  it('can read and post, but cannot create rooms, add participants, change mode or stop', async () => {
    expect((await ui('GET', `/api/rooms/${mine}`, undefined, true)).statusCode).toBe(200);
    const post = await ui('POST', `/api/rooms/${mine}/messages`, { text: 'from the phone' }, true);
    expect(post.statusCode).toBe(200);
    for (const [method, url, body] of [
      ['POST', `/api/workspaces/x/rooms`, {}],
      ['POST', `/api/rooms/${mine}/participants`, { harness: 'mock', displayName: 'P' }],
      ['PATCH', `/api/rooms/${mine}`, { mode: 'round' }],
      ['POST', `/api/rooms/${mine}/stop`, {}],
      ['POST', `/api/rooms/${mine}/seed`, { json: '[]', index: 0 }],
    ] as const) {
      const r = await ui(method, url, body, true);
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error).toBe('read_only');
    }
    built.core.rooms.stop(mine);
  });

  it('adding a participant is validated against drivable harnesses', async () => {
    built.core.detections = { mock: { installed: true } }; // so the route never runs a real `claude --version`
    const h = (await ui('GET', '/api/harnesses')).json();
    expect(h.drivable).toEqual(expect.arrayContaining(['mock', 'claude', 'agy']));
    expect(h.drivable).not.toContain('shell');
    const bad = await ui('POST', `/api/rooms/${mine}/participants`, {
      harness: 'shell',
      displayName: 'Sh',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/cannot take part/);
  });
});
