import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handoffFromClaude,
  handoffFromAgy,
  handoffFromExport,
  renderHandoff,
  handoffSlug,
  writeHandoff,
  HANDOFF_CLOSING,
  type Handoff,
} from './handoff.js';
import { parseExport } from './exports.js';

const jsonl = (lines: unknown[]) =>
  lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';

describe('hand-off converter', () => {
  it('Claude Code: text turns, one tool turn per call, tool results and junk lines skipped', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'sy-ho-')), 's.jsonl');
    writeFileSync(
      p,
      jsonl([
        'not json',
        'null',
        '42',
        '{"type":"user"',
        {
          type: 'user',
          timestamp: '2026-10-01T10:00:00Z',
          message: { content: 'Fix the flaky test' },
        },
        {
          type: 'assistant',
          timestamp: '2026-10-01T10:00:05Z',
          message: { content: [{ type: 'text', text: 'Looking.' }] },
        },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test\n# second' } }],
          },
        },
        { type: 'user', message: { content: [{ type: 'tool_result', content: '1 failed' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed it.' }] } },
        { type: 'user', isMeta: true, message: { content: 'meta line' } },
      ]),
    );
    const h = handoffFromClaude({ title: 'Flaky', cwd: '/w', path: p });
    expect(h.source).toBe('Claude Code');
    expect(h.turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'Fix the flaky test'],
      ['assistant', 'Looking.'],
      ['tool', 'Bash: npm test'],
      ['assistant', 'Fixed it.'],
    ]);
    expect(h.turns[0]!.at).toBe(Date.parse('2026-10-01T10:00:00Z'));
  });

  it('agy transcript: roles from role/type/source, text from content/text/message, junk skipped', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'sy-ho-')), 't.jsonl');
    writeFileSync(
      p,
      jsonl([
        { role: 'user', content: 'add tests', timestamp: 1_700_000_000 },
        '{"broken":',
        { type: 'model', text: [{ text: 'on it' }] },
        { source: 'tool', message: 'read_file: src/a.ts' },
        { role: 'system', content: 'ignored' },
        { role: 'assistant', content: '' },
      ]),
    );
    const h = handoffFromAgy({ title: 'Tests', cwd: null, path: p });
    expect(h.source).toBe('Antigravity CLI');
    expect(h.turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'add tests'],
      ['assistant', 'on it'],
      ['tool', 'read_file: src/a.ts'],
    ]);
    expect(h.turns[0]!.at).toBe(1_700_000_000_000);
  });

  it('chat exports keep their title, source and date', () => {
    const [c] = parseExport([
      {
        name: 'Trip',
        created_at: '2026-09-30T08:00:00Z',
        chat_messages: [
          { sender: 'human', text: 'Plan Lisbon' },
          { sender: 'assistant', text: 'Day 1…' },
        ],
      },
    ]);
    const h = handoffFromExport(c!);
    expect(h).toMatchObject({ title: 'Trip', source: 'claude.ai' });
    expect(h.at).toBe(Date.parse('2026-09-30T08:00:00Z'));
    expect(h.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
  });
});

describe('hand-off renderer', () => {
  const h: Handoff = {
    title: 'Parser refactor',
    source: 'Claude Code',
    cwd: '/work/app',
    turns: Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      text: `turn ${i + 1} ${'x'.repeat(90)}`,
      at: Date.parse('2026-10-02T00:00:00Z') + i * 1000,
    })),
  };

  it('header names source, date and folder; footer is the closing instruction', () => {
    const md = renderHandoff(h);
    expect(md.startsWith('# Hand-off: Parser refactor\n')).toBe(true);
    expect(md).toContain('- Source: Claude Code\n- Date: 2026-10-02\n- Folder: /work/app\n');
    expect(md).toContain('- Turns: all 10\n');
    expect(md.trimEnd().endsWith(`---\n\n${HANDOFF_CLOSING}`)).toBe(true);
    expect(md.match(/^\*\*(User|Assistant):\*\* /gm)).toHaveLength(10);
  });

  it('over budget, the oldest turns are dropped first and the header says so', () => {
    const md = renderHandoff(h, 350);
    expect(md).toContain('- Turns: the last 3 of 10 (older ones dropped to fit 350 characters)');
    expect(md).toContain('turn 10 ');
    expect(md).toContain('turn 8 ');
    expect(md).not.toContain('turn 7 ');
    // A single turn larger than the budget still shows its tail.
    const big = renderHandoff(
      { ...h, turns: [{ role: 'user', text: 'a'.repeat(500) + 'END' }] },
      50,
    );
    expect(big).toContain('…' + 'a'.repeat(47) + 'END');
  });

  it('tool turns are one line each, whatever the call looked like', () => {
    const md = renderHandoff({
      ...h,
      turns: [
        { role: 'user', text: 'go' },
        { role: 'tool', text: 'Bash: npm test\nlots\nof\noutput' },
        { role: 'assistant', text: 'done' },
      ],
    });
    expect(md).toContain('**User:** go\n\n_tool: Bash: npm test_\n\n**Assistant:** done');
    expect(md).not.toContain('lots');
  });
});

describe('hand-off file', () => {
  it('slug is letters, digits and dashes only', () => {
    expect(handoffSlug('Fix: the “flaky” test!')).toBe('fix-the-flaky-test');
    expect(handoffSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(handoffSlug('***')).toBe('session');
    expect(handoffSlug('x'.repeat(100))).toHaveLength(40);
  });

  it('writes HANDOFF-<slug>.md inside the folder, numbering a second one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sy-ho-dir-'));
    const h: Handoff = {
      title: '../../escape',
      source: 'chatgpt',
      turns: [{ role: 'user', text: 'hi' }],
    };
    const a = writeHandoff(dir, h);
    const b = writeHandoff(dir, h);
    expect(a.name).toBe('HANDOFF-escape.md');
    expect(b.name).toBe('HANDOFF-escape-2.md');
    expect(a.path).toBe(join(dir, a.name));
    expect(existsSync(a.path) && existsSync(b.path)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['HANDOFF-escape-2.md', 'HANDOFF-escape.md']);
    expect(a.markdown).toContain(HANDOFF_CLOSING);
  });
});
