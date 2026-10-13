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
  /** Per-node secret embedded in the Claude HTTP hook URL; rotated together with the capability. */
  hookSecret?: string;
}

const DUMMY_SECRET = randomId(24);
const BY_CWD_DIR = join(RUN_DIR, 'by-cwd');

/** The node's 0600 run file; its absolute path goes to child processes as SWITCHYARD_CAPFILE. */
export function runFilePath(nodeId: string): string {
  return join(RUN_DIR, `${nodeId}.json`);
}

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
  private hookSecrets = new Map<string, string>();

  constructor(private coreUrl: string) {}

  issue(nodeId: string, workspaceId: string, cwd?: string | null): RunFile {
    ensureDirs();
    // Fresh credentials on every (re)spawn: whatever the previous process held stops working.
    const capability = randomId(24);
    const hookSecret = randomId(24);
    const rf: RunFile = { nodeId, workspaceId, coreUrl: this.coreUrl, capability, hookSecret };
    writeSecret(runFilePath(nodeId), JSON.stringify(rf));
    this.caps.set(nodeId, capability);
    this.hookSecrets.set(nodeId, hookSecret);
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
      const p = runFilePath(id);
      if (!existsSync(p)) continue;
      try {
        const rf = JSON.parse(readFileSync(p, 'utf8')) as RunFile;
        if (rf.capability) this.caps.set(id, rf.capability);
        if (rf.hookSecret) this.hookSecrets.set(id, rf.hookSecret);
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

  /** URL for the Claude HTTP hooks of this node (contains the secret, so it only goes into --settings). */
  hookUrl(nodeId: string): string | undefined {
    const secret = this.hookSecrets.get(nodeId);
    return secret ? `${this.coreUrl}/bus/hook/claude/${nodeId}/${secret}` : undefined;
  }

  /** Constant-time check; unknown node and wrong secret are indistinguishable to the caller. */
  verifyHook(nodeId: string | undefined, secret: string | undefined): boolean {
    const real = nodeId ? this.hookSecrets.get(nodeId) : undefined;
    // Always run one comparison so timing doesn't reveal whether the node exists.
    const ok = constantTimeEqual(real ?? DUMMY_SECRET, secret ?? '');
    return !!real && !!secret && ok;
  }

  revoke(nodeId: string): void {
    this.caps.delete(nodeId);
    this.hookSecrets.delete(nodeId);
    rmSync(runFilePath(nodeId), { force: true });
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
