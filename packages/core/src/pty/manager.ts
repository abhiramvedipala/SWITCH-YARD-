import * as pty from 'node-pty';
import { hub } from '../events.js';

const MAX_LINES = 10_000;
// Per terminal. 10k lines is the real limit; this only bounds pathological output (huge ANSI-heavy lines).
const MAX_BYTES = 2 * 1024 * 1024;

export interface SpawnSpec {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface PtySession {
  id: string;
  proc: pty.IPty;
  chunks: string[];
  lines: number;
  bytes: number;
  /** Chars ever written by this process (never trimmed): lets the status monitor look at "output since X" only. */
  totalBytes: number;
  cols: number;
  rows: number;
  lastOutputAt: number;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  spec: SpawnSpec;
}

type DataListener = (id: string, data: string) => void;
type ExitListener = (id: string, code: number | null) => void;

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private dataListeners: DataListener[] = [];
  private exitListeners: ExitListener[] = [];

  onData(fn: DataListener): void {
    this.dataListeners.push(fn);
  }
  onExit(fn: ExitListener): void {
    this.exitListeners.push(fn);
  }

  spawn(id: string, spec: SpawnSpec): PtySession {
    this.kill(id);
    const cols = spec.cols ?? 100;
    const rows = spec.rows ?? 30;
    const env = { ...process.env, ...spec.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    const proc = pty.spawn(spec.cmd, spec.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: spec.cwd,
      env: env as Record<string, string>,
    });
    const session: PtySession = {
      id,
      proc,
      chunks: [],
      lines: 0,
      bytes: 0,
      totalBytes: 0,
      cols,
      rows,
      lastOutputAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
      exitCode: null,
      spec,
    };
    this.sessions.set(id, session);
    proc.onData((data) => {
      if (this.sessions.get(id) !== session) return;
      this.append(session, data);
      session.lastOutputAt = Date.now();
      hub.emitHub({ t: 'pty.data', id, data });
      for (const fn of this.dataListeners) fn(id, data);
    });
    proc.onExit(({ exitCode }) => {
      if (this.sessions.get(id) !== session) return;
      session.exited = true;
      session.exitCode = exitCode;
      const note = `\r\n[process exited with code ${exitCode}]\r\n`;
      this.append(session, note);
      hub.emitHub({ t: 'pty.data', id, data: note });
      hub.emitHub({ t: 'pty.exit', id, code: exitCode });
      for (const fn of this.exitListeners) fn(id, exitCode);
    });
    return session;
  }

  private append(s: PtySession, data: string): void {
    s.chunks.push(data);
    s.lines += countNewlines(data);
    s.bytes += data.length;
    s.totalBytes += data.length;
    while ((s.lines > MAX_LINES || s.bytes > MAX_BYTES) && s.chunks.length > 1) {
      const dropped = s.chunks.shift()!;
      s.lines -= countNewlines(dropped);
      s.bytes -= dropped.length;
    }
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  isAlive(id: string): boolean {
    const s = this.sessions.get(id);
    return !!s && !s.exited;
  }

  scrollback(id: string): string {
    return this.sessions.get(id)?.chunks.join('') ?? '';
  }

  write(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.exited) return false;
    s.proc.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s || s.exited) return;
    const c = Math.max(2, Math.min(500, Math.floor(cols)));
    const r = Math.max(2, Math.min(300, Math.floor(rows)));
    if (c === s.cols && r === s.rows) return;
    s.cols = c;
    s.rows = r;
    try {
      s.proc.resize(c, r);
    } catch {
      // process may have just exited
    }
  }

  kill(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    if (!s.exited) {
      try {
        s.proc.kill();
      } catch {
        // already gone
      }
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }
}

export const ptys = new PtyManager();
