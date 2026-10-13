import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Built = Awaited<ReturnType<typeof import('../server.js').buildServer>>;
let built: Built;
let nodeId: string;

beforeAll(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-feed-home-'));
  const { buildServer } = await import('../server.js');
  built = await buildServer({ port: 4793, dbPath: ':memory:', quiet: true });
  const ws = built.core.store.createWorkspace('t', tmpdir());
  nodeId = built.core.store.insertNode({
    workspaceId: ws.id,
    type: 'agent-terminal',
    harness: 'mock',
    title: 'Mock',
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
});
afterAll(async () => {
  await built.app.close();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  built.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${built.token}`, host: '127.0.0.1:4793', ...headers },
  });

describe('GET /api/attention (cheap to poll)', () => {
  it('requires auth and returns items plus a hash and ETag', async () => {
    expect((await built.app.inject({ method: 'GET', url: '/api/attention' })).statusCode).toBe(401);
    const res = await get('/api/attention');
    const body = res.json();
    expect(body.items).toEqual([]);
    expect(body.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(res.headers.etag).toBe(`"${body.hash}"`);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers 304 when If-None-Match or ?since matches, and 200 once content changes', async () => {
    const { hash } = (await get('/api/attention')).json();
    expect((await get('/api/attention', { 'if-none-match': `"${hash}"` })).statusCode).toBe(304);
    expect((await get(`/api/attention?since=${hash}`)).statusCode).toBe(304);
    built.core.bus.createQuestion(nodeId, 'Which color?');
    const changed = await get(`/api/attention?since=${hash}`);
    expect(changed.statusCode).toBe(200);
    expect(changed.json().items).toHaveLength(1);
    expect(changed.json().hash).not.toBe(hash);
  });

  it('summary reports the count by kind and the same hash', async () => {
    const full = (await get('/api/attention')).json();
    const sum = (await get('/api/attention/summary')).json();
    expect(sum).toEqual({ count: 1, byKind: { question: 1 }, hash: full.hash });
  });

  it('long-poll wakes as soon as something changes', async () => {
    const { hash } = (await get('/api/attention')).json();
    const t0 = Date.now();
    const pending = get(`/api/attention?since=${hash}&wait=10`);
    setTimeout(() => built.core.bus.createQuestion(nodeId, 'And the size?'), 150);
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('long-poll times out with 304 when nothing changes', async () => {
    const { hash } = (await get('/api/attention')).json();
    const t0 = Date.now();
    const res = await get(`/api/attention?since=${hash}&wait=1`);
    expect(res.statusCode).toBe(304);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });
});
