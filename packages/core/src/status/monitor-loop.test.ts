import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { openDb } from '../db/index.js';
import { Store } from '../store.js';
import { Bus } from './../bus/service.js';
import { StatusMonitor } from './monitor.js';
import { ptys } from '../pty/manager.js';

const store = new Store(openDb(':memory:'));
const monitor = new StatusMonitor(store, new Bus(store));
const ws = store.createWorkspace('w', tmpdir());
const node = store.insertNode({
  workspaceId: ws.id,
  type: 'agent-terminal',
  harness: 'agy',
  title: 'agy',
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
});
afterAll(() => {
  monitor.stopLoop();
  ptys.killAll();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const state = () => store.getNode(node.id)!.state;

describe('status loop (screen scan, scanned only when output changes)', () => {
  it('flags an on-screen prompt as needs_input, then clears it after the human answers', async () => {
    ptys.spawn(node.id, {
      cmd: 'bash',
      args: ['-c', 'printf "Allow this command? (y/n)\\n"; sleep 30'],
      cwd: tmpdir(),
      env: {},
    });
    await sleep(500);
    monitor.tick();
    expect(state()).toBe('needs_input');
    expect(monitor.attention(ws.id).some((i) => i.kind === 'needs_input')).toBe(true);

    // The human answers; the same text is still on screen but must not re-raise the alarm.
    monitor.noteUserInput(node.id);
    monitor.tick();
    expect(state()).not.toBe('needs_input');
    monitor.tick();
    expect(state()).not.toBe('needs_input');
  });

  it('the attention feed does not need full node rows (brief query keeps the same fields)', () => {
    const items = monitor.attention(ws.id);
    for (const i of items) expect(i).toMatchObject({ nodeTitle: 'agy', workspaceId: ws.id });
    expect(store.listNodeBriefs(ws.id)[0]).toEqual({
      id: node.id,
      workspaceId: ws.id,
      type: 'agent-terminal',
      title: 'agy',
      state: state(),
    });
  });
});
