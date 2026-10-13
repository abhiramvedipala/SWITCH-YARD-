import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let core: import('../core.js').Core;
let wsId: string;
let repoRoot: string;

beforeAll(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-guard-home-'));
  delete process.env.SWITCHYARD_SCRATCH_ROOT;
  const { createCore } = await import('../core.js');
  const paths = await import('../paths.js');
  repoRoot = paths.REPO_ROOT;
  core = createCore({ dbPath: ':memory:', coreUrl: 'http://127.0.0.1:1' });
  wsId = core.store.createWorkspace('guard', repoRoot).id;
});

describe('agent nodes and the app-folder guard', () => {
  it('refuses a claude node in the Switchyard repo', () => {
    expect(() => core.nodes.create(wsId, { type: 'agent-chat', harness: 'claude' })).toThrow(
      /own folder/,
    );
  });
  it('allows it only with the explicit override', () => {
    const n = core.nodes.create(wsId, {
      type: 'agent-chat',
      harness: 'claude',
      allowOwnFolder: true,
    });
    expect(n.cwd).toBe(repoRoot);
  });
  it('does not guard mock agents or notes', () => {
    expect(core.nodes.create(wsId, { type: 'agent-chat', harness: 'mock' }).harness).toBe('mock');
    expect(core.nodes.create(wsId, { type: 'note' }).type).toBe('note');
  });
});
