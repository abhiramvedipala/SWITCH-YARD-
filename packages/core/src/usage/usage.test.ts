import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { parseUsage, recordUsage, runUsage, usageSummary } from './index.js';

describe('usage meter', () => {
  it('parses Claude-shaped usage and ignores junk', () => {
    expect(
      parseUsage({ total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 4 } }),
    ).toEqual({
      costUsd: 0.5,
      input: 10,
      output: 4,
    });
    expect(parseUsage('nope')).toEqual({ costUsd: 0, input: 0, output: 0 });
  });
  it('sums per node and per run', () => {
    const db = openDb(':memory:');
    recordUsage(
      db,
      { harness: 'claude', nodeId: 'n1' },
      { usage: { total_cost_usd: 1, usage: { input_tokens: 5, output_tokens: 1 } } },
    );
    recordUsage(
      db,
      { harness: 'claude', nodeId: 'n1', runId: 'r1' },
      { usage: { total_cost_usd: 2 } },
    );
    recordUsage(db, { harness: 'agy', runId: 'r1' }, {});
    expect(usageSummary(db, { nodeId: 'n1' }).total).toMatchObject({
      turns: 2,
      costUsd: 3,
      inputTokens: 5,
    });
    expect(usageSummary(db, { runId: 'r1' }).byHarness).toHaveLength(2);
  });
  it('totals a run and groups by step; cost stays 0 when a harness reports no $', () => {
    const db = openDb(':memory:');
    const claude = { total_cost_usd: 0.25, usage: { input_tokens: 100, output_tokens: 50 } };
    const agy = { usage: { input_tokens: 10, output_tokens: 5 } }; // agy: tokens, no price
    recordUsage(db, { harness: 'claude', runId: 'r1' }, { usage: claude }); // planner, no step
    recordUsage(db, { harness: 'claude', runId: 'r1', stepId: 'build' }, { usage: claude });
    recordUsage(db, { harness: 'agy', runId: 'r1', stepId: 'review' }, { usage: agy });
    recordUsage(db, { harness: 'agy', runId: 'r1', stepId: 'review' }, { usage: agy });
    recordUsage(db, { harness: 'claude', runId: 'other', stepId: 'build' }, { usage: claude });
    const u = runUsage(db, 'r1');
    expect(u.total).toEqual({ turns: 4, costUsd: 0.5, inputTokens: 220, outputTokens: 110 });
    expect(u.byStep).toEqual({
      build: { turns: 1, costUsd: 0.25, inputTokens: 100, outputTokens: 50 },
      review: { turns: 2, costUsd: 0, inputTokens: 20, outputTokens: 10 },
    });
    expect(runUsage(db, 'none')).toEqual({
      total: { turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
      byStep: {},
    });
  });
});
