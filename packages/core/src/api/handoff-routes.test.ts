import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// POST /api/workspaces/:id/handoff: HANDOFF-<slug>.md in the workspace folder + a node that reads it first.
// No agent is ever spawned here: ptys.spawn is stubbed and its argv inspected.
type Built = Awaited<ReturnType<typeof import('../server.js').buildServer>>;
const PORT = 4796;
let built: Built;
let spawn: ReturnType<typeof vi.fn>;
let setSetting: typeof import('../db/index.js').setSetting;
let REPO_ROOT: string;
let wsId: string;
let wsDir: string;

const CLAUDE_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const AGY_ID = 'conv-77';

beforeAll(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-handoff-home-'));
  // agy's launch refreshes the switchyard MCP entry in <gemini dir>/config: never the real ~/.gemini here.
  process.env.SWITCHYARD_GEMINI_DIR = mkdtempSync(join(tmpdir(), 'sy-handoff-gemini-'));
  const projects = mkdtempSync(join(tmpdir(), 'sy-handoff-claude-'));
  process.env.SWITCHYARD_CLAUDE_PROJECTS = projects;
  mkdirSync(join(projects, '-tmp-x'));
  writeFileSync(
    join(projects, '-tmp-x', `${CLAUDE_ID}.jsonl`),
    [
      {
        type: 'user',
        cwd: '/tmp/x',
        sessionId: CLAUDE_ID,
        message: { content: 'Refactor the parser' },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'p.ts' } }] },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Split into three.' }] } },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n',
  );
  const brain = mkdtempSync(join(tmpdir(), 'sy-handoff-brain-'));
  process.env.SWITCHYARD_AGY_BRAIN = brain;
  mkdirSync(join(brain, AGY_ID, '.system_generated', 'logs'), { recursive: true });
  writeFileSync(
    join(brain, AGY_ID, '.system_generated', 'logs', 'transcript.jsonl'),
    JSON.stringify({ role: 'user', content: 'add tests' }) + '\n',
  );
  const { buildServer } = await import('../server.js');
  const { ptys } = await import('../pty/manager.js');
  ({ setSetting } = await import('../db/index.js'));
  ({ REPO_ROOT } = await import('../paths.js'));
  spawn = vi.spyOn(ptys, 'spawn').mockImplementation(() => ({}) as never) as never;
  built = await buildServer({
    port: PORT,
    dbPath: ':memory:',
    quiet: true,
    whois: async (ip) => (ip === '100.64.0.9' ? 'phone@x' : null),
  });
  wsDir = mkdtempSync(join(tmpdir(), 'sy-handoff-ws-'));
  wsId = built.core.store.createWorkspace('target', wsDir).id;
});
afterAll(async () => {
  await built.app.close();
  delete process.env.SWITCHYARD_CLAUDE_PROJECTS;
  delete process.env.SWITCHYARD_AGY_BRAIN;
  delete process.env.SWITCHYARD_GEMINI_DIR;
});

const post = (ws: string, payload: unknown, phone = false) =>
  built.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/handoff`,
    payload: payload as never,
    headers: {
      host: `127.0.0.1:${PORT}`,
      authorization: `Bearer ${built.token}`,
      ...(phone ? { 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': 'phone@x' } : {}),
    },
  });
const files = (dir: string) => readdirSync(dir).filter((f) => /^HANDOFF-.*\.md$/.test(f));
const lastArgs = () => (spawn.mock.calls.at(-1)![1] as { cmd: string; args: string[] }).args;

describe('hand-off route', () => {
  it('Claude Code session → claude terminal: file in the workspace folder, prompt says to read it, no bypass', async () => {
    const r = await post(wsId, { claudeSessionId: CLAUDE_ID, harness: 'claude' });
    expect(r.statusCode).toBe(200);
    const { node, file } = r.json();
    expect(file).toBe('HANDOFF-refactor-the-parser.md');
    const md = readFileSync(join(wsDir, file), 'utf8');
    expect(md).toContain('# Hand-off: Refactor the parser');
    expect(md).toContain('- Source: Claude Code');
    expect(md).toContain('_tool: Read: p.ts_');
    expect(md).toContain('Continue this work. Ask if anything is unclear.');
    expect(node).toMatchObject({
      type: 'agent-terminal',
      harness: 'claude',
      cwd: wsDir,
      title: 'Hand-off: Refactor the parser',
    });
    const args = lastArgs();
    expect(args.at(-1)).toMatch(/^Read HANDOFF-refactor-the-parser\.md first/);
    expect(args.at(-1)).toContain('Continue this work. Ask if anything is unclear.');
    expect(args).toContain('--append-system-prompt');
    expect(args.join(' ')).not.toMatch(/bypassPermissions|dangerously/);
  });

  it('agy conversation → agy terminal: -i <prompt>', async () => {
    const r = await post(wsId, { agySessionId: AGY_ID, harness: 'agy' });
    expect(r.statusCode).toBe(200);
    expect(r.json().file).toBe('HANDOFF-add-tests.md');
    expect(r.json().file).toBe('HANDOFF-add-tests.md');
    const args = lastArgs();
    expect(args[args.indexOf('-i') + 1]).toMatch(/^Read HANDOFF-add-tests\.md first/);
    expect(args.join(' ')).not.toContain('dangerously');
  });

  it('export conversation → chat node: the hand-off text is its first turn', async () => {
    const send = vi.spyOn(built.core.chat, 'send').mockResolvedValue({ ok: true });
    const json = JSON.stringify([
      { name: 'Trip', chat_messages: [{ sender: 'human', text: 'Plan Lisbon' }] },
    ]);
    const r = await post(wsId, { json, index: 0, harness: 'mock', chat: true });
    expect(r.statusCode).toBe(200);
    const { node, file } = r.json();
    expect(node).toMatchObject({ type: 'agent-chat', harness: 'mock', title: 'Hand-off: Trip' });
    expect(send).toHaveBeenCalledWith(node.id, readFileSync(join(wsDir, file), 'utf8'));
    send.mockRestore();
  });

  it('refuses a phone session even when remote writes are allowed', async () => {
    setSetting(built.core.db, 'remoteReadOnly', false);
    const before = files(wsDir).length;
    const r = await post(wsId, { claudeSessionId: CLAUDE_ID, harness: 'claude' }, true);
    setSetting(built.core.db, 'remoteReadOnly', true);
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toMatch(/computer itself/);
    expect(files(wsDir)).toHaveLength(before);
  });

  it("refuses the app's own folder and writes nothing there", async () => {
    const own = built.core.store.createWorkspace('own', REPO_ROOT).id;
    const r = await post(own, { claudeSessionId: CLAUDE_ID, harness: 'mock' });
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toMatch(/own folder/);
    expect(files(REPO_ROOT)).toEqual([]);
  });

  it('refuses unknown sessions and unfit harnesses before writing anything', async () => {
    const before = files(wsDir).length;
    const calls = spawn.mock.calls.length;
    expect((await post(wsId, { claudeSessionId: 'nope', harness: 'claude' })).statusCode).toBe(400);
    expect((await post(wsId, { claudeSessionId: CLAUDE_ID, harness: 'shell' })).statusCode).toBe(
      400,
    );
    expect(
      (await post(wsId, { claudeSessionId: CLAUDE_ID, harness: 'api-anthropic' })).statusCode,
    ).toBe(400);
    expect((await post(wsId, { harness: 'claude' })).statusCode).toBe(400);
    expect(files(wsDir)).toHaveLength(before);
    expect(spawn.mock.calls).toHaveLength(calls);
  });
});
