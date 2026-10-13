import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAgySessions, titleFromTranscript } from './agy.js';

describe('agy session scan', () => {
  afterEach(() => delete process.env.SWITCHYARD_AGY_BRAIN);
  it('lists conversations newest first with a title from the first user line', async () => {
    const brain = mkdtempSync(join(tmpdir(), 'brain-'));
    process.env.SWITCHYARD_AGY_BRAIN = brain;
    for (const [id, text, t] of [
      ['aaa', 'fix the build', 1000],
      ['bbb', 'add tests', 2000],
    ] as const) {
      const dir = join(brain, id, '.system_generated', 'logs');
      mkdirSync(dir, { recursive: true });
      const f = join(dir, 'transcript.jsonl');
      writeFileSync(
        f,
        JSON.stringify({ role: 'assistant', content: 'hi' }) +
          '\n' +
          JSON.stringify({ role: 'user', content: text }) +
          '\n',
      );
      utimesSync(f, t, t);
    }
    mkdirSync(join(brain, 'empty'));
    const { sessions } = await listAgySessions();
    expect(sessions.map((s) => [s.sessionId, s.title])).toEqual([
      ['bbb', 'add tests'],
      ['aaa', 'fix the build'],
    ]);
  });
  it('tolerates junk', () => {
    expect(titleFromTranscript('not json\n{"role":"user"')).toBeNull();
  });
  it('reports a note when the folder is missing', async () => {
    process.env.SWITCHYARD_AGY_BRAIN = join(tmpdir(), 'nope-brain');
    expect((await listAgySessions()).sessions).toEqual([]);
  });
});
