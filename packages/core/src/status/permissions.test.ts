import { describe, it, expect, vi, afterEach } from 'vitest';
import { PermissionBroker, describeToolInput, permissionTimeoutMs } from './permissions.js';

const info = {
  nodeId: 'n1',
  workspaceId: 'w1',
  source: 'claude' as const,
  toolName: 'Bash',
  detail: 'ls',
  options: ['allow' as const, 'deny' as const],
};

afterEach(() => {
  vi.useRealTimers();
  delete process.env.SWITCHYARD_PERMISSION_TIMEOUT_MS;
});

describe('describeToolInput', () => {
  it('shows the command for Bash, with its description', () => {
    expect(describeToolInput('Bash', { command: 'rm -rf build', description: 'clean' })).toBe(
      'rm -rf build\n# clean',
    );
    expect(describeToolInput('Bash', { command: 'echo hi' })).toBe('echo hi');
  });
  it('shows the path for file tools and the url for web tools', () => {
    expect(describeToolInput('Write', { file_path: '/a/b.py', content: 'print(1)' })).toBe(
      '/a/b.py\nprint(1)',
    );
    expect(describeToolInput('WebFetch', { url: 'https://e.x' })).toBe('https://e.x');
  });
  it('falls back to compact JSON, clipped, and tolerates garbage', () => {
    expect(describeToolInput('mcp__x', { a: 1 })).toContain('"a": 1');
    expect(describeToolInput('X', { big: 'y'.repeat(5000) }).length).toBeLessThan(1300);
    expect(describeToolInput('X', null)).toBe('');
    expect(describeToolInput('X', 42)).toBe('');
  });
});

describe('PermissionBroker', () => {
  it('resolves with the human decision and clears the item', async () => {
    const b = new PermissionBroker();
    const r = b.request(info, 10_000);
    expect(b.open().map((i) => i.id)).toEqual([r.id]);
    expect(b.hasOpen('n1')).toBe(true);
    expect(b.decide(r.id, 'allow')).toBe(true);
    await expect(r.outcome).resolves.toBe('allow');
    expect(b.open()).toEqual([]);
    expect(b.decide(r.id, 'deny')).toBe(false); // already gone
  });

  it('only accepts offered decisions (Claude has no "ask")', () => {
    const b = new PermissionBroker();
    const r = b.request(info, 10_000);
    expect(b.decide(r.id, 'ask')).toBe(false);
    expect(b.open()).toHaveLength(1);
    b.cancel(r.id);
  });

  it('times out to "timeout" and never auto-allows', async () => {
    vi.useFakeTimers();
    const b = new PermissionBroker();
    const r = b.request(info, 590_000);
    vi.advanceTimersByTime(589_999);
    expect(b.open()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    await expect(r.outcome).resolves.toBe('timeout');
    expect(b.open()).toEqual([]);
  });

  it('cancels when the agent goes away', async () => {
    const b = new PermissionBroker();
    const r = b.request(info, 10_000);
    b.cancelNode('n1');
    await expect(r.outcome).resolves.toBe('cancelled');
  });

  it('timeouts: 590 s Claude, 290 s agy, overridable for tests', () => {
    expect(permissionTimeoutMs('claude')).toBe(590_000);
    expect(permissionTimeoutMs('agy')).toBe(290_000);
    process.env.SWITCHYARD_PERMISSION_TIMEOUT_MS = '150';
    expect(permissionTimeoutMs('claude')).toBe(150);
  });
});
