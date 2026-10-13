import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { MacNotifier, appleScriptText } from './notify.js';
import { StatusMonitor, type AttentionItem } from './monitor.js';
import { PermissionBroker } from './permissions.js';
import { hub } from '../events.js';
import { openDb } from '../db/index.js';
import { Store } from '../store.js';
import { Bus } from '../bus/service.js';
import { HookRouter } from '../bus/hooks.js';

// The notifier never runs osascript here: exec is a fake, so no test can post a real notification.
const item = (id: string, over: Partial<AttentionItem> = {}): AttentionItem => ({
  kind: 'question',
  id,
  nodeId: `node-${id}`,
  nodeTitle: `Agent ${id}`,
  workspaceId: 'w',
  text: `Question ${id}?`,
  createdAt: 0,
  ...over,
});

function setup(opts: { enabled?: boolean; platform?: NodeJS.Platform } = {}) {
  let feed: AttentionItem[] = [];
  let enabled = opts.enabled ?? true;
  const exec = vi.fn<(file: string, args: string[]) => void>();
  const n = new MacNotifier({
    attention: () => feed,
    enabled: () => enabled,
    exec,
    platform: opts.platform ?? 'darwin',
  });
  return {
    n,
    exec,
    feed: (...items: AttentionItem[]) => (feed = items),
    enable: (v: boolean) => (enabled = v),
    scripts: () => exec.mock.calls.map(([, args]) => args[1]),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('macOS notifications for new needs-you items', () => {
  it('a new item → one osascript call (argument array, no shell) with escaped text', () => {
    const t = setup();
    t.feed(item('a', { text: 'Use "blue" or C:\\red?', nodeTitle: 'Builder "1"' }));
    t.n.check();
    expect(t.exec).toHaveBeenCalledTimes(1);
    expect(t.exec).toHaveBeenCalledWith('osascript', [
      '-e',
      'display notification "Use \\"blue\\" or C:\\\\red?" with title "Switchyard" subtitle "Builder \\"1\\""',
    ]);
  });

  it('the same item twice → one call; announced again only after it left and came back', () => {
    const t = setup();
    t.feed(item('a'));
    t.n.check();
    vi.advanceTimersByTime(5000);
    t.n.check();
    expect(t.exec).toHaveBeenCalledTimes(1);
    t.feed(); // answered: the id is forgotten
    t.n.check();
    t.feed(item('a'));
    t.n.check();
    expect(t.exec).toHaveBeenCalledTimes(2);
  });

  it('a burst is coalesced: "3 agents need you", then at most one banner per 2 s', () => {
    const t = setup();
    t.feed(item('a'), item('b'), item('c'));
    t.n.check();
    expect(t.scripts()).toEqual([
      'display notification "3 agents need you" with title "Switchyard" subtitle "Agent a, Agent b, Agent c"',
    ]);
    t.feed(item('a'), item('b'), item('c'), item('d'));
    t.n.check();
    const e2 = item('e2', { nodeId: 'node-e', nodeTitle: 'Agent e' }); // a second item from agent e
    t.feed(item('a'), item('b'), item('c'), item('d'), item('e'), e2);
    t.n.check();
    vi.advanceTimersByTime(1900);
    expect(t.exec).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100); // the deferred re-check re-reads the feed and sends one banner
    expect(t.scripts()[1]).toBe(
      'display notification "2 agents need you" with title "Switchyard" subtitle "Agent d, Agent e"',
    );
    vi.advanceTimersByTime(10_000);
    expect(t.exec).toHaveBeenCalledTimes(2);
  });

  it('an item that leaves while held back is not announced', () => {
    const t = setup();
    t.feed(item('a'));
    t.n.check();
    t.feed(item('a'), item('b'));
    t.n.check();
    t.feed(item('a'));
    vi.advanceTimersByTime(2000);
    expect(t.exec).toHaveBeenCalledTimes(1);
  });

  it('setting off → none; switching it on later does not replay what was already open', () => {
    const t = setup({ enabled: false });
    t.feed(item('a'));
    t.n.check();
    expect(t.exec).not.toHaveBeenCalled();
    t.enable(true);
    t.n.check();
    expect(t.exec).not.toHaveBeenCalled();
    t.feed(item('a'), item('b'));
    t.n.check();
    expect(t.scripts()).toEqual([
      'display notification "Question b?" with title "Switchyard" subtitle "Agent b"',
    ]);
  });

  it('non-darwin → none, and start() does not listen to the hub', () => {
    const t = setup({ platform: 'linux' });
    t.n.start();
    t.feed(item('a'));
    t.n.check();
    hub.emitHub({ t: 'status', nodeId: 'node-a', state: 'needs_input' });
    vi.advanceTimersByTime(1000);
    expect(t.exec).not.toHaveBeenCalled();
    t.n.stop();
  });

  it('only question / permission / needs_input count; a permission names its tool', () => {
    const t = setup();
    t.feed(item('u', { kind: 'unread', text: '2 unread messages while idle' }));
    t.n.check();
    expect(t.exec).not.toHaveBeenCalled();
    t.feed(item('p', { kind: 'permission', toolName: 'Bash', text: 'npm test' }));
    t.n.check();
    expect(t.scripts()).toEqual([
      'display notification "Bash: npm test" with title "Switchyard" subtitle "Agent p"',
    ]);
  });

  it('a needs_input banner keeps the end of the screen tail, where the prompt is', () => {
    const t = setup();
    const tail = `${'building module 7 of 9 ok\n'.repeat(9)}Allow this command? (y/n)`;
    t.feed(item('n', { kind: 'needs_input', text: tail }));
    t.n.check();
    const body = /^display notification "(.*)" with title "Switchyard" subtitle "Agent n"$/.exec(
      t.scripts()[0]!,
    )![1]!;
    expect(body.startsWith('…')).toBe(true);
    expect(body.endsWith('ok Allow this command? (y/n)')).toBe(true);
    expect([...body]).toHaveLength(120);
    expect(appleScriptText(`${'x'.repeat(200)}END`, 120, true)).toBe(`…${'x'.repeat(116)}END`);
  });

  it('hub-driven: a status or questions change re-reads the feed after a short settle; pty output does not', () => {
    const t = setup();
    t.feed(item('old'));
    t.n.start(); // open at boot: not announced
    t.feed(item('old'), item('new', { kind: 'needs_input', text: 'Allow this command? (y/n)' }));
    hub.emitHub({ t: 'pty.data', id: 'node-new', data: 'x' });
    vi.advanceTimersByTime(1000);
    expect(t.exec).not.toHaveBeenCalled();
    hub.emitHub({ t: 'status', nodeId: 'node-new', state: 'needs_input' });
    hub.emitHub({ t: 'change', entity: 'questions', workspaceId: 'w' });
    expect(t.exec).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(t.scripts()).toEqual([
      'display notification "Allow this command? (y/n)" with title "Switchyard" subtitle "Agent new"',
    ]);
    t.n.stop();
    t.feed(item('old'), item('new'), item('later'));
    hub.emitHub({ t: 'status', nodeId: 'node-later', state: 'needs_input' });
    vi.advanceTimersByTime(5000);
    expect(t.exec).toHaveBeenCalledTimes(1);
  });

  it('escaping: quotes and backslashes escaped, newlines/control chars and box glyphs dropped, ~120 chars', () => {
    expect(appleScriptText('say "hi"\\now')).toBe('say \\"hi\\"\\\\now');
    expect(appleScriptText('line one\nline two\r\n\tthree\u0007\u001b[31m')).toBe(
      'line one line two three [31m',
    );
    expect(appleScriptText('╭──────╮\n│ Do you want to proceed? │\n╰──────╯')).toBe(
      'Do you want to proceed?',
    );
    const long = appleScriptText('x'.repeat(300));
    expect([...long]).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
    // Clipping happens before escaping, so a cut can never leave a dangling backslash before the closing quote.
    expect(appleScriptText(`${'a'.repeat(118)}"bbb`)).toBe(`${'a'.repeat(118)}\\"…`);
    expect(appleScriptText(`${'a'.repeat(118)}\\bbb`)).toBe(`${'a'.repeat(118)}\\\\…`);
    expect(appleScriptText('🙂'.repeat(200))).toBe(`${'🙂'.repeat(119)}…`);
  });
});

describe('wired to the real feed', () => {
  it('a question and a held Claude permission give one banner each; deciding it adds none', async () => {
    const store = new Store(openDb(':memory:'));
    const bus = new Bus(store);
    const monitor = new StatusMonitor(store, bus);
    const permissions = new PermissionBroker();
    monitor.permissions = permissions;
    const hooks = new HookRouter(store, bus, monitor, permissions);
    const ws = store.createWorkspace('w', tmpdir());
    const node = store.insertNode({
      workspaceId: ws.id,
      type: 'agent-terminal',
      harness: 'claude',
      title: 'Claude',
      cwd: tmpdir(),
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      state: 'working',
      sessionRef: null,
      yolo: false,
      data: {},
      summary: '',
    });
    const exec = vi.fn<(file: string, args: string[]) => void>();
    const n = new MacNotifier({
      attention: () => monitor.attention(),
      enabled: () => true,
      exec,
      platform: 'darwin',
    });
    const scripts = () => exec.mock.calls.map(([, args]) => args[1]);
    n.start();

    bus.createQuestion(node.id, 'Which "color"?');
    await vi.advanceTimersByTimeAsync(250);
    expect(scripts()).toEqual([
      'display notification "Which \\"color\\"?" with title "Switchyard" subtitle "Claude"',
    ]);

    const reply = hooks.claude(node.id, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    await vi.advanceTimersByTimeAsync(2000); // held back by the 2 s gap, then sent
    expect(scripts()[1]).toBe(
      'display notification "Bash: npm test" with title "Switchyard" subtitle "Claude"',
    );

    // Allow (past the gap, so nothing is held back): the card goes and the node resumes. The moment in
    // between (still needs_input, no open permission) must not surface as a "needs input" banner.
    await vi.advanceTimersByTimeAsync(2500);
    expect(permissions.decide(permissions.open()[0]!.id, 'allow')).toBe(true);
    await reply;
    await vi.advanceTimersByTimeAsync(3000);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(store.getNode(node.id)!.state).toBe('working');
    n.stop();
  });
});
