import { describe, it, expect } from 'vitest';
import {
  claudeStopDecision,
  agyPreInvocationDecision,
  agyStopDecision,
  BlockCounter,
  MAX_CONSECUTIVE_BLOCKS,
} from './delivery.js';

const b = (requests: number, notifies = 0) => ({ requests, notifies });

describe('claudeStopDecision', () => {
  it('stays out of the way with nothing waiting', () => {
    expect(
      claudeStopDecision({ stopHookActive: false, backlog: b(0), consecutiveBlocks: 0 }),
    ).toEqual({ output: {}, blocked: false });
  });

  it('blocks the stop when a request is waiting, naming how many', () => {
    const d = claudeStopDecision({ stopHookActive: false, backlog: b(2, 1), consecutiveBlocks: 0 });
    expect(d.blocked).toBe(true);
    expect(d.output).toEqual({
      decision: 'block',
      reason:
        'You have 3 new switchyard messages (2 requests). Call check_inbox, handle them, then stop.',
    });
  });

  it('never blocks again when stop_hook_active is set (loop guard)', () => {
    const d = claudeStopDecision({ stopHookActive: true, backlog: b(5), consecutiveBlocks: 0 });
    expect(d).toEqual({ output: {}, blocked: false });
  });

  it('stops blocking after the cap and falls back to non-blocking context', () => {
    const d = claudeStopDecision({
      stopHookActive: false,
      backlog: b(1),
      consecutiveBlocks: MAX_CONSECUTIVE_BLOCKS,
    });
    expect(d.blocked).toBe(false);
    expect(d.output).toMatchObject({ hookSpecificOutput: { hookEventName: 'Stop' } });
  });

  it('notify-only backlog adds context without blocking', () => {
    const d = claudeStopDecision({ stopHookActive: false, backlog: b(0, 2), consecutiveBlocks: 0 });
    expect(d.blocked).toBe(false);
    expect(JSON.stringify(d.output)).toContain('2 switchyard messages are waiting in check_inbox');
  });
});

describe('agy decisions', () => {
  it('PreInvocation injects an ephemeral reminder only when messages wait', () => {
    expect(agyPreInvocationDecision(b(0)).output).toEqual({});
    expect(agyPreInvocationDecision(b(1)).output).toEqual({
      injectSteps: [{ ephemeralMessage: '1 new switchyard message is waiting; call check_inbox.' }],
    });
  });

  it('Stop continues only when fully idle with an unanswered request, under the cap', () => {
    expect(
      agyStopDecision({ fullyIdle: true, backlog: b(1), consecutiveBlocks: 0 }).output,
    ).toMatchObject({ decision: 'continue' });
    expect(
      agyStopDecision({ fullyIdle: false, backlog: b(1), consecutiveBlocks: 0 }).output,
    ).toEqual({});
    expect(
      agyStopDecision({ fullyIdle: true, backlog: b(0, 3), consecutiveBlocks: 0 }).output,
    ).toEqual({});
    expect(
      agyStopDecision({ fullyIdle: true, backlog: b(1), consecutiveBlocks: MAX_CONSECUTIVE_BLOCKS })
        .output,
    ).toEqual({});
  });
});

describe('BlockCounter', () => {
  it('counts consecutive blocks and resets once nothing is pending', () => {
    const c = new BlockCounter();
    const blocked = { output: {}, blocked: true };
    c.record('n', blocked, b(1));
    c.record('n', blocked, b(1));
    expect(c.get('n')).toBe(2);
    c.record('n', { output: {}, blocked: false }, b(0));
    expect(c.get('n')).toBe(0);
  });
  it('keeps the count when the cap lets the agent stop while requests are still pending', () => {
    const c = new BlockCounter();
    c.record('n', { output: {}, blocked: true }, b(1));
    c.record('n', { output: {}, blocked: false }, b(1));
    expect(c.get('n')).toBe(1);
  });
});
