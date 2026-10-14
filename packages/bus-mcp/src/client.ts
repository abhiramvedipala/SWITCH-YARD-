import { readFileSync, existsSync, lstatSync } from 'node:fs';
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

/** Why SWITCHYARD_CAPFILE may not be trusted, or null if it is a private regular file of ours. */
export function capFileProblem(path: string): string | null {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return 'file does not exist';
  }
  if (!st.isFile()) return 'not a regular file';
  const mode = st.mode & 0o777;
  if (mode !== 0o600) return `mode ${mode.toString(8)} is not 0600`;
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return 'owned by another user';
  return null;
}

/**
 * The run file named by SWITCHYARD_CAPFILE, or null when it is unset, a literal "$…" (host did not expand it),
 * or not a 0600 regular file owned by us (then we say why on stderr and the caller tries the next method).
 * The capability is only ever read from this file, never from env content.
 */
export function capFile(): RunFile | null {
  const p = process.env.SWITCHYARD_CAPFILE;
  if (!p || p.startsWith('$')) return null;
  const why = capFileProblem(p);
  if (why) {
    process.stderr.write(`switchyard: ignoring SWITCHYARD_CAPFILE (${why}): ${p}\n`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as RunFile;
  } catch {
    process.stderr.write(`switchyard: ignoring SWITCHYARD_CAPFILE (not JSON): ${p}\n`);
    return null;
  }
}

/**
 * Who am I? The SWITCHYARD_CAPFILE run file first, then SWITCHYARD_NODE from the environment (Claude passes both
 * via --mcp-config env; agy nodes get them on their PTY). A literal "$SWITCHYARD_NODE" means the host didn't
 * expand it, so fall back to the identity file core writes per agent cwd.
 */
export function resolveNodeId(cwd = process.cwd()): string | null {
  const cf = capFile();
  if (cf) return cf.nodeId;
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
  const cf = capFile();
  if (cf) {
    // A process handed node B's file is B; it cannot borrow A's identity by naming it.
    if (cf.nodeId !== nodeId)
      throw new Error(`SWITCHYARD_CAPFILE belongs to node ${cf.nodeId}, not ${nodeId}`);
    return cf;
  }
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

type Waiting = { status?: string; pending?: boolean; questionId?: string };

/** What a tool handler gets: the process identity, or that identity acting as one Claude Desktop chat. */
export interface BusCaller {
  call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T>;
  longPoll<T extends Waiting>(
    path: string,
    body: Record<string, unknown>,
    totalSec: number,
    timeoutKey?: string,
    stillWaiting?: (r: T) => boolean,
  ): Promise<T>;
}

/** Thin HTTP client for core's /bus routes. Re-reads the run file on 401 in case core restarted and reissued it. */
export class BusClient implements BusCaller {
  private rf: RunFile;
  constructor(public nodeId: string) {
    this.rf = loadRunFile(nodeId);
  }

  /** Claude Desktop only: every call carries the chat's name, and core answers as that chat's node. */
  as(name: string | undefined): BusCaller {
    if (!name) return this;
    return {
      call: (m, p, b) => this.call(m, p, b, name),
      longPoll: (p, b, t, k, s) => this.longPoll(p, b, t, k, s, name),
    };
  }

  async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    as?: string,
    retried = false,
  ): Promise<T> {
    const res = await fetch(`${this.rf.coreUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-switchyard-node': this.nodeId,
        'x-switchyard-cap': this.rf.capability,
        ...(as ? { 'x-switchyard-as': as } : {}),
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    if (res.status === 401 && !retried) {
      this.rf = loadRunFile(this.nodeId);
      return this.call(method, path, body, as, true);
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
  async longPoll<T extends Waiting>(
    path: string,
    body: Record<string, unknown>,
    totalSec: number,
    timeoutKey = 'timeoutSec',
    stillWaiting: (r: T) => boolean = (r) => r.status === 'timeout',
    as?: string,
  ): Promise<T> {
    const deadline = Date.now() + Math.max(0, totalSec) * 1000;
    let b = { ...body };
    for (;;) {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const r = await this.call<T>('POST', path, { ...b, [timeoutKey]: Math.min(55, left) }, as);
      if (!stillWaiting(r) || left <= 55) return r;
      if (r.questionId) b = { questionId: r.questionId };
    }
  }
}
