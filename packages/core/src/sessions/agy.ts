import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionSummary, TranscriptTurn } from './claude.js';

/**
 * agy keeps one folder per conversation under ~/.gemini/antigravity-cli/brain/<conversation-id>/, with a
 * transcript at .system_generated/logs/transcript.jsonl. We only read the head of each transcript (cheap, no agy
 * process, nothing written) and resume with `agy --conversation <id>`. The transcript schema isn't documented, so
 * the title lookup is defensive: first plausible user text, else the id.
 */
export function agyBrainDir(): string {
  return process.env.SWITCHYARD_AGY_BRAIN ?? join(homedir(), '.gemini/antigravity-cli/brain');
}

const TRANSCRIPT = join('.system_generated', 'logs', 'transcript.jsonl');
const HEAD_BYTES = 64 * 1024;

function readHead(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * One transcript line as a turn, or null when it carries no text. The role is read from `role`, `type` or
 * `source`; a line without one counts as the user's (that is what the title lookup always assumed).
 */
export function agyTurn(obj: unknown): TranscriptTurn | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const r = String(o.role ?? o.type ?? o.source ?? '').toLowerCase();
  const role = /user|human/.test(r)
    ? 'user'
    : /assistant|model|agent/.test(r)
      ? 'assistant'
      : /tool|function/.test(r)
        ? 'tool'
        : r
          ? null
          : 'user';
  if (!role) return null;
  const c = o.content ?? o.text ?? o.message ?? o.prompt;
  const text =
    typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c
            .map((b) =>
              b && typeof b === 'object' ? String((b as { text?: unknown }).text ?? '') : '',
            )
            .join(' ')
            .trim()
        : '';
  if (!text.trim()) return null;
  const ts = o.timestamp ?? o.time ?? o.created_at;
  const at =
    typeof ts === 'number'
      ? ts > 1e12
        ? ts
        : ts * 1000
      : typeof ts === 'string'
        ? Date.parse(ts) || undefined
        : undefined;
  return { role, text, at };
}

export function titleFromTranscript(head: string): string | null {
  for (const line of head.split('\n').slice(0, 200)) {
    if (!line.trim()) continue;
    try {
      const t = agyTurn(JSON.parse(line));
      if (t?.role === 'user') return t.text.replace(/\s+/g, ' ').trim().slice(0, 120);
    } catch {
      // last line of a truncated head, or a non-JSON line
    }
  }
  return null;
}

/** Every turn of an agy transcript; lines that are not JSON objects with text are skipped. */
export function readAgyTranscript(path: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const t = agyTurn(JSON.parse(line));
      if (t) turns.push(t);
    } catch {
      // not JSON
    }
  }
  return turns;
}

export async function listAgySessions(): Promise<{ sessions: SessionSummary[]; note?: string }> {
  const dir = agyBrainDir();
  if (!existsSync(dir))
    return {
      sessions: [],
      note: 'No agy conversations found yet. Use "Continue most recent" or paste a conversation id.',
    };
  const sessions: SessionSummary[] = [];
  for (const id of readdirSync(dir)) {
    const file = join(dir, id, TRANSCRIPT);
    try {
      const st = statSync(file);
      sessions.push({
        harness: 'agy',
        sessionId: id,
        title: titleFromTranscript(readHead(file)) ?? id,
        cwd: null,
        path: file,
        mtime: st.mtimeMs,
      });
    } catch {
      // folder without a transcript (e.g. artifacts only)
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return { sessions: sessions.slice(0, 200) };
}
