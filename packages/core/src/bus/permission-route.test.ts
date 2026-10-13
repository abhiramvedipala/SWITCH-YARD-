import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Built = Awaited<ReturnType<typeof import('../server.js').buildServer>>;
let built: Built;
let nodeId: string;
let secret: string;

beforeAll(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-perm-home-'));
  process.env.SWITCHYARD_PERMISSION_TIMEOUT_MS = '5000'; // tests only; real waits are 590 s / 290 s
  const { buildServer } = await import('../server.js');
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
  secret = built.core.caps.issue(nodeId, ws.id).hookSecret!;
});
afterAll(async () => {
  delete process.env.SWITCHYARD_PERMISSION_TIMEOUT_MS;
  await built.app.close();
});

const bash = {
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'echo switchyard-ok > ok.txt' },
};
const send = (body: Record<string, unknown>) =>
  built.app.inject({
    method: 'POST',
    url: `/bus/hook/claude/${nodeId}/${secret}`,
    headers: { host: '127.0.0.1:4792' },
    payload: body,
  });
const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
/** Run fn with a very short permission timeout (to test expiry), then restore the longer one. */
const withShortTimeout = async <T>(fn: () => Promise<T>): Promise<T> => {
  process.env.SWITCHYARD_PERMISSION_TIMEOUT_MS = '250';
  try {
    return await fn();
  } finally {
    process.env.SWITCHYARD_PERMISSION_TIMEOUT_MS = '5000';
  }
};
const openOne = () => built.core.permissions.open()[0]!;

