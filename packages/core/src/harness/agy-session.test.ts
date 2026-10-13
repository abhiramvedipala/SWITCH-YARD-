import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TurnOptions } from './types.js';

// F8: the persistent agy session against a fake binary that speaks the documented stream-json protocol.
const FAKE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/fake-agy.mjs');
let logFile: string;
let agyMod: typeof import('./agy.js');

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sy-agy-session-'));
  process.env.SWITCHYARD_HOME = join(dir, 'home');
  process.env.SWITCHYARD_GEMINI_DIR = join(dir, 'gemini');
  chmodSync(FAKE, 0o755);
  process.env.SWITCHYARD_AGY_BIN = FAKE; // never the real agy
  logFile = join(dir, 'fake.log');
  process.env.FAKE_AGY_LOG = logFile;
  agyMod = await import('./agy.js');
});
afterAll(() => agyMod.closeAgySessions(undefined, 0));

type Entry = { start?: string[]; recv?: string; busy?: boolean; stdin?: string };
const entries = (): Entry[] =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Entry)
    : [];
const since = (n: number) => entries().slice(n);
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 30));
  return cond();
};
const turn = (key: string, over: Partial<TurnOptions> = {}) =>
  agyMod.agy.runTurn!({ prompt: 'hi', cwd: tmpdir(), sessionKey: key, ...over });

describe('agy persistent session (F8)', () => {
  it('flags: stream-json in and out, slash commands off, bypass only with YOLO', () => {
    const plain = agyMod.agySessionArgs({});
    expect(plain).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
    ]);
    expect(plain.join(' ')).not.toMatch(/dangerously|-p\b/);
    expect(agyMod.agySessionArgs({ sessionId: 'c1', yolo: true }).slice(-3)).toEqual([
      '--conversation',
      'c1',
      '--dangerously-skip-permissions',
    ]);
  });

  it('two turns round-trip on one process; usage is per turn', async () => {
    const n = entries().length;
    const a = await turn('two', { prompt: 'first' });
    expect(a).toMatchObject({ ok: true, text: 'echo 1: first' });
    expect(a.sessionId).toMatch(/^conv-/);
    expect(a.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    const events: string[] = [];
    const b = await turn('two', {
      prompt: 'second',
      sessionId: a.sessionId,
      onEvent: (e) => events.push(e.kind),
    });
    expect(b).toMatchObject({ ok: true, text: 'echo 2: second', sessionId: a.sessionId });
    expect(b.usage).toEqual({ input_tokens: 20, output_tokens: 5 });
    expect(events).toEqual(['status', 'text', 'text', 'tool', 'result', 'status']);
    const log = since(n);
    expect(log.filter((e) => e.start)).toHaveLength(1);
    expect(log.filter((e) => e.recv).map((e) => e.recv)).toEqual(['first', 'second']);
  });

  it('queues: the second prompt is written only after the first result', async () => {
    const n = entries().length;
    const [a, b] = await Promise.all([
      turn('queue', { prompt: '[slow] one' }),
      turn('queue', { prompt: 'two' }),
    ]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    const log = since(n);
    expect(log.filter((e) => e.start)).toHaveLength(1);
    expect(log.filter((e) => e.recv)).toEqual([
      { recv: '[slow] one', busy: false },
      { recv: 'two', busy: false },
    ]);
  });

  it('a crash fails the in-flight turn; the next one restarts with --conversation <last id>', async () => {
    const n = entries().length;
    const a = await turn('crash', { prompt: 'warm up' });
    const b = await turn('crash', { prompt: '[crash] now', sessionId: a.sessionId });
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/agy exited unexpectedly \(exit 3\)/);
    expect(b.sessionId).toBe(a.sessionId);
    const c = await turn('crash', { prompt: 'again', sessionId: b.sessionId });
    expect(c).toMatchObject({ ok: true, sessionId: a.sessionId });
    const starts = since(n).filter((e) => e.start);
    expect(starts).toHaveLength(2);
    expect(starts[1]!.start).toEqual(expect.arrayContaining(['--conversation', a.sessionId!]));
  });

  it('Stop kills the process and fails the turn; the next prompt resumes the conversation', async () => {
    const n = entries().length;
    const a = await turn('stop', { prompt: 'warm up' });
    const ctrl = new AbortController();
    const p = turn('stop', { prompt: '[slow] long', sessionId: a.sessionId, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 100);
    expect(await p).toMatchObject({ ok: false, error: 'stopped', sessionId: a.sessionId });
    expect((await turn('stop', { prompt: 'next', sessionId: a.sessionId })).ok).toBe(true);
    const starts = since(n).filter((e) => e.start);
    expect(starts).toHaveLength(2);
    expect(starts[1]!.start).toEqual(expect.arrayContaining(['--conversation', a.sessionId!]));
  });

  it('a slash-leading prompt is never sent raw', async () => {
    const n = entries().length;
    const r = await turn('slash', { prompt: '/clear' });
    expect(r.ok).toBe(true);
    expect(since(n).find((e) => e.recv)?.recv).toBe('Reply: /clear');
  });

  it('turning YOLO on (or a new conversation) restarts the process with the new flags', async () => {
    const n = entries().length;
    const a = await turn('yolo', { prompt: 'safe' });
    await turn('yolo', { prompt: 'risky', sessionId: a.sessionId, yolo: true });
    const starts = since(n).filter((e) => e.start);
    expect(starts).toHaveLength(2);
    expect(starts[0]!.start).not.toContain('--dangerously-skip-permissions');
    expect(starts[1]!.start).toContain('--dangerously-skip-permissions');
  });

  it('closing a session closes stdin', async () => {
    const n = entries().length;
    await turn('close', { prompt: 'x' });
    agyMod.closeAgySessions('close');
    expect(await until(() => since(n).some((e) => e.stdin === 'end'))).toBe(true);
  });
});

