import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Built = Awaited<ReturnType<typeof import('../server.js').buildServer>>;
let built: Built;
let nodeId: string;
let writes: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-reply-home-'));
  const { buildServer } = await import('../server.js');
  const { ptys } = await import('../pty/manager.js');
  writes = vi.spyOn(ptys, 'write').mockReturnValue(true);
  vi.spyOn(ptys, 'isAlive').mockReturnValue(true);
  built = await buildServer({ port: 4792, dbPath: ':memory:', quiet: true });
  const ws = built.core.store.createWorkspace('t', tmpdir());
  nodeId = built.core.store.insertNode({
    workspaceId: ws.id,
    type: 'agent-terminal',
    harness: 'claude',
    title: 'C',
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
  vi.restoreAllMocks();
});

const reply = (body: Record<string, unknown>) =>
  built.app.inject({
    method: 'POST',
    url: `/api/nodes/${nodeId}/reply`,
    headers: { authorization: `Bearer ${built.token}`, host: '127.0.0.1:4792' },
    payload: body,
  });

describe('POST /api/nodes/:id/reply', () => {
  it('sanitises and prefixes a risky single line, then presses Enter', async () => {
    writes.mockClear();
    const r = await reply({ text: '/clear\x1b[A' });
    expect(r.statusCode).toBe(200);
    expect(writes).toHaveBeenCalledWith(nodeId, 'Reply: /clear[A');
    await new Promise((r) => setTimeout(r, 250));
    expect(writes).toHaveBeenLastCalledWith(nodeId, '\r');
  });

  it('refuses free text while the node is waiting at a prompt, but explicit keys still work', async () => {
    built.core.store.updateNode(nodeId, { state: 'needs_input' });
    writes.mockClear();
    const free = await reply({ text: 'yes please' });
    expect(free.statusCode).toBe(409);
    expect(free.json().error).toBe('needs_input_keys_only');
    expect(writes).not.toHaveBeenCalled();
    expect((await reply({ text: 'y', raw: true })).statusCode).toBe(200);
    expect((await reply({ text: 'enter', raw: true })).statusCode).toBe(200);
    expect(writes.mock.calls.map((c) => c[1])).toEqual(['y', '\r']);
    const bad = await reply({ text: 'rm -rf ~\r', raw: true });
    expect(bad.statusCode).toBe(400);
    expect(writes).toHaveBeenCalledTimes(2);
    built.core.store.updateNode(nodeId, { state: 'idle' });
  });
});
