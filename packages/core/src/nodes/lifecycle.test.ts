import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeType } from '../store.js';

type Core = import('../core.js').Core;
let createCore: typeof import('../core.js').createCore;
let runFilePath: typeof import('../auth/capability.js').runFilePath;
let ptys: typeof import('../pty/manager.js').ptys;
let home: string;
let core: Core;
let ws: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'sy-lifecycle-home-'));
  process.env.SWITCHYARD_HOME = home;
  ({ createCore } = await import('../core.js'));
  ({ runFilePath } = await import('../auth/capability.js'));
  ({ ptys } = await import('../pty/manager.js'));
  core = createCore({ dbPath: join(home, 'db.sqlite'), coreUrl: 'http://127.0.0.1:1' });
  ws = core.store.createWorkspace('w', tmpdir()).id;
});
afterAll(() => ptys.killAll());

const mk = (type: NodeType) =>
  core.store.insertNode({
    workspaceId: ws,
    type,
    harness: 'mock',
    title: type,
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
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

describe('capability lifecycle (F6): invalidate on exit', () => {
  it('a terminal agent whose process exits loses its capability and run file', async () => {
    const id = mk('agent-terminal');
    const rf = core.caps.issue(id, ws, tmpdir());
    expect(core.caps.verify(id, rf.capability)).toBe(true);
    ptys.spawn(id, { cmd: 'bash', args: ['-c', 'exit 0'], cwd: tmpdir(), env: {} });
    expect(await until(() => !existsSync(runFilePath(id)))).toBe(true);
    expect(core.caps.verify(id, rf.capability)).toBe(false);
    expect(core.caps.verifyHook(id, rf.hookSecret)).toBe(false);
    expect(core.store.getNode(id)!.state).toBe('exited');
  });

  it('stop() revokes a terminal agent; a driven chat node keeps its capability', () => {
    const term = mk('agent-terminal');
    const chat = mk('agent-chat');
    const rfT = core.caps.issue(term, ws);
    const rfC = core.caps.issue(chat, ws);
    core.nodes.stop(term);
    core.nodes.stop(chat);
    expect(core.caps.verify(term, rfT.capability)).toBe(false);
    expect(existsSync(runFilePath(term))).toBe(false);
    expect(core.caps.verify(chat, rfC.capability)).toBe(true);
  });

  it('after a core restart, dead terminal agents are revoked and chat nodes restored', async () => {
    const term = mk('agent-terminal');
    const chat = mk('agent-chat');
    const rfT = core.caps.issue(term, ws);
    const rfC = core.caps.issue(chat, ws);
    core.db.close();
    core = createCore({ dbPath: join(home, 'db.sqlite'), coreUrl: 'http://127.0.0.1:1' });
    expect(core.caps.verify(chat, rfC.capability)).toBe(true);
    expect(core.caps.verify(term, rfT.capability)).toBe(false);
    expect(existsSync(runFilePath(term))).toBe(false);
    expect(core.store.getNode(term)!.state).toBe('exited');
  });
});
