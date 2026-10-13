import { MOCK_AGENT_ENTRY } from '../paths.js';
import type {
  Harness,
  NodeCtx,
  TerminalLaunch,
  TurnOptions,
  TurnResult,
  NormalizedEvent,
} from './types.js';
import { runNdjson, busEnv } from './util.js';

/**
 * A scripted stand-in agent: same bus-mcp server, same NDJSON plumbing, zero AI usage.
 * Interactive in a terminal (type `help`), and deterministic in driven mode for Runs.
 */
export const mock: Harness = {
  id: 'mock',
  label: 'Mock agent (no AI)',
  isAgent: true,
  async detect() {
    return { installed: true, path: MOCK_AGENT_ENTRY, version: 'built-in' };
  },
  terminalLaunch(ctx: NodeCtx): TerminalLaunch {
    return {
      cmd: process.execPath,
      args: [MOCK_AGENT_ENTRY],
      env: busEnv(ctx.node.id),
      cwd: ctx.cwd,
    };
  },
  async runTurn(opts: TurnOptions): Promise<TurnResult> {
    let text = '';
    let result:
      | {
          text: string;
          sessionId: string | null;
          structured?: unknown;
          ok?: boolean;
          error?: string;
        }
      | undefined;
    const emit = (e: NormalizedEvent) => opts.onEvent?.(e);
    emit({ kind: 'status', state: 'working' });
    const run = await runNdjson(process.execPath, [MOCK_AGENT_ENTRY, '--turn'], {
      cwd: opts.cwd,
      env: opts.nodeId ? busEnv(opts.nodeId) : {},
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      stdin: JSON.stringify({
        prompt: opts.prompt,
        schema: opts.schema ?? null,
        sessionId: opts.sessionId ?? null,
      }),
      onLine: (obj) => {
        if (obj.kind === 'result') {
          result = obj as typeof result;
          return;
        }
        if (obj.kind === 'text') text += String(obj.delta ?? '');
        emit(obj as NormalizedEvent);
      },
    });
    const ok = !!result && result.ok !== false && run.code === 0 && !run.aborted;
    emit({ kind: 'result', text: result?.text ?? text, sessionId: result?.sessionId ?? null });
    emit({ kind: 'status', state: 'idle' });
    return {
      ok,
      text: result?.text ?? text,
      structured: result?.structured,
      sessionId: result?.sessionId ?? null,
      error: ok
        ? undefined
        : (result?.error ??
          (run.aborted ? 'stopped' : run.stderr.slice(-2000) || `exit ${run.code}`)),
    };
  },
};
