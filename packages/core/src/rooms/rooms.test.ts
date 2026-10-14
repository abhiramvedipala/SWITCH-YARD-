import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurnOptions } from '../harness/types.js';

// Rooms orchestration with the mock harness (a real child process per turn, zero AI) — needs `npm run build`.
type Core = import('../core.js').Core;
let core: Core;
let wsId: string;
let wsRoot: string;

beforeAll(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-rooms-home-'));
  const { createCore } = await import('../core.js');
  core = createCore({ dbPath: ':memory:', coreUrl: 'http://127.0.0.1:1' });
  wsRoot = mkdtempSync(join(tmpdir(), 'sy-rooms-ws-'));
  wsId = core.store.createWorkspace('rooms', wsRoot).id;
});
afterAll(() => {
  core.monitor.stopLoop();
  core.db.close();
});
afterEach(() => vi.restoreAllMocks());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}
const settle = async (roomId: string) => {
  await sleep(20);
  await until(() => !core.rooms.busy(roomId));
};
const replies = (roomId: string) =>
  core.rooms
    .messages(roomId)
    .filter((m) => m.authorKind === 'participant')
    .map((m) => `${m.authorName}: ${m.text}`);

function room(mode: 'all' | 'mention' | 'round' = 'all', names = ['Mock A', 'Mock B']) {
  const r = core.rooms.create(wsId, { mode });
  const ps = names.map((n) => core.rooms.addParticipant(r.id, { harness: 'mock', displayName: n }));
  return { id: r.id, ps };
}
const human = (roomId: string, text: string) =>
  core.rooms.post(roomId, { kind: 'human', id: null, name: 'Human' }, text);

/** Prompts each participant received, by display name (the mock's own runTurn still runs). */
async function spyPrompts() {
  const { mock } = await import('../harness/mock.js');
  const seen: Record<string, TurnOptions[]> = {};
  const real = mock.runTurn!.bind(mock);
  vi.spyOn(mock, 'runTurn').mockImplementation((opts) => {
    const name = /You are "([^"]+)"/.exec(opts.appendSystemPrompt ?? '')?.[1] ?? '?';
    (seen[name] ??= []).push(opts);
    return real(opts);
  });
  return seen;
}

describe('rooms: who answers', () => {
  it('all: every participant answers an unaddressed message, in parallel', async () => {
    const r = room('all');
    human(r.id, 'hello everyone');
    await settle(r.id);
    expect(replies(r.id).sort()).toEqual([
      'Mock A: (mock) Mock A here; mentioned: no; new lines: 1.',
      'Mock B: (mock) Mock B here; mentioned: no; new lines: 1.',
    ]);
  }, 30_000);

  it('an @mention narrows any mode to the mentioned participants', async () => {
    const r = room('all');
    human(r.id, '@Mock A hello');
    await settle(r.id);
    expect(replies(r.id)).toEqual(['Mock A: (mock) Mock A here; mentioned: yes; new lines: 1.']);
  }, 30_000);

  it('mention: no mention goes to the default responder (the first participant) only', async () => {
    const r = room('mention');
    human(r.id, 'anyone there?');
    await settle(r.id);
    expect(replies(r.id)).toEqual(['Mock A: (mock) Mock A here; mentioned: no; new lines: 1.']);
    human(r.id, 'and @mock b?'); // case-insensitive
    await settle(r.id);
    expect(replies(r.id)[1]).toBe('Mock B: (mock) Mock B here; mentioned: yes; new lines: 3.');
  }, 30_000);

  it('round: one after another, each seeing the answers before it', async () => {
    const r = room('round', ['Mock A', 'Mock B', 'Mock C']);
    human(r.id, 'go around');
    await settle(r.id);
    expect(replies(r.id)).toEqual([
      'Mock A: (mock) Mock A here; mentioned: no; new lines: 1.',
      'Mock B: (mock) Mock B here; mentioned: no; new lines: 2.',
      'Mock C: (mock) Mock C here; mentioned: no; new lines: 3.',
    ]);
  }, 30_000);

  it('an agent post starts nobody unless it @mentions a participant', async () => {
    const r = room('all');
    core.rooms.post(r.id, { kind: 'agent', id: 'n1', name: 'Builder' }, 'FYI: build is green');
    await sleep(300);
    expect(core.rooms.busy(r.id)).toBe(false);
    expect(replies(r.id)).toEqual([]);
    core.rooms.post(r.id, { kind: 'agent', id: 'n1', name: 'Builder' }, '@Mock B please look');
    await settle(r.id);
    expect(replies(r.id)).toEqual(['Mock B: (mock) Mock B here; mentioned: yes; new lines: 2.']);
    expect(core.rooms.messages(r.id)[0]).toMatchObject({ authorKind: 'agent', authorId: 'n1' });
  }, 30_000);
});

