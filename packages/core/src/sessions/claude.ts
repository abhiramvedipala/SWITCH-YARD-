import {
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SessionSummary {
  harness: 'claude' | 'agy';
  sessionId: string;
  title: string;
  cwd: string | null;
  path?: string;
  mtime: number;
  messageCount?: number;
}

export function claudeProjectsDir(): string {
  return process.env.SWITCHYARD_CLAUDE_PROJECTS ?? join(homedir(), '.claude/projects');
}

function readHead(path: string, maxBytes = 256 * 1024): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && (b as { type?: string }).type === 'text'
          ? String((b as { text?: string }).text ?? '')
          : '',
      )
      .join(' ');
  }
  return '';
}

function isNoise(text: string): boolean {
  const t = text.trim();
  return (
    t.length === 0 ||
    t.startsWith('<command-') ||
    t.startsWith('<local-command') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('Caveat:') ||
    t.startsWith('[Request interrupted')
  );
}

/** Parse just enough of a Claude Code transcript to list it: title, cwd, session id. */
export function summarizeClaudeTranscript(path: string): SessionSummary | null {
  let head: string;
  try {
    head = readHead(path);
  } catch {
    return null;
  }
  const lines = head.split('\n');
  if (!head.endsWith('\n')) lines.pop(); // last line may be cut off
  let title: string | null = null;
  let summary: string | null = null;
  let cwd: string | null = null;
  let sessionId: string | null = null;
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === 'summary' && typeof obj.summary === 'string' && !summary)
      summary = obj.summary;
    if (obj.type === 'custom-title' && typeof obj.customTitle === 'string')
      summary = obj.customTitle;
    if (typeof obj.cwd === 'string' && !cwd) cwd = obj.cwd;
    if (typeof obj.sessionId === 'string' && !sessionId) sessionId = obj.sessionId;
    if (obj.type === 'user' || obj.type === 'assistant') count++;
    if (obj.type === 'user' && !title && obj.isMeta !== true) {
      const t = textOf((obj.message as { content?: unknown } | undefined)?.content);
      if (!isNoise(t)) title = t.replace(/\s+/g, ' ').trim().slice(0, 140);
    }
  }
  const st = statSync(path);
  const fileId = path
    .split('/')
    .pop()!
    .replace(/\.jsonl$/, '');
  if (count === 0 && !summary) return null;
  return {
    harness: 'claude',
    sessionId: sessionId ?? fileId,
    title: summary ?? title ?? '(untitled session)',
    cwd,
    path,
    mtime: st.mtimeMs,
    messageCount: count,
  };
}

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'tool';
  /** A tool turn's text is `name: what` on its first line (the renderer keeps only that line). */
  text: string;
  at?: number;
}

/** One line for a tool call: its name and the argument a person would recognise it by. */
export function toolLine(name: unknown, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const what = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description;
  const s = what === undefined ? JSON.stringify(i) : String(what);
  return `${String(name ?? 'tool')}: ${s.split('\n')[0]!.slice(0, 160)}`;
}

/**
 * The user/assistant text of a Claude Code transcript in order; meta lines and tool results are skipped.
 * With `tools`, each tool call becomes a one-line `tool` turn (for hand-offs). Lines that are not JSON
 * objects are ignored.
 */
export function readClaudeTranscript(
  path: string,
  opts: { tools?: boolean } = {},
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const role = obj.type;
    if ((role !== 'user' && role !== 'assistant') || obj.isMeta === true) continue;
    const at =
      typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) || undefined : undefined;
    const content = (obj.message as { content?: unknown } | undefined)?.content;
    if (opts.tools && Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown> | null>) {
        if (b?.type === 'tool_use')
          turns.push({ role: 'tool', text: toolLine(b.name, b.input), at });
      }
    }
    const text = textOf(content).trim();
    if (isNoise(text)) continue;
    const last = turns.at(-1);
    // An assistant reply is written as one line per content block: join them back into one turn.
    if (last?.role === role) last.text += `\n${text}`;
    else turns.push({ role, text, at });
  }
  return turns;
}

export function listClaudeSessions(limit = 300): SessionSummary[] {
  const root = claudeProjectsDir();
  if (!existsSync(root)) return [];
  const files: { path: string; mtime: number }[] = [];
  for (const proj of readdirSync(root)) {
    const dir = join(root, proj);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      try {
        files.push({ path: p, mtime: statSync(p).mtimeMs });
      } catch {
        // vanished
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: SessionSummary[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const s = summarizeClaudeTranscript(f.path);
    if (s) out.push(s);
  }
  return out;
}