describe('Claude PermissionRequest hook', () => {
  it('holds the request open, shows the command, and Allow returns the allow decision', async () => {
    const pending = send(bash);
    await until(() => built.core.permissions.open().length === 1);
    const item = openOne();
    expect(item).toMatchObject({
      nodeId,
      source: 'claude',
      toolName: 'Bash',
      options: ['allow', 'deny'],
    });
    expect(item.detail).toContain('echo switchyard-ok > ok.txt');
    expect(built.core.store.getNode(nodeId)!.state).toBe('needs_input');
    expect(built.core.permissions.decide(item.id, 'allow')).toBe(true);
    const res = await pending;
    expect(res.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(built.core.store.getNode(nodeId)!.state).toBe('working');
    expect(built.core.permissions.open()).toEqual([]);
  });

  it('Deny returns the deny decision', async () => {
    const pending = send(bash);
    await until(() => built.core.permissions.open().length === 1);
    built.core.permissions.decide(openOne().id, 'deny');
    expect((await pending).json().hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it('never auto-allows: with no click it times out to {} so the terminal prompt takes over', async () => {
    const res = await withShortTimeout(() => send(bash));
    expect(res.json()).toEqual({});
    expect(built.core.permissions.open()).toEqual([]);
  });

  it('a wrong secret is rejected and creates no request', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: `/bus/hook/claude/${nodeId}/wrong`,
      headers: { host: '127.0.0.1:4792' },
      payload: bash,
    });
    expect(res.statusCode).toBe(401);
    expect(built.core.permissions.open()).toEqual([]);
  });

  it('ignores subagent events (agent_id)', async () => {
    const res = await send({ ...bash, agent_id: 'sub-1' });
    expect(res.json()).toEqual({});
    expect(built.core.permissions.open()).toEqual([]);
  });

  it('restarting or removing the node drops what it was waiting on', async () => {
    const pending = send(bash);
    await until(() => built.core.permissions.open().length === 1);
    built.core.nodes.onReset(nodeId);
    expect((await pending).json()).toEqual({});
  });
});

describe('agy PreToolUse ask_permission hook (capability-authenticated relay route)', () => {
  // issue() rotates the node's secrets, so do it once here and reuse the capability.
  let agyCap: { capability: string };
  beforeAll(() => {
    const rf = built.core.caps.issue(nodeId, built.core.store.getNode(nodeId)!.workspaceId);
    agyCap = rf;
    secret = rf.hookSecret!;
  });
  const agyPost = (payload: Record<string, unknown>) =>
    built.app.inject({
      method: 'POST',
      url: '/bus/agy/hook',
      headers: {
        host: '127.0.0.1:4792',
        'x-switchyard-node': nodeId,
        'x-switchyard-cap': agyCap.capability,
      },
      payload: { event: 'PreToolUse', payload },
    });
  const ask = { toolCall: { name: 'ask_permission', args: { command: 'rm -rf build' } } };

  it('ignores other tools (no decision)', async () => {
    const res = await agyPost({ toolCall: { name: 'run_command', args: { command: 'ls' } } });
    expect(res.json()).toEqual({});
    expect(built.core.permissions.open()).toEqual([]);
  });

  it('shows the request with Allow, Deny and Ask-in-terminal; Allow returns allow', async () => {
    const pending = agyPost(ask);
    await until(() => built.core.permissions.open().length === 1);
    const item = openOne();
    expect(item).toMatchObject({
      source: 'agy',
      toolName: 'ask_permission',
      options: ['allow', 'deny', 'ask'],
    });
    expect(item.detail).toContain('rm -rf build');
    built.core.permissions.decide(item.id, 'allow');
    expect((await pending).json().decision).toBe('allow');
  });

  it('Deny returns deny, and "ask in terminal" returns ask', async () => {
    let pending = agyPost(ask);
    await until(() => built.core.permissions.open().length === 1);
    built.core.permissions.decide(openOne().id, 'deny');
    expect((await pending).json().decision).toBe('deny');
    pending = agyPost(ask);
    await until(() => built.core.permissions.open().length === 1);
    built.core.permissions.decide(openOne().id, 'ask');
    expect((await pending).json().decision).toBe('ask');
  });

  it('times out to ask, never allow', async () => {
    expect((await withShortTimeout(() => agyPost(ask))).json().decision).toBe('ask');
  });
});

describe('permission items in the attention feed and the decide API', () => {
  const api = (
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    built.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${built.token}`, host: '127.0.0.1:4792', ...headers },
      payload,
    });

  it('lists the request once (no duplicate screen card), and Allow via the API releases the hook', async () => {
    const pending = send(bash);
    await until(() => built.core.permissions.open().length === 1);
    const feed = (await api('GET', '/api/attention')).json().items as Array<
      Record<string, unknown>
    >;
    const mine = feed.filter((i) => i.nodeId === nodeId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      kind: 'permission',
      toolName: 'Bash',
      source: 'claude',
      options: ['allow', 'deny'],
    });
    expect(String(mine[0]!.text)).toContain('echo switchyard-ok');
    const res = await api('POST', `/api/permissions/${mine[0]!.id}/decide`, { decision: 'allow' });
    expect(res.statusCode).toBe(200);
    expect((await pending).json().hookSpecificOutput.decision.behavior).toBe('allow');
  });

  it('a stale or unknown request is a 404, and "ask" is not offered for Claude', async () => {
    expect(
      (await api('POST', '/api/permissions/nope/decide', { decision: 'allow' })).statusCode,
    ).toBe(404);
    const pending = send(bash);
    await until(() => built.core.permissions.open().length === 1);
    const id = openOne().id;
    expect(
      (await api('POST', `/api/permissions/${id}/decide`, { decision: 'ask' })).statusCode,
    ).toBe(404);
    built.core.permissions.decide(id, 'deny');
    await pending;
  });

  it('a read-only remote session may still decide, but cannot do other writes', async () => {
    const remote = { 'x-forwarded-for': '100.101.102.103' };
    const pending = send(bash);
    await until(() => built.core.permissions.open().length === 1);
    const ok = await api(
      'POST',
      `/api/permissions/${openOne().id}/decide`,
      { decision: 'deny' },
      remote,
    );
    expect(ok.statusCode).toBe(200);
    await pending;
    const blocked = await api('POST', '/api/workspaces', { rootDir: tmpdir() }, remote);
    expect(blocked.statusCode).toBe(403);
  });
});
