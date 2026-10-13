import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRUST_PROMPT, TRUST_PROMPT_TEXT } from './monitor.js';
import { ptys } from '../pty/manager.js';

// A realistic copy of Claude Code's folder-trust dialog (only a real `claude` can confirm the exact text).
export const TRUST_DIALOG = [
  '╭──────────────────────────────────────────────────╮',
  '│ Do you trust the files in this folder?           │',
  '│                                                  │',
  '│ /tmp/demo                                        │',
  '│                                                  │',
  '│ Claude Code may read files in this folder.       │',
  '│ Reading untrusted files may lead Claude Code to  │',
  '│ behave in unexpected ways.                       │',
  '│                                                  │',
  '│ With your permission Claude Code may execute     │',
  '│ files in this folder. Executing untrusted code   │',
  '│ is unsafe.                                       │',
  '│                                                  │',
  '│ https://docs.claude.com/s/claude-code-security   │',
  '│                                                  │',
  '│ ❯ 1. Yes, proceed                                │',
  '│   2. No, exit                                    │',
  '│                                                  │',
  '│ Enter to confirm · Esc to exit                   │',
  '╰──────────────────────────────────────────────────╯',
];

describe('TRUST_PROMPT pattern', () => {
  it('matches the trust dialog', () => {
    expect(TRUST_PROMPT.test(TRUST_DIALOG.join('\n'))).toBe(true);
  });
  it.each([
    ['a permission prompt', 'Do you want to proceed?\n❯ 1. Yes\n  2. No'],
    ['the option without the question', '❯ 1. Yes, proceed\n  2. No, exit'],
    ['the question without the option', 'Do you trust the files in this folder?\n(y/n)'],
    [
      'prose mentioning both',
      'I asked: do you trust the files in this folder? Yes, proceed anyway.',
    ],
  ])('does not match %s', (_what, text) => {
    expect(TRUST_PROMPT.test(text)).toBe(false);
  });
});

describe('trust prompt in a terminal → needs_input with Accept (Enter) in the sidebar', () => {
  type Built = Awaited<ReturnType<typeof import('../server.js').buildServer>>;
  let built: Built;
  let nodeId: string;
  beforeAll(async () => {
    process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-trust-home-'));
    const { buildServer } = await import('../server.js');
    built = await buildServer({ port: 4794, dbPath: ':memory:', quiet: true });
    const ws = built.core.store.createWorkspace('t', tmpdir());
    nodeId = built.core.store.insertNode({
      workspaceId: ws.id,
      type: 'terminal',
      harness: 'shell',
      title: 'Shell',
      cwd: tmpdir(),
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      state: 'idle',
      sessionRef: null,
      yolo: false,
      data: {},
      summary: '',
    }).id;
    // Prints the dialog, waits for Enter like the real dialog, then keeps running.
    ptys.spawn(nodeId, {
      cmd: 'bash',
      args: [
        '-c',
        `printf '%s\\n' ${TRUST_DIALOG.map((l) => `'${l}'`).join(' ')}; read -r; echo accepted; sleep 30`,
      ],
      cwd: tmpdir(),
      env: {},
    });
  });
  afterAll(async () => {
    ptys.kill(nodeId);
    await built.app.close();
  });
  const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
    built.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${built.token}`, host: '127.0.0.1:4794' },
      payload,
    });
  const until = async (fn: () => boolean | Promise<boolean>, ms = 4000) => {
    const end = Date.now() + ms;
    while (!(await fn())) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const state = () => built.core.store.getNode(nodeId)!.state;
  const item = async () =>
    ((await api('GET', '/api/attention')).json().items as Array<Record<string, unknown>>).find(
      (i) => i.nodeId === nodeId,
    );

  it('shows the item, refuses free text, and Accept sends Enter which clears it', async () => {
    await until(() => {
      built.core.monitor.tick();
      return state() === 'needs_input';
    });
    expect(await item()).toMatchObject({
      kind: 'needs_input',
      text: TRUST_PROMPT_TEXT,
      prompt: 'trust',
    });
    // Free text could answer the dialog by accident: only the explicit key buttons are accepted.
    expect((await api('POST', `/api/nodes/${nodeId}/reply`, { text: 'yes' })).statusCode).toBe(409);
    expect(state()).toBe('needs_input');
    // The Accept button = the Enter key, which selects the highlighted "Yes, proceed".
    expect(
      (await api('POST', `/api/nodes/${nodeId}/reply`, { text: 'enter', raw: true })).statusCode,
    ).toBe(200);
    await until(() => ptys.scrollback(nodeId).includes('accepted'));
    await until(() => {
      built.core.monitor.tick();
      return state() !== 'needs_input';
    });
    expect(await item()).toBeUndefined();
    // The dialog text is still in the scrollback; later output must not raise it again.
    built.core.monitor.tick();
    expect(state()).not.toBe('needs_input');
  });
});
