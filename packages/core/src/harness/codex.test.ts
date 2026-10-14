import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedEvent } from './types.js';

// Codex against a fake binary that speaks the documented `codex exec --json` events. Never the real codex.
const FAKE = fileURLToPath(new URL('./__fixtures__/fake-codex.mjs', import.meta.url));
let dir: string;
let logFile: string;
let mod: typeof import('./codex.js');
const savedPath = process.env.PATH;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sy-codex-'));
  process.env.SWITCHYARD_HOME = join(dir, 'home');
  chmodSync(FAKE, 0o755);
  process.env.SWITCHYARD_CODEX_BIN = FAKE;
  logFile = join(dir, 'fake.log');
  process.env.FAKE_CODEX_LOG = logFile;
  mod = await import('./codex.js');
});
afterAll(() => {
  process.env.PATH = savedPath;
  delete process.env.FAKE_CODEX_LOGGED_OUT;
});

type Entry = { argv: string[]; cwd: string; node: string | null; prompt: string };
const entries = (): Entry[] =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Entry)
    : [];

describe('codex runTurn (fake codex)', () => {
  it('runs `codex exec --json` with the prompt on stdin, bus env, and maps events, session and usage', async () => {
    const events: NormalizedEvent[] = [];
    const cwd = mkdtempSync(join(dir, 'cwd-'));
    const res = await mod.codex.runTurn!({
      prompt: 'hello there',
      cwd,
      nodeId: 'n1',
      appendSystemPrompt: 'be brief',
      onEvent: (e) => events.push(e),
    });
    expect(res).toMatchObject({ ok: true, text: 'echo: hello there' });
    expect(res.sessionId).toMatch(/^thr-\d+$/);
    expect(res.usage).toMatchObject({ input_tokens: 11, output_tokens: 7 });
    const e = entries().at(-1)!;
    expect(e.prompt).toBe('hello there');
    expect(e.node).toBe('n1');
    expect(e.cwd).toMatch(/cwd-/);
    expect(e.argv).toEqual(
      mod.codexTurnArgs({ prompt: 'x', cwd, nodeId: 'n1', appendSystemPrompt: 'be brief' }),
    );
    expect(events.map((x) => x.kind)).toEqual([
      'status',
      'tool',
      'tool',
      'text',
      'result',
      'status',
    ]);
    expect(
      events.filter((x) => x.kind === 'tool').map((x) => (x as { name: string }).name),
    ).toEqual(['command', 'mcp__switchyard__check_inbox']);
  });

  it('resumes by thread id and keeps it', async () => {
    const res = await mod.codex.runTurn!({ prompt: 'again', cwd: dir, sessionId: 'thr-abc' });
    expect(res).toMatchObject({ ok: true, sessionId: 'thr-abc' });
    expect(entries().at(-1)!.argv.slice(-2)).toEqual(['resume', 'thr-abc']);
  });

  it('a failed turn is not ok and reports the turn.failed message', async () => {
    const res = await mod.codex.runTurn!({ prompt: '[fail]', cwd: dir });
    expect(res).toMatchObject({ ok: false, error: 'fake failure' });
  });

  it('schema turns carry the schema in the prompt and parse the JSON answer', async () => {
    const schema = { type: 'object', properties: { approve: { type: 'boolean' } } };
    const res = await mod.codex.runTurn!({ prompt: 'review', cwd: dir, schema });
    expect(res.structured).toEqual({ approve: true, findings: [] });
    expect(entries().at(-1)!.prompt).toContain(JSON.stringify(schema));
  });
});

describe('codex detect (fake codex on a temp PATH)', () => {
  it('reports version and sign-in from `codex login status`', async () => {
    const bin = mkdtempSync(join(dir, 'bin-'));
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(join(bin, 'codex'), 0o755);
    process.env.PATH = `${bin}${delimiter}${savedPath}`;
    const d = await mod.codex.detect();
    expect(d).toMatchObject({
      installed: true,
      path: join(bin, 'codex'),
      version: 'codex-cli 0.0.0-fake',
      loggedIn: true,
    });
    expect(d.loginHint).toBeUndefined();
    expect(d.notes?.join(' ')).toMatch(/nothing is written to ~\/\.codex/);
    process.env.FAKE_CODEX_LOGGED_OUT = '1';
    const out = await mod.codex.detect();
    expect(out.loggedIn).toBe(false);
    expect(out.loginHint).toMatch(/codex login/);
  });
});
