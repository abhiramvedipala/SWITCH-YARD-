import { createHash } from 'node:crypto';
import {
  writeFileSync,
  chmodSync,
  rmSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { RUN_DIR, ensureDirs } from '../paths.js';
import { randomId, constantTimeEqual } from './token.js';

export interface RunFile {
  nodeId: string;
  workspaceId: string;
  coreUrl: string;
  capability: string;
}

const BY_CWD_DIR = join(RUN_DIR, 'by-cwd');

export function cwdKey(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 32);
}

function writeSecret(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Per-node capability, stored as a 0600 file the node's bus-mcp process reads. */
export class Capabilities {
  private caps = new Map<string, string>();

  constructor(private coreUrl: string) {}

  issue(nodeId: string, workspaceId: string, cwd?: string | null): RunFile {
    ensureDirs();
    const capability = randomId(24);
    const rf: RunFile = { nodeId, workspaceId, coreUrl: this.coreUrl, capability };
    writeSecret(join(RUN_DIR, `${nodeId}.json`), JSON.stringify(rf));
    this.caps.set(nodeId, capability);
    if (cwd) {
      if (!existsSync(BY_CWD_DIR)) mkdirSync(BY_CWD_DIR, { recursive: true, mode: 0o700 });
      writeSecret(
        join(BY_CWD_DIR, `${cwdKey(cwd)}.json`),
        JSON.stringify({ nodeId, cwd: resolve(cwd) }),
      );
    }
    return rf;
  }

  /** Re-load capabilities written before a core restart so already-running bus-mcp processes keep working. */
  restore(nodeIds: string[]): void {
    for (const id of nodeIds) {
      const p = join(RUN_DIR, `${id}.json`);
      if (!existsSync(p)) continue;
      try {
        const rf = JSON.parse(readFileSync(p, 'utf8')) as RunFile;
        if (rf.capability) this.caps.set(id, rf.capability);
      } catch {
        // ignore corrupt file; it gets reissued on next start
      }
    }
  }

  verify(nodeId: string | undefined, capability: string | undefined): boolean {
    if (!nodeId || !capability) return false;
    const cap = this.caps.get(nodeId);
    return !!cap && constantTimeEqual(cap, capability);
  }

  revoke(nodeId: string): void {
    this.caps.delete(nodeId);
    rmSync(join(RUN_DIR, `${nodeId}.json`), { force: true });
    if (existsSync(BY_CWD_DIR)) {
      for (const f of readdirSync(BY_CWD_DIR)) {
        const p = join(BY_CWD_DIR, f);
        try {
          const m = JSON.parse(readFileSync(p, 'utf8')) as { nodeId: string };
          if (m.nodeId === nodeId) rmSync(p, { force: true });
        } catch {
          // ignore
        }
      }
    }
  }
}
