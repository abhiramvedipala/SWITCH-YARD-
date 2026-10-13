import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

beforeAll(() => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-vitest-home-'));
  process.env.SWITCHYARD_SCRATCH_ROOT = join(process.cwd(), '../../scratch');
});

describe('e2e (mock harness, real bus-mcp over MCP stdio)', () => {
  it('Phase 3 DoD: request/response between connected mocks; unconnected node isolated', async () => {
    const { runBusScenario } = await import('./scenario.js');
    const r = await runBusScenario();
    expect(r.tools).toHaveLength(13);
    expect(r.reply).toMatchObject({ status: 'replied', body: 'pong' });
    expect(r.cPeers).toEqual([]);
    expect(r.cInbox).toEqual([]);
    expect(r.unconnectedError).toMatch(/not_connected/);
  }, 60_000);

  it('Phase 6 DoD: a mock run plans, builds, gets one review round of changes, and finishes approved', async () => {
    const { runRunsScenario } = await import('./runs-scenario.js');
    const r = await runRunsScenario();
    expect(r.status).toBe('done');
    expect(r.approved).toBe(true);
    expect(r.reviewRounds).toBeGreaterThanOrEqual(2);
    expect(r.helloHasDocstring).toBe(true);
    expect(r.gitStatus).toContain('hello.py');
    expect(r.files).toEqual(expect.arrayContaining(['hello.py', 'test_hello.py']));
  }, 60_000);

  it('F3: denied tool calls are recorded on the step and shown on the result card', async () => {
    const { runRunsScenario } = await import('./runs-scenario.js');
    const r = await runRunsScenario(undefined, ' [deny:Bash: python3 -m pytest -q]');
    expect(r.status).toBe('done');
    expect(r.denials).toEqual(['Bash: python3 -m pytest -q']);
  }, 60_000);
});
