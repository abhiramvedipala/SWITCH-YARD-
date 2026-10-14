import type { Db } from '../db/index.js';
import type { TurnResult } from '../harness/types.js';

export interface UsageTotals {
  turns: number;
  /** 0 when no turn reported a price (mock, agy): the UI then shows tokens only. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageRow extends UsageTotals {
  harness: string;
}

export const zeroUsage = (): UsageTotals => ({
  turns: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
});

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Pull cost/tokens out of whatever shape a harness reported (Claude: total_cost_usd + usage{input,output}_tokens). */
export function parseUsage(raw: unknown): { costUsd: number; input: number; output: number } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const u = (o.usage && typeof o.usage === 'object' ? o.usage : o) as Record<string, unknown>;
  return {
    costUsd: num(o.total_cost_usd ?? o.costUsd),
    input: num(u.input_tokens ?? u.inputTokens),
    output: num(u.output_tokens ?? u.outputTokens),
  };
}

/** One row per finished turn. Cheap: a single insert, no polling. */
export function recordUsage(
  db: Db,
  ctx: {
    harness: string;
    nodeId?: string | null;
    runId?: string | null;
    stepId?: string | null;
    roomId?: string | null;
    participantId?: string | null;
  },
  res: Pick<TurnResult, 'usage'>,
): void {
  const { costUsd, input, output } = parseUsage(res.usage);
  db.prepare(
    'INSERT INTO usage (ts, harness, node_id, run_id, step_id, room_id, participant_id, cost_usd, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(
    Date.now(),
    ctx.harness,
    ctx.nodeId ?? null,
    ctx.runId ?? null,
    ctx.stepId ?? null,
    ctx.roomId ?? null,
    ctx.participantId ?? null,
    costUsd,
    input,
    output,
  );
}

const SUMS =
  'COUNT(*) turns, SUM(cost_usd) costUsd, SUM(input_tokens) inputTokens, SUM(output_tokens) outputTokens';

const add = (into: UsageTotals, r: UsageTotals): UsageTotals => {
  into.turns += r.turns;
  into.costUsd += r.costUsd;
  into.inputTokens += r.inputTokens;
  into.outputTokens += r.outputTokens;
  return into;
};

export function usageSummary(
  db: Db,
  where: { nodeId?: string; runId?: string; roomId?: string } = {},
): { total: UsageTotals; byHarness: UsageRow[] } {
  const [col, val] = where.nodeId
    ? ['node_id', where.nodeId]
    : where.runId
      ? ['run_id', where.runId]
      : where.roomId
        ? ['room_id', where.roomId]
        : [null, null];
  const clause = col ? `WHERE ${col} = ?` : '';
  const args = val ? [val] : [];
  const rows = db
    .prepare(`SELECT harness, ${SUMS} FROM usage ${clause} GROUP BY harness`)
    .all(...args) as UsageRow[];
  return { total: rows.reduce(add, zeroUsage()), byHarness: rows };
}

/** One grouped query per run read: the run total plus a per-step breakdown (planner turns have no step and only count toward the total). */
export function runUsage(
  db: Db,
  runId: string,
): { total: UsageTotals; byStep: Record<string, UsageTotals> } {
  const rows = db
    .prepare(`SELECT step_id stepId, ${SUMS} FROM usage WHERE run_id = ? GROUP BY step_id`)
    .all(runId) as (UsageTotals & { stepId: string | null })[];
  const byStep: Record<string, UsageTotals> = {};
  for (const { stepId, ...t } of rows) if (stepId) byStep[stepId] = t;
  return { total: rows.reduce(add, zeroUsage()), byStep };
}
