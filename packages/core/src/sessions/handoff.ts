/**
 * Hand a session to another harness (October's Moirai idea, local only): any source becomes one transcript
 * model, rendered to HANDOFF-<slug>.md in the target workspace folder, which the new agent reads first.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readClaudeTranscript, type SessionSummary, type TranscriptTurn } from './claude.js';
import { readAgyTranscript } from './agy.js';
import type { ParsedConversation } from './exports.js';

export interface Handoff {
  title: string;
  /** Where it came from: "Claude Code", "Antigravity CLI", "claude.ai", "chatgpt". */
  source: string;
  cwd?: string | null;
  at?: number;
  turns: TranscriptTurn[];
}

/** Characters of transcript kept in the document; the oldest turns are dropped first. */
export const HANDOFF_BUDGET = 24_000;
export const HANDOFF_CLOSING = 'Continue this work. Ask if anything is unclear.';

export function handoffFromClaude(s: Pick<SessionSummary, 'title' | 'cwd' | 'path'>): Handoff {
  if (!s.path) throw new Error('session has no transcript');
  return {
    title: s.title,
    source: 'Claude Code',
    cwd: s.cwd,
    turns: readClaudeTranscript(s.path, { tools: true }),
  };
}

export function handoffFromAgy(s: Pick<SessionSummary, 'title' | 'cwd' | 'path'>): Handoff {
  if (!s.path) throw new Error('conversation has no transcript');
  return {
    title: s.title,
    source: 'Antigravity CLI',
    cwd: s.cwd,
    turns: readAgyTranscript(s.path),
  };
}

export function handoffFromExport(c: ParsedConversation): Handoff {
  return {
    title: c.title,
    source: c.source,
    at: c.createdAt ? Date.parse(c.createdAt) || undefined : undefined,
    turns: c.turns.flatMap((t) => (t.role === 'system' ? [] : [{ role: t.role, text: t.text }])),
  };
}

function renderTurn(t: TranscriptTurn): string {
  if (t.role === 'tool') return `_tool: ${t.text.split('\n')[0]!.slice(0, 160)}_`;
  return `**${t.role === 'user' ? 'User' : 'Assistant'}:** ${t.text.trim()}`;
}

/** Markdown: header, the newest turns that fit the budget (tool calls one line each), closing instruction. */
export function renderHandoff(h: Handoff, budget = HANDOFF_BUDGET): string {
  const body: string[] = [];
  let used = 0;
  for (let i = h.turns.length - 1; i >= 0; i--) {
    let s = renderTurn(h.turns[i]!);
    if (used + s.length > budget) {
      if (body.length) break;
      s = `…${s.slice(-budget)}`; // even the newest turn is over budget: keep its tail
    }
    body.unshift(s);
    used += s.length + 2;
  }
  const shown = body.length;
  const at = [...h.turns].reverse().find((t) => t.at)?.at ?? h.at ?? Date.now();
  return [
    `# Hand-off: ${h.title}`,
    '',
    `- Source: ${h.source}`,
    `- Date: ${new Date(at).toISOString().slice(0, 10)}`,
    `- Folder: ${h.cwd || '(unknown)'}`,
    `- Turns: ${
      shown === h.turns.length
        ? `all ${shown}`
        : `the last ${shown} of ${h.turns.length} (older ones dropped to fit ${budget} characters)`
    }`,
    '',
    '## Transcript',
    '',
    body.join('\n\n'),
    '',
    '---',
    '',
    HANDOFF_CLOSING,
    '',
  ].join('\n');
}

export function handoffSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'session'
  );
}

/** The first prompt of the terminal agent that picks the work up. */
export function handoffPrompt(file: string, source: string): string {
  return `Read ${file} first: it is the hand-off of an earlier ${source} session. ${HANDOFF_CLOSING}`;
}

/**
 * Writes HANDOFF-<slug>.md into `dir` (a numbered name if one is already there) and returns its name and text.
 * The slug is letters, digits and dashes only, so the file can never land outside `dir`; asserted anyway.
 */
export function writeHandoff(
  dir: string,
  h: Handoff,
  budget = HANDOFF_BUDGET,
): { name: string; path: string; markdown: string } {
  const slug = handoffSlug(h.title);
  let name = `HANDOFF-${slug}.md`;
  for (let n = 2; existsSync(join(dir, name)); n++) name = `HANDOFF-${slug}-${n}.md`;
  const path = resolve(dir, name);
  if (!path.startsWith(resolve(dir) + sep))
    throw new Error('hand-off file must stay in the workspace');
  const markdown = renderHandoff(h, budget);
  writeFileSync(path, markdown);
  return { name, path, markdown };
}
