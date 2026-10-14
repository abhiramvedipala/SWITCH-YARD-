import { describe, it, expect } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { parseUsage, recordUsage, repairClaudeUsage, runUsage, usageSummary } from './index.js';

const claudeTurn = (cumulative: number, tokens = 10) => ({
  total_cost_usd: cumulative,
  usage: { input_tokens: tokens, output_tokens: tokens },
});
const costs = (db: Db, nodeId: string) =>
  (
    db.prepare('SELECT cost_usd c FROM usage WHERE node_id = ? ORDER BY id').all(nodeId) as {
      c: number;
    }[]
  ).map((r) => r.c);

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

describe('Claude reports a running session total; rows bill the per-turn delta', () => {
  it('three resumed turns 0.10 / 0.25 / 0.30 record 0.10 / 0.15 / 0.05; tokens stay per turn', () => {
    const db = openDb(':memory:');
    for (const c of [0.1, 0.25, 0.3])
      recordUsage(
        db,
        { harness: 'claude', nodeId: 'n1' },
        { sessionId: 's1', usage: claudeTurn(c) },
      );
    const [a, b, c] = costs(db, 'n1');
    expect(a).toBeCloseTo(0.1, 9);
    expect(b).toBeCloseTo(0.15, 9);
    expect(c).toBeCloseTo(0.05, 9);
    const t = usageSummary(db, { nodeId: 'n1' }).total;
    expect(t.costUsd).toBeCloseTo(0.3, 9);
    expect(t).toMatchObject({ turns: 3, inputTokens: 30, outputTokens: 30 });
    expect(
      db.prepare('SELECT reported_cost_usd r FROM usage WHERE node_id = ? ORDER BY id').all('n1'),
    ).toEqual([{ r: 0.1 }, { r: 0.25 }, { r: 0.3 }]);
  });
  it('a new session id mid-chat bills its full total; so does a total lower than the previous one', () => {
    const db = openDb(':memory:');
    recordUsage(
      db,
      { harness: 'claude', nodeId: 'n1' },
      { sessionId: 's1', usage: claudeTurn(0.2) },
    );
    recordUsage(
      db,
      { harness: 'claude', nodeId: 'n1' },
      { sessionId: 's2', usage: claudeTurn(0.07) },
    );
    recordUsage(
      db,
      { harness: 'claude', nodeId: 'n1' },
      { sessionId: 's2', usage: claudeTurn(0.09) },
    );
    recordUsage(
      db,
      { harness: 'claude', nodeId: 'n1' },
      { sessionId: 's2', usage: claudeTurn(0.04) },
    ); // dropped: fresh
    recordUsage(
      db,
      { harness: 'claude', nodeId: 'n1' },
      { sessionId: 's2', usage: claudeTurn(0.1) },
    );
    const got = costs(db, 'n1');
    for (const [i, want] of [0.2, 0.07, 0.02, 0.04, 0.06].entries())
      expect(got[i]).toBeCloseTo(want, 9);
    // No session id at all (an error result): nothing to diff against, the full figure is recorded.
    recordUsage(
      db,
      { harness: 'claude', nodeId: 'n2' },
      { sessionId: null, usage: claudeTurn(0.5) },
    );
    expect(costs(db, 'n2')).toEqual([0.5]);
  });
  it('other harnesses report per-turn figures and are stored as-is', () => {
    const db = openDb(':memory:');
    for (const h of ['agy', 'codex', 'api-anthropic', 'mock'])
      for (const c of [0.1, 0.25])
        recordUsage(db, { harness: h, nodeId: h }, { sessionId: 'same', usage: claudeTurn(c) });
    for (const h of ['agy', 'codex', 'api-anthropic', 'mock'])
      expect(costs(db, h)).toEqual([0.1, 0.25]);
  });
  it('repairs rows recorded before the fix (raw totals in cost_usd, no session id), idempotently', () => {
    const db = openDb(':memory:');
    const now = Date.now();
    db.prepare(
      "INSERT INTO workspaces (id, name, root_dir, created_at) VALUES ('w', 'w', '/tmp', ?)",
    ).run(now);
    db.prepare(
      "INSERT INTO nodes (id, workspace_id, type, harness, title, session_ref, created_at) VALUES ('n1', 'w', 'agent-chat', 'claude', 'n1', 'live', ?)",
    ).run(now);
    const legacy = db.prepare(
      'INSERT INTO usage (ts, harness, node_id, room_id, participant_id, cost_usd, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?)',
    );
    // A chat node: three resumed turns, then the chat was cleared (total drops) and two more turns.
    for (const c of [0.1, 0.25, 0.3, 0.05, 0.15])
      legacy.run(now, 'claude', 'n1', null, null, c, 10, 10);
    // A room participant whose participant row is gone: grouped by participant id.
    for (const c of [1, 1.5]) legacy.run(now, 'claude', null, 'room', 'p1', c, 10, 10);
    // agy in the same room: untouched.
    legacy.run(now, 'agy', null, 'room', 'p2', 0, 10, 10);
    repairClaudeUsage(db);
    const want = [0.1, 0.15, 0.05, 0.05, 0.1];
    costs(db, 'n1').forEach((c, i) => expect(c).toBeCloseTo(want[i]!, 9));
    expect(usageSummary(db, { nodeId: 'n1' }).total.costUsd).toBeCloseTo(0.45, 9);
    expect(usageSummary(db, { roomId: 'room' }).total.costUsd).toBeCloseTo(1.5, 9);
    expect(
      db
        .prepare(
          'SELECT session_id s, reported_cost_usd r FROM usage WHERE node_id = ? ORDER BY id',
        )
        .all('n1'),
    ).toEqual([0.1, 0.25, 0.3, 0.05, 0.15].map((r) => ({ s: 'live', r })));
    // The backfilled session id is what the next live turn diffs against: no double-billing after upgrade.
    recordUsage(
      db,
      { harness: 'claude', nodeId: 'n1' },
      { sessionId: 'live', usage: claudeTurn(0.2) },
    );
    expect(costs(db, 'n1')[5]).toBeCloseTo(0.05, 9);
    const rows = db.prepare('SELECT * FROM usage ORDER BY id').all();
    repairClaudeUsage(db);
    expect(db.prepare('SELECT * FROM usage ORDER BY id').all()).toEqual(rows);
    expect(usageSummary(db, { nodeId: 'n1' }).total.costUsd).toBeCloseTo(0.5, 9);
    expect(usageSummary(db, { roomId: 'room' }).total.costUsd).toBeCloseTo(1.5, 9);
  });
});