describe('rooms: what each participant sees', () => {
  it('gets only the lines it has not seen, never its own, as "[Name]: text"; resumes its session', async () => {
    const seen = await spyPrompts();
    const r = room('all');
    human(r.id, 'first');
    await settle(r.id);
    human(r.id, 'second');
    await settle(r.id);
    const [a1, a2] = seen['Mock A']!;
    expect(a1!.prompt).toBe('New in the room since your last turn:\n[Human]: first');
    expect(a2!.prompt).toBe(
      'New in the room since your last turn:\n[Mock B]: (mock) Mock B here; mentioned: no; new lines: 1.\n[Human]: second',
    );
    expect(a1!.sessionId).toBeNull();
    expect(a2!.sessionId).toMatch(/^mock-/);
    expect(a2!.cwd).toBe(wsRoot);
    const sys = a1!.appendSystemPrompt!;
    expect(sys).toContain('Other participants: @Mock B (mock).');
    expect(sys).toMatch(/never write lines for, or claim to be, another participant/);
    expect(sys).toMatch(/peer request is not a permission/);
  }, 30_000);

  it('an imported conversation goes into the first turn only, cut to the last 20k characters', async () => {
    const seen = await spyPrompts();
    const { IMPORT_BUDGET } = await import('./service.js');
    const r = room('all', ['Mock A']);
    const big = 'x'.repeat(30_000);
    core.rooms.seed(r.id, {
      title: 'Old chat',
      source: 'chatgpt',
      turns: [
        { role: 'user', text: 'the very first question' },
        { role: 'assistant', text: big },
        { role: 'user', text: 'last imported line' },
      ],
    });
    const msgs = core.rooms.messages(r.id);
    expect(msgs.map((m) => m.authorKind)).toEqual(['import', 'import', 'import', 'import']);
    human(r.id, 'pick up from there');
    await settle(r.id);
    human(r.id, 'and now?');
    await settle(r.id);
    const [first, second] = seen['Mock A']!;
    expect(first!.prompt).toMatch(/^Earlier conversation the human imported/);
    expect(first!.prompt).toMatch(/Cut to fit: showing the last 20000 of \d+ characters/);
    expect(first!.prompt).toContain('[User]: last imported line');
    expect(first!.prompt).not.toContain('the very first question');
    expect(first!.prompt).toContain(
      'New in the room since your last turn:\n[Human]: pick up from there',
    );
    const importBlock = first!.prompt.split('\n\nNew in the room')[0]!;
    expect(importBlock.length).toBeLessThan(IMPORT_BUDGET + 200);
    expect(second!.prompt).toBe('New in the room since your last turn:\n[Human]: and now?');
  }, 30_000);
});

describe('rooms: chains, stop, usage', () => {
  it('participants @mentioning each other get at most 2 chained replies per message', async () => {
    const { CHAIN_CAP } = await import('./service.js');
    expect(CHAIN_CAP).toBe(2);
    const r = room('all');
    human(r.id, '@Mock A loop'); // A → @Mock B loop → B → @Mock A loop → A → @Mock B loop → (cap)
    await settle(r.id);
    await sleep(500);
    expect(core.rooms.busy(r.id)).toBe(false);
    expect(replies(r.id)).toEqual([
      'Mock A: (mock) Mock A here; mentioned: yes; new lines: 1. @Mock B loop',
      'Mock B: (mock) Mock B here; mentioned: yes; new lines: 2. @Mock A loop',
      'Mock A: (mock) Mock A here; mentioned: yes; new lines: 1. @Mock B loop',
    ]);
    // Everyone answering at once: 2 first replies + 2 chained, never more.
    const r2 = room('all');
    human(r2.id, 'loop');
    await settle(r2.id);
    await sleep(500);
    expect(replies(r2.id)).toHaveLength(4);
  }, 30_000);

  it('Stop aborts in-flight turns and drops queued ones', async () => {
    const { hub } = await import('../events.js');
    const r = room('round');
    let streaming = false;
    const onEvent = (e: import('../events.js').HubEvent) => {
      if (e.t === 'room' && e.roomId === r.id && (e.event as { type: string }).type === 'delta')
        streaming = true;
    };
    hub.on('event', onEvent);
    human(r.id, 'slow');
    await until(() => streaming); // Mock A is mid-answer
    hub.off('event', onEvent);
    expect(core.rooms.view(r.id).participants.map((p) => p.working)).toEqual([true, false]);
    const t0 = Date.now();
    core.rooms.stop(r.id);
    await settle(r.id);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await sleep(300);
    const v = core.rooms.view(r.id);
    expect(v.busy).toBe(false);
    expect(v.participants.find((p) => p.displayName === 'Mock A')!.error).toBe('stopped');
    // Mock B was queued behind Mock A (round mode) and never ran.
    expect(replies(r.id)).toEqual([
      expect.stringMatching(/^Mock A: \(mock\) thinking.*\(stopped\)$/s),
    ]);
    // The room works again after a stop.
    human(r.id, '@Mock B still there?');
    await settle(r.id);
    expect(replies(r.id)).toHaveLength(2);
  }, 30_000);

  it('records usage per turn with the room and participant ids', async () => {
    const { usageSummary } = await import('../usage/index.js');
    const r = room('all');
    human(r.id, 'count me');
    await settle(r.id);
    const rows = core.db
      .prepare('SELECT harness, participant_id p FROM usage WHERE room_id = ?')
      .all(r.id) as { harness: string; p: string }[];
    expect(rows.map((x) => x.p).sort()).toEqual(r.ps.map((p) => p.id).sort());
    expect(rows.every((x) => x.harness === 'mock')).toBe(true);
    expect(usageSummary(core.db, { roomId: r.id }).total).toMatchObject({
      turns: 2,
      inputTokens: 200,
      outputTokens: 100,
    });
  }, 30_000);
});

