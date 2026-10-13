import { which, runCapture } from '../harness/util.js';
import type { SessionSummary } from './claude.js';

/**
 * agy's docs (cli/conversations) describe resuming via `agy -c` / `--conversation <id>` and an interactive
 * picker, but document no machine-readable listing command or on-disk location. We probe `agy --help` for a
 * conversations subcommand and use it only if present; otherwise the UI offers "continue most recent here"
 * and "resume by id".
 */
export async function listAgySessions(): Promise<{ sessions: SessionSummary[]; note?: string }> {
  const bin = which('agy');
  if (!bin) return { sessions: [], note: 'agy is not installed.' };
  const help = await runCapture(bin, ['--help'], { timeoutMs: 5000 });
  const text = help.stdout + help.stderr;
  if (!/\bconversations\b/.test(text)) {
    return {
      sessions: [],
      note: 'This agy version has no documented conversation-listing command. Use "Continue most recent" (agy -c, scoped to the folder) or paste a conversation id.',
    };
  }
  const res = await runCapture(bin, ['conversations', 'list', '--output-format', 'json'], {
    timeoutMs: 10_000,
  });
  if (res.code !== 0)
    return { sessions: [], note: `agy conversations list failed: ${res.stderr.slice(0, 300)}` };
  try {
    const parsed = JSON.parse(res.stdout) as unknown;
    const arr = (
      Array.isArray(parsed)
        ? parsed
        : ((parsed as { conversations?: unknown[] }).conversations ?? [])
    ) as Array<Record<string, unknown>>;
    return {
      sessions: arr
        .map((c) => ({
          harness: 'agy' as const,
          sessionId: String(c.conversation_id ?? c.id ?? ''),
          title: String(c.title ?? c.summary ?? c.conversation_id ?? '(untitled)'),
          cwd: (c.cwd as string | undefined) ?? (c.workspace as string | undefined) ?? null,
          mtime: Date.parse(String(c.updated_at ?? c.last_updated ?? '')) || 0,
        }))
        .filter((s) => s.sessionId),
    };
  } catch {
    return { sessions: [], note: 'Could not parse agy conversation list output.' };
  }
}