describe('agy persistent session through core (F8)', () => {
  it('chat node: one process for two sends, usage per turn, stdin closed on delete; setting off = -p', async () => {
    const { createCore } = await import('../core.js');
    const { setSetting } = await import('../db/index.js');
    const core = createCore({
      dbPath: join(process.env.SWITCHYARD_HOME!, 'db.sqlite'),
      coreUrl: 'http://127.0.0.1:1',
    });
    const ws = core.store.createWorkspace('w', tmpdir());
    const node = core.nodes.create(ws.id, { type: 'agent-chat', harness: 'agy' });
    setSetting(core.db, 'agyPersistentSessions', true);
    const n = entries().length;
    expect(await core.chat.send(node.id, 'one')).toEqual({ ok: true, error: undefined });
    expect(await core.chat.send(node.id, 'two')).toEqual({ ok: true, error: undefined });
    let log = since(n);
    expect(log.filter((e) => e.start)).toHaveLength(1);
    // First turn carries the coordination blurb (no session yet); the second is the bare text.
    expect(log.filter((e) => e.recv).map((e) => e.recv!.split('\n').at(-1))).toEqual([
      'one',
      'two',
    ]);
    const rows = core.db
      .prepare('SELECT input_tokens i, output_tokens o FROM usage WHERE node_id = ? ORDER BY ts')
      .all(node.id);
    expect(rows).toEqual([
      { i: 10, o: 5 },
      { i: 20, o: 5 },
    ]);
    expect(core.store.getNode(node.id)!.sessionRef).toMatch(/^conv-/);
    // Clear chat ends the process; the next message starts a new conversation.
    core.chat.clear(node.id);
    await core.chat.send(node.id, 'fresh');
    const starts = since(n).filter((e) => e.start);
    expect(starts).toHaveLength(2);
    expect(starts[1]!.start).not.toContain('--conversation');
    const k = entries().length;
    core.nodes.remove(node.id);
    expect(await until(() => since(k).some((e) => e.stdin === 'end'))).toBe(true);

    setSetting(core.db, 'agyPersistentSessions', false);
    const other = core.nodes.create(ws.id, { type: 'agent-chat', harness: 'agy' });
    const m = entries().length;
    await core.chat.send(other.id, 'per turn');
    log = since(m);
    expect(log.find((e) => e.start)?.start).toContain('-p');
    core.monitor.stopLoop();
    core.db.close();
  });
});