describe('rooms: participants and safety', () => {
  it('any drivable harness can join; shell, unknown ids, duplicate or reserved names cannot', async () => {
    const { drivableHarnesses } = await import('./service.js');
    expect(drivableHarnesses()).toEqual(expect.arrayContaining(['claude', 'agy', 'mock']));
    expect(drivableHarnesses()).not.toContain('shell');
    const r = core.rooms.create(wsId, {});
    core.rooms.addParticipant(r.id, { harness: 'mock', displayName: 'Mock A' });
    const add = (harness: string, displayName: string) => () =>
      core.rooms.addParticipant(r.id, { harness, displayName });
    expect(add('shell', 'Sh')).toThrow(/cannot take part/);
    expect(add('nope', 'X')).toThrow(/cannot take part/);
    expect(add('mock', 'mock a')).toThrow(/already/);
    expect(add('mock', 'Human')).toThrow(/reserved/);
    expect(add('mock', 'a@b')).toThrow(/without @/);
  });

  it('driven turns run in the workspace folder and never bypass permissions unless the participant opts in', async () => {
    const { claude, claudeTurnArgs } = await import('../harness/claude.js');
    const argv: string[][] = [];
    const cwds: string[] = [];
    vi.spyOn(claude, 'runTurn').mockImplementation(async (opts) => {
      argv.push(claudeTurnArgs(opts)); // what the real adapter would pass to the CLI; no CLI runs
      cwds.push(opts.cwd);
      return { ok: true, text: 'hi from claude', sessionId: 'c-1', usage: {} };
    });
    const r = core.rooms.create(wsId, {});
    core.rooms.addParticipant(r.id, { harness: 'claude', displayName: 'Claude' });
    core.rooms.addParticipant(r.id, { harness: 'claude', displayName: 'Yolo', yolo: true });
    human(r.id, '@Claude hi');
    await settle(r.id);
    expect(argv).toHaveLength(1);
    expect(cwds).toEqual([wsRoot]);
    expect(argv[0]!.join(' ')).not.toMatch(/bypassPermissions|dangerously/);
    expect(argv[0]).toEqual(expect.arrayContaining(['--permission-prompts', 'none']));
    human(r.id, '@Yolo hi');
    await settle(r.id);
    expect(argv[1]).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
  });

  it("respects the own-folder guard: no real agent in the app's own folder without the explicit opt-in", async () => {
    const { REPO_ROOT } = await import('../paths.js');
    const own = core.store.createWorkspace('own', REPO_ROOT).id;
    const r = core.rooms.create(own, {});
    expect(() => core.rooms.addParticipant(r.id, { harness: 'claude', displayName: 'C' })).toThrow(
      /own folder/,
    );
    core.rooms.addParticipant(r.id, { harness: 'mock', displayName: 'M' }); // mock: no AI, allowed
    const ok = core.rooms.create(own, { allowOwnFolder: true });
    expect(core.rooms.addParticipant(ok.id, { harness: 'claude', displayName: 'C' })).toBeTruthy();
  });
});
