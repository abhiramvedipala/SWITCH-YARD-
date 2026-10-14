import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

beforeAll(() => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-vitest-home-'));
  process.env.SWITCHYARD_SCRATCH_ROOT = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../scratch',
  );
});

describe('e2e (mock harness, real bus-mcp over MCP stdio)', () => {
  it('Phase 3 DoD: request/response between connected mocks; unconnected node isolated', async () => {
    const { runBusScenario } = await import('./scenario.js');
    const r = await runBusScenario();
    expect(r.tools).toHaveLength(20);
    expect(r.tools).toContain('whoami');
    expect(r.tools).toContain('wait_for_inbox');
    expect(r.tools).toEqual(expect.arrayContaining(['list_rooms', 'read_room', 'post_to_room']));
    expect(r.tools).toEqual(expect.arrayContaining(['join_switchyard', 'leave_switchyard']));
    expect(r.reply).toMatchObject({ status: 'replied', body: 'pong' });
    expect(r.cPeers).toEqual([]);
    expect(r.cInbox).toEqual([]);
    expect(r.unconnectedError).toMatch(/not_connected/);
  }, 60_000);

  it('Phase 6 DoD: a mock run plans, builds, gets one review round of changes, and finishes approved', async () => {
    const { runRunsScenario } = await import('./runs-scenario.js');
    const r = await runRunsScenario();
    expect(r.status).toBe('done');
    expect(r.approved).toBe(true);
    expect(r.reviewRounds).toBeGreaterThanOrEqual(2);
    expect(r.helloHasDocstring).toBe(true);
    expect(r.gitStatus).toContain('hello.py');
    expect(r.files).toEqual(expect.arrayContaining(['hello.py', 'test_hello.py']));
  }, 60_000);

  it('F3: denied tool calls are recorded on the step and shown on the result card', async () => {
    const { runRunsScenario } = await import('./runs-scenario.js');
    const r = await runRunsScenario(undefined, ' [deny:Bash: python3 -m pytest -q]');
    expect(r.status).toBe('done');
    expect(r.denials).toEqual(['Bash: python3 -m pytest -q']);
  }, 60_000);

  it('F8: persistent agy sessions (fake agy): one process per node/step, crash restart, stdin closed', async () => {
    const { runPersistentScenario } = await import('./persistent-scenario.js');
    const r = await runPersistentScenario();
    expect(r.chatOk).toEqual([true, true, true]);
    expect(r.chatSpawns).toHaveLength(2);
    expect(r.chatSpawns[1]).toEqual(expect.arrayContaining(['--conversation', r.conv!]));
    expect(r.chatBusyOverlap).toBe(false);
    expect(r.crashError).toMatch(/exited unexpectedly/);
    expect(r.usageRows).toBe(4);
    expect(r.chatStdinClosed).toBe(true);
    expect(r.runSpawns).toBe(1);
    expect(r.runPrompts).toBe(r.runBuildTurns);
    expect(r.runPrompts).toBeGreaterThanOrEqual(2);
    expect(r.runStdinClosed).toBe(true);
  }, 90_000);

  it('Rooms: two mock participants and a canvas agent posting through the real bus-mcp', async () => {
    const { runRoomsScenario } = await import('./rooms-scenario.js');
    const r = await runRoomsScenario();
    expect(r.listed).toEqual([expect.objectContaining({ roomId: r.roomId })]);
    expect(r.afterFyi).toBe(0);
    expect(r.afterMention).toEqual(['Mock B: (mock) Mock B here; mentioned: yes; new lines: 2.']);
    expect(r.read.map((m) => `${m.authorKind}:${m.author}`)).toEqual([
      'agent:Builder',
      'participant:Mock B',
      'human:Human',
      expect.stringMatching(/^participant:Mock [AB]$/),
      expect.stringMatching(/^participant:Mock [AB]$/),
    ]);
    expect(r.usageTurns).toBe(3);
  }, 60_000);

  it('Claude Desktop: one bus-mcp process joins as two chats, each scoped by its own edges', async () => {
    const { runDesktopScenario } = await import('./desktop-scenario.js');
    const r = await runDesktopScenario();
    expect(r.gpa).toMatchObject({ nodeId: 'claude-desktop:gpa', name: 'GPA' });
    expect(r.essay.nodeId).toBe('claude-desktop:essay');
    expect(r.gpaPeers).toHaveLength(1);
    expect(r.essayPeers).toEqual([]);
    expect(r.unreadText).toBe(
      'GPA chat has 1 unread — open that chat in Claude and say "check my switchyard inbox"',
    );
    expect(r.gpaInbox).toEqual([expect.objectContaining({ body: 'what grade?' })]);
    expect(r.essayInbox).toEqual([]);
    expect(r.reply).toMatchObject({ status: 'replied', body: 'B+', from: 'claude-desktop:gpa' });
    expect(r.standby).toEqual({
      messages: [expect.objectContaining({ body: 'still there?' })],
      timedOut: false,
    });
    expect(r.standbyMs).toBeGreaterThanOrEqual(250);
    expect(r.standbyMs).toBeLessThan(5000);
    expect(r.essayError).toMatch(/not_connected/);
    expect(r.foreignAsError).toMatch(/unauthorized/);
    expect(r.left).toEqual({ nodeId: 'claude-desktop:essay', left: true });
    expect(r.chatNodes).toEqual([
      { id: 'claude-desktop:gpa', title: 'GPA', left: false },
      { id: 'claude-desktop:essay', title: 'Essay', left: true },
    ]);
  }, 60_000);
});
