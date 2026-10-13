import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let Capabilities: typeof import('./capability.js').Capabilities;
let runDir: string;

beforeAll(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-cap-home-'));
  ({ Capabilities } = await import('./capability.js'));
  runDir = (await import('../paths.js')).RUN_DIR;
});

describe('per-node hook secret', () => {
  it('is issued with the capability and verifies in constant time', () => {
    const caps = new Capabilities('http://127.0.0.1:4777');
    const rf = caps.issue('n1', 'w1');
    expect(rf.hookSecret).toBeTruthy();
    expect(caps.verifyHook('n1', rf.hookSecret)).toBe(true);
    expect(caps.verifyHook('n1', 'wrong')).toBe(false);
    expect(caps.verifyHook('n1', undefined)).toBe(false);
    expect(caps.verifyHook('nope', rf.hookSecret)).toBe(false);
    expect(caps.hookUrl('n1')).toBe(`http://127.0.0.1:4777/bus/hook/claude/n1/${rf.hookSecret}`);
  });

  it('is rotated on every issue(); the previous secret stops working', () => {
    const caps = new Capabilities('http://127.0.0.1:4777');
    const a = caps.issue('n2', 'w1');
    const b = caps.issue('n2', 'w1');
    expect(b.hookSecret).not.toBe(a.hookSecret);
    expect(b.capability).not.toBe(a.capability);
    expect(caps.verifyHook('n2', a.hookSecret)).toBe(false);
    expect(caps.verify('n2', a.capability)).toBe(false);
    expect(caps.verifyHook('n2', b.hookSecret)).toBe(true);
  });

  it('is revoked on exit and removes the run file', () => {
    const caps = new Capabilities('http://127.0.0.1:4777');
    const rf = caps.issue('n3', 'w1');
    expect(existsSync(join(runDir, 'n3.json'))).toBe(true);
    caps.revoke('n3');
    expect(caps.verifyHook('n3', rf.hookSecret)).toBe(false);
    expect(caps.hookUrl('n3')).toBeUndefined();
    expect(existsSync(join(runDir, 'n3.json'))).toBe(false);
  });

  it('survives a core restart via the 0600 run file', () => {
    const a = new Capabilities('http://127.0.0.1:4777');
    const rf = a.issue('n4', 'w1');
    const b = new Capabilities('http://127.0.0.1:4777');
    b.restore(['n4']);
    expect(b.verifyHook('n4', rf.hookSecret)).toBe(true);
    expect(b.verify('n4', rf.capability)).toBe(true);
  });
});
