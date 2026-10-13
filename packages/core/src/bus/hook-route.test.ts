import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Built = Awaited<ReturnType<typeof import('../server.js').buildServer>>;
let built: Built;
let a: string;
let b: string;
let secretA: string;
let secretB: string;
let writes: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-hook-home-'));
  const { buildServer } = await import('../server.js');
  const { ptys } = await import('../pty/manager.js');
  writes = vi.spyOn(ptys, 'write');
  built = await buildServer({ port: 4791, dbPath: ':memory:', quiet: true });
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
  store.createEdge(ws.id, a, b);
  secretA = caps.issue(a, ws.id).hookSecret!;
  secretB = caps.issue(b, ws.id).hookSecret!;
});
afterAll(async () => {
  await built.app.close();
  writes.mockRestore();
});

const hook = (nodeId: string, secret: string, body: Record<string, unknown>) =>
  built.app.inject({
    method: 'POST',
    url: `/bus/hook/claude/${nodeId}/${secret}`,
    headers: { host: '127.0.0.1:4791' }, // no capability headers: auth is the path secret
    payload: body,
  });
const stop = (extra: Record<string, unknown> = {}) =>
  hook(b, secretB, { hook_event_name: 'Stop', stop_hook_active: false, ...extra });

describe('Claude Stop hook route (message delivery without PTY typing)', () => {
  it('rejects a wrong secret and an unknown node with the same 401', async () => {
    const wrong = await hook(b, 'nope', { hook_event_name: 'Stop' });
    const unknown = await hook('ghost', secretB, { hook_event_name: 'Stop' });
    const crossNode = await hook(b, secretA, { hook_event_name: 'Stop' });
    for (const r of [wrong, unknown, crossNode]) expect(r.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    expect(wrong.body).toBe(crossNode.body);
  });

  it('is {} with nothing waiting, and stores last_assistant_message as the summary (<=800)', async () => {
    const r = await stop({ last_assistant_message: 'x'.repeat(2000) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({});
    expect(built.core.store.getNode(b)!.summary).toHaveLength(800);
  });

  it('blocks once for a pending request, then {} after check_inbox', async () => {
    built.core.bus.sendMessage(a, { peerId: b, intent: 'request', body: 'what is 2+2?' });
    const r = await stop();
    expect(r.json()).toMatchObject({ decision: 'block' });
    expect(r.json().reason).toMatch(/check_inbox/);
    expect(built.core.store.getNode(b)!.state).toBe('working');
    expect(built.core.bus.checkInbox(b)).toHaveLength(1);
    expect((await stop()).json()).toEqual({});
    expect(built.core.store.getNode(b)!.state).toBe('idle');
  });

  it('never blocks when stop_hook_active is true', async () => {
    built.core.bus.sendMessage(a, { peerId: b, intent: 'request', body: 'again' });
    expect((await stop({ stop_hook_active: true })).json()).toEqual({});
    built.core.bus.checkInbox(b);
  });

  it('caps consecutive blocks at 3, then only adds context', async () => {
    built.core.bus.sendMessage(a, { peerId: b, intent: 'request', body: 'ignored one' });
    const outs = [];
    for (let i = 0; i < 4; i++) outs.push((await stop()).json());
    expect(outs.slice(0, 3).every((o) => o.decision === 'block')).toBe(true);
    expect(outs[3].decision).toBeUndefined();
    expect(outs[3].hookSpecificOutput).toMatchObject({
      hookEventName: 'Stop',
      additionalContext: expect.stringContaining('check_inbox'),
    });
    built.core.bus.checkInbox(b);
    // A fresh user prompt starts a new budget.
    await hook(b, secretB, { hook_event_name: 'UserPromptSubmit' });
    built.core.bus.sendMessage(a, { peerId: b, intent: 'request', body: 'new turn' });
    expect((await stop()).json()).toMatchObject({ decision: 'block' });
    built.core.bus.checkInbox(b);
  });

  it('notify-only backlog is context, not a block', async () => {
    built.core.bus.sendMessage(a, { peerId: b, intent: 'notify', body: 'fyi' });
    const o = (await stop()).json();
    expect(o.decision).toBeUndefined();
    expect(o.hookSpecificOutput.additionalContext).toMatch(/1 switchyard message is waiting/);
    built.core.bus.checkInbox(b);
  });

  it('ignores subagent events (agent_id) entirely', async () => {
    built.core.bus.sendMessage(a, { peerId: b, intent: 'request', body: 'sub' });
    const r = await stop({ agent_id: 'sub-1', last_assistant_message: 'from subagent' });
    expect(r.json()).toEqual({});
    expect(built.core.store.getNode(b)!.summary).not.toBe('from subagent');
    built.core.bus.checkInbox(b);
  });

  it('wrote nothing to any PTY and sent no nudges', () => {
    expect(writes).not.toHaveBeenCalled();
    expect(built.core.monitor.nudgeCount).toBe(0);
  });
});

describe('PTY nudge is a last resort', () => {
  it('follows the policy: Claude opt-in only, hook-driven or mock only, never while needs_input', async () => {
    const { monitor, store } = built.core;
    const { ptys } = await import('../pty/manager.js');
    const alive = vi.spyOn(ptys, 'isAlive').mockReturnValue(true);
    const ws = store.getNode(b)!.workspaceId;
    const mk = (harness: string) =>
      store.insertNode({
        workspaceId: ws,
        type: 'agent-terminal',
        harness,
        title: harness,
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
    try {
      // b is a hook-driven Claude node (it received hooks above): off by default.
      expect(monitor.canNudge(b)).toBe(false);
      store.updateNode(b, { data: { autoNudge: true } });
      expect(monitor.canNudge(b)).toBe(true);
      store.updateNode(b, { state: 'needs_input' });
      expect(monitor.canNudge(b)).toBe(false);
      store.updateNode(b, { state: 'idle', data: {} });
      expect(monitor.canNudge(mk('mock'))).toBe(true);
      const agyId = mk('agy');
      expect(monitor.canNudge(agyId)).toBe(false); // quiet heuristic is not authoritative
      monitor.onHook(agyId, 'agy', 'Stop', {}); // an authoritative hook arrives
      expect(monitor.canNudge(agyId)).toBe(true);
    } finally {
      alive.mockRestore();
    }
    expect(built.core.monitor.nudgeCount).toBe(0);
  });
});
