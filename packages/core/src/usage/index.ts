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

/**
 * Claude Code's `total_cost_usd` is the session's running total: a `--resume`d turn "reports the conversation's
 * whole total, earlier runs' spend included" (docs/headless). Token counts in `usage` stay per turn. So a Claude
 * row stores the raw figure in reported_cost_usd and bills only the delta since the session's last row; the first
 * row of a session (or one that drops below the previous total: a fresh session) bills the full figure.
 * The last usage row of a session is the cursor, so no cursor table.
 */
function claudeTurnCost(db: Db, sessionId: string, reported: number): number {
  const prev = db
    .prepare(
      'SELECT reported_cost_usd prev FROM usage WHERE session_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(sessionId) as { prev: number | null } | undefined;
  return prev?.prev != null && reported >= prev.prev ? reported - prev.prev : reported;
}

/** One row per finished turn. Cheap: a single insert (plus one indexed lookup for Claude), no polling. */
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
  res: Pick<TurnResult, 'usage'> & { sessionId?: string | null },
): void {
  const { costUsd: reported, input, output } = parseUsage(res.usage);
  const sessionId = res.sessionId ?? null;
  const costUsd =
    ctx.harness === 'claude' && sessionId ? claudeTurnCost(db, sessionId, reported) : reported;
  db.prepare(
    'INSERT INTO usage (ts, harness, node_id, run_id, step_id, room_id, participant_id, session_id, cost_usd, reported_cost_usd, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    Date.now(),
    ctx.harness,
    ctx.nodeId ?? null,
    ctx.runId ?? null,
    ctx.stepId ?? null,
    ctx.roomId ?? null,
    ctx.participantId ?? null,
    sessionId,
    costUsd,
    reported,
    input,
    output,
  );
}

/**
 * Recompute cost_usd for Claude rows from reported_cost_usd (the raw per-turn figure), per session in id order,
 * with the same rule recordUsage applies live. Idempotent: reported_cost_usd is only filled where it is NULL
 * (rows written before the column existed, whose cost_usd was the raw figure), and session_id only where NULL,
 * from the owner's current session; rows without a known session group by their owner (node, participant,
 * step, run) instead, and a total that drops below the previous one still starts a fresh session.
 */
export const USAGE_REPAIR_SQL = `
  UPDATE usage SET reported_cost_usd = cost_usd WHERE reported_cost_usd IS NULL;
  UPDATE usage SET session_id = (SELECT session_ref FROM nodes WHERE nodes.id = usage.node_id)
    WHERE session_id IS NULL AND node_id IS NOT NULL;
  UPDATE usage SET session_id = (SELECT session_ref FROM room_participants WHERE room_participants.id = usage.participant_id)
    WHERE session_id IS NULL AND participant_id IS NOT NULL;
  UPDATE usage SET session_id = (SELECT session_ref FROM run_steps WHERE run_steps.id = usage.step_id)
    WHERE session_id IS NULL AND step_id IS NOT NULL;
  UPDATE usage SET cost_usd = CASE WHEN p.prev IS NULL OR p.cur < p.prev THEN p.cur ELSE p.cur - p.prev END
    FROM (
      SELECT id, reported_cost_usd cur,
        LAG(reported_cost_usd) OVER (
          PARTITION BY COALESCE(session_id, node_id, participant_id, step_id, run_id, '') ORDER BY id
        ) prev
      FROM usage WHERE harness = 'claude'
    ) p
    WHERE usage.id = p.id;
`;

export function repairClaudeUsage(db: Db): void {
  db.exec(USAGE_REPAIR_SQL);
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
