import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface RunFile {
  nodeId: string;
  workspaceId: string;
  coreUrl: string;
  capability: string;
}

export function switchyardHome(): string {
  const h = process.env.SWITCHYARD_HOME;
  return h && !h.startsWith('$') ? h : join(homedir(), '.switchyard');
}

function cwdKey(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 32);
}

/**
 * Who am I? SWITCHYARD_NODE from the environment first (Claude passes it via --mcp-config env; agy nodes get it
 * on their PTY). A literal "$SWITCHYARD_NODE" means the host didn't expand it, so fall back to the identity file
 * core writes per agent cwd.
 */
export function resolveNodeId(cwd = process.cwd()): string | null {
  const env = process.env.SWITCHYARD_NODE;
  if (env && !env.startsWith('$')) return env;
  const p = join(switchyardHome(), 'run', 'by-cwd', `${cwdKey(cwd)}.json`);
  if (existsSync(p)) {
    try {
      return (JSON.parse(readFileSync(p, 'utf8')) as { nodeId: string }).nodeId;
    } catch {
      return null;
    }
  }
  return null;
}

export function loadRunFile(nodeId: string): RunFile {
  const p = join(switchyardHome(), 'run', `${nodeId}.json`);
  if (!existsSync(p))
    throw new Error(`no Switchyard run file for node ${nodeId} (is the Switchyard core running?)`);
  return JSON.parse(readFileSync(p, 'utf8')) as RunFile;
}

export class BusHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Thin HTTP client for core's /bus routes. Re-reads the run file on 401 in case core restarted and reissued it. */
export class BusClient {
  private rf: RunFile;
  constructor(public nodeId: string) {
    this.rf = loadRunFile(nodeId);
  }

  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, retried = false): Promise<T> {
    const res = await fetch(`${this.rf.coreUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-switchyard-node': this.nodeId,
        'x-switchyard-cap': this.rf.capability,
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    if (res.status === 401 && !retried) {
      this.rf = loadRunFile(this.nodeId);
      return this.call(method, path, body, true);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok)
      throw new BusHttpError(
        res.status,
        String(data.error ?? 'error'),
        String(data.message ?? res.statusText),
      );
    return data as T;
  }

  /** Long waits are split into ≤55s polls so no single HTTP request hits fetch's header timeout. */
  async longPoll<T extends { status?: string; pending?: boolean; questionId?: string }>(
    path: string,
    body: Record<string, unknown>,
    totalSec: number,
    timeoutKey = 'timeoutSec',
    stillWaiting: (r: T) => boolean = (r) => r.status === 'timeout',
  ): Promise<T> {
    const deadline = Date.now() + Math.max(0, totalSec) * 1000;
    let b = { ...body };
    for (;;) {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const r = await this.call<T>('POST', path, { ...b, [timeoutKey]: Math.min(55, left) });
      if (!stillWaiting(r) || left <= 55) return r;
      if (r.questionId) b = { questionId: r.questionId };
    }
  }
}
