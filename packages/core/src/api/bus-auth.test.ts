import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Built = Awaited<ReturnType<typeof import('../server.js').buildServer>>;
type RunFile = import('../auth/capability.js').RunFile;
let built: Built;
let a: string;
let b: string;
let rfA: RunFile;
let rfB: RunFile;

beforeAll(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-busauth-home-'));
  const { buildServer } = await import('../server.js');
  built = await buildServer({ port: 4794, dbPath: ':memory:', quiet: true });
  const { store, caps } = built.core;
  const ws = store.createWorkspace('t', tmpdir());
  const mk = (title: string) =>
    store.insertNode({
      workspaceId: ws.id,
      type: 'agent-terminal',
      harness: 'claude',
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
    }).id;
  a = mk('A');
  b = mk('B');
  rfA = caps.issue(a, ws.id);
  rfB = caps.issue(b, ws.id);
});
afterAll(async () => {
  await built.app.close();
});

const host = { host: '127.0.0.1:4794' };
const call = (node: string, cap: string) =>
  built.app.inject({
    method: 'GET',
    url: '/bus/whoami',
    headers: { ...host, 'x-switchyard-node': node, 'x-switchyard-cap': cap },
  });
const hook = (node: string, secret: string) =>
  built.app.inject({
    method: 'POST',
    url: `/bus/hook/claude/${node}/${secret}`,
    headers: host,
    payload: { hook_event_name: 'SessionStart' },
  });

describe('bus auth (F6): every rejection looks the same', () => {
  it('accepts the current capability and the current hook secret', async () => {
    expect((await call(a, rfA.capability)).json()).toMatchObject({ nodeId: a });
    expect((await hook(a, rfA.hookSecret!)).statusCode).toBe(200);
  });

  it('unknown node, stale cap, foreign cap and wrong hook secret: one status, one body', async () => {
    const stale = rfA; // issue() rotates: whatever the previous process held stops working
    rfA = built.core.caps.issue(a, built.core.store.getNode(a)!.workspaceId);
    const rejected = await Promise.all([
      call('ghost', rfA.capability), // unknown node id
      call(a, stale.capability), // stale (rotated) capability
      call(b, rfA.capability), // foreign: A's cap with B's id
      call(a, rfB.capability), // foreign: B's cap with A's id
      hook(a, stale.hookSecret!), // stale hook secret
      hook(a, 'nope'), // wrong hook secret
      hook(b, rfA.hookSecret!), // cross-node hook secret
      hook('ghost', rfA.hookSecret!), // unknown node on the hook route
    ]);
    for (const r of rejected) {
      expect(r.statusCode).toBe(401);
      expect(r.body).toBe(rejected[0]!.body);
    }
    expect(rejected[0]!.json()).toEqual({
      error: 'unauthorized',
      message: 'unknown node, stale capability or wrong secret',
    });
    // The fresh credentials still work, so the rejections above were about the credentials, not the node.
    expect((await call(a, rfA.capability)).statusCode).toBe(200);
    expect((await hook(a, rfA.hookSecret!)).statusCode).toBe(200);
  });
});
