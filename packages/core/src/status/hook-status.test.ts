import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { openDb } from '../db/index.js';
import { Store, type NodeState } from '../store.js';
import { Bus } from '../bus/service.js';
import { StatusMonitor } from './monitor.js';

let store: Store;
let monitor: StatusMonitor;
let id: string;
const state = (): NodeState => store.getNode(id)!.state;

beforeEach(() => {
  store = new Store(openDb(':memory:'));
  monitor = new StatusMonitor(store, new Bus(store));
  const ws = store.createWorkspace('w', tmpdir());
  id = store.insertNode({
    workspaceId: ws.id,
    type: 'agent-terminal',
    harness: 'claude',
    title: 'C',
    cwd: tmpdir(),
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    state: 'starting',
    sessionRef: null,
    yolo: false,
    data: {},
    summary: '',
  }).id;
});

const hook = (event: string, payload: Record<string, unknown> = {}) =>
  monitor.onHook(id, 'claude', event, payload);

describe('Claude hook → node status', () => {
  it('SessionStart idle; prompt and tool events working; Stop idle; SessionEnd exited', () => {
    hook('SessionStart');
    expect(state()).toBe('idle');
    hook('UserPromptSubmit');
    expect(state()).toBe('working');
    hook('Stop');
    expect(state()).toBe('idle');
    hook('PreToolUse');
    expect(state()).toBe('working');
    hook('SessionEnd');
    expect(state()).toBe('exited');
  });

  it.each([
    'permission_prompt',
    'elicitation_dialog',
    'elicitation_url_dialog',
    'agent_needs_input',
  ])('Notification %s means needs_input', (t) => {
    hook('UserPromptSubmit');
    hook('Notification', { notification_type: t });
    expect(state()).toBe('needs_input');
  });

  it.each([
    'auth_success',
    'elicitation_complete',
    'elicitation_response',
    'quota_auto_resume_fired',
    'something_new',
  ])('Notification %s does not change the status', (t) => {
    hook('UserPromptSubmit');
    hook('Notification', { notification_type: t });
    expect(state()).toBe('working');
  });

  it('idle_prompt and agent_completed mean idle', () => {
    hook('UserPromptSubmit');
    hook('Notification', { notification_type: 'idle_prompt' });
    expect(state()).toBe('idle');
  });

  it('StopFailure goes idle and records why', () => {
    hook('UserPromptSubmit');
    hook('StopFailure', { error: 'rate_limit' });
    expect(state()).toBe('idle');
    expect(store.getNode(id)!.data.lastError).toBe('rate_limit');
  });
});
