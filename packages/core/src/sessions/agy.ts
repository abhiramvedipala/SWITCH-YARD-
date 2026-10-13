import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionSummary } from './claude.js';

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

function userText(obj: Record<string, unknown>): string | null {
  const role = String(obj.role ?? obj.type ?? obj.source ?? '').toLowerCase();
  if (role && !/user|human/.test(role)) return null;
  const c = obj.content ?? obj.text ?? obj.message ?? obj.prompt;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const t = c
      .map((b) => (b && typeof b === 'object' ? String((b as { text?: unknown }).text ?? '') : ''))
      .join(' ')
      .trim();
    return t || null;
  }
  return null;
}

export function titleFromTranscript(head: string): string | null {
  for (const line of head.split('\n').slice(0, 200)) {
    if (!line.trim()) continue;
    try {
      const t = userText(JSON.parse(line) as Record<string, unknown>)
        ?.replace(/\s+/g, ' ')
        .trim();
      if (t) return t.slice(0, 120);
    } catch {
      // last line of a truncated head, or a non-JSON line
    }
  }
  return null;
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
