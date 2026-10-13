import type { Db } from '../db/index.js';
import type { TurnResult } from '../harness/types.js';

export interface UsageRow {
  harness: string;
  turns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

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
  ctx: { harness: string; nodeId?: string | null; runId?: string | null },
  res: Pick<TurnResult, 'usage'>,
): void {
  const { costUsd, input, output } = parseUsage(res.usage);
  db.prepare(
    'INSERT INTO usage (ts, harness, node_id, run_id, cost_usd, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?)',
  ).run(Date.now(), ctx.harness, ctx.nodeId ?? null, ctx.runId ?? null, costUsd, input, output);
}

export function usageSummary(
  db: Db,
  where: { nodeId?: string; runId?: string } = {},
): { total: Omit<UsageRow, 'harness'>; byHarness: UsageRow[] } {
  const clause = where.nodeId ? 'WHERE node_id = ?' : where.runId ? 'WHERE run_id = ?' : '';
  const args = where.nodeId ? [where.nodeId] : where.runId ? [where.runId] : [];
  const rows = db
    .prepare(
      `SELECT harness, COUNT(*) turns, SUM(cost_usd) costUsd, SUM(input_tokens) inputTokens, SUM(output_tokens) outputTokens FROM usage ${clause} GROUP BY harness`,
    )
    .all(...args) as UsageRow[];
  const total = { turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  for (const r of rows) {
    total.turns += r.turns;
    total.costUsd += r.costUsd;
    total.inputTokens += r.inputTokens;
    total.outputTokens += r.outputTokens;
  }
  return { total, byHarness: rows };
}
