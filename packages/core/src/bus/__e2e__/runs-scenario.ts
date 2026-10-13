/**
 * Phase 6 DoD with the mock harness (no AI): plan -> approve -> build -> review (changes requested) -> fix -> approve,
 * then a result card with evidence. Runs inside <repo>/scratch/runs/<id>.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function runRunsScenario(log: (s: string) => void = () => {}, extraGoal = '') {
  const home = process.env.SWITCHYARD_HOME;
  if (!home || !home.includes(tmpdir())) throw new Error('set SWITCHYARD_HOME to a temp dir first');
  const { createCore } = await import('../../core.js');
  const { scratchRoot } = await import('../../paths.js');
  const core = createCore({ dbPath: join(home, 'runs.db'), coreUrl: 'http://127.0.0.1:1' });
  core.runs.available = ['mock'];
  mkdirSync(scratchRoot(), { recursive: true });
  const ws = core.store.createWorkspace('runs', scratchRoot());
  const goal =
    'Create hello.py with a function that reverses a string and pytest tests; have the other agent review' +
    extraGoal;
  const run = await core.runs.create(ws.id, {
    goal,
    location: 'scratch',
    planner: 'mock',
    builder: 'mock',
    reviewer: 'mock',
  });
  log(`run ${run.id} in ${run.cwd}`);
  const until = async (pred: () => boolean, ms = 60_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out; run is ${core.runs.get(run.id)?.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  await until(() => core.runs.get(run.id)!.status !== 'planning');
  const planned = core.runs.get(run.id)!;
  log(`plan: ${planned.steps.map((s) => `${s.key}(${s.role}/${s.harness})`).join(' -> ')}`);
  core.runs.start(run.id);
  await until(() => ['done', 'failed', 'stopped'].includes(core.runs.get(run.id)!.status));
  const fin = core.runs.get(run.id)!;
  for (const s of fin.steps) for (const l of s.log) log(`  [${s.key}] ${l.text.trim()}`);
  const res = fin.result!;
  const hello = readFileSync(join(fin.cwd, 'hello.py'), 'utf8');
  // F9: independent sums straight from the usage table, to compare with what the run object reports.
  const tokensWhere = (extra: string) =>
    core.db
      .prepare(
        `SELECT COUNT(*) turns, COALESCE(SUM(input_tokens + output_tokens), 0) tokens FROM usage WHERE run_id = ? ${extra}`,
      )
      .get(run.id) as { turns: number; tokens: number };
  const recorded = tokensWhere('');
  const recordedStepped = tokensWhere('AND step_id IS NOT NULL');
  core.monitor.stopLoop();
  core.db.close();
  return {
    status: fin.status,
    usageTokens: fin.usage.inputTokens + fin.usage.outputTokens,
    usageTurns: fin.usage.turns,
    recordedTokens: recorded.tokens,
    recordedTurns: recorded.turns,
    stepTokens: fin.steps.reduce((n, s) => n + s.usage.inputTokens + s.usage.outputTokens, 0),
    recordedStepTokens: recordedStepped.tokens,
    approved: res.approved,
    reviewRounds: res.reviewRounds,
    files: [...res.files.added, ...res.files.modified],
    gitStatus: res.git?.status ?? '',
    denials: res.denials,
    testsUnverified: res.tests.unverified ?? '',
    helloHasDocstring: hello.includes('"""'),
    tests: res.tests.unverified
      ? `unverified (${res.tests.unverified})`
      : `${res.tests.command} -> exit ${res.tests.exitCode}`,
  };
}
