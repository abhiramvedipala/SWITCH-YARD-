import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { parseUsage, recordUsage, usageSummary } from './index.js';

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
});
