import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-e2e-home-'));
process.env.SWITCHYARD_SCRATCH_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../scratch',
);

const { runBusScenario } = await import('./scenario.js');
const { runRunsScenario } = await import('./runs-scenario.js');

let failed = false;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed = true;
};

console.log('== bus (Phase 3 DoD) ==');
const r = await runBusScenario((s) => console.log(`  ${s}`));
check(r.tools.length === 13, `bus-mcp exposes 13 tools (${r.tools.length})`);
check(
  r.reply.status === 'replied' && r.reply.body === 'pong',
  'A received B\'s "pong" via wait_for_reply',
);
check(r.cPeers.length === 0, 'unconnected C sees no peers');
check(r.cInbox.length === 0, 'unconnected C received nothing');
check(/not_connected/.test(r.unconnectedError), 'C cannot message A');

console.log('== runs (Phase 6 DoD, mock harness) ==');
const run = await runRunsScenario((s) => console.log(`  ${s}`));
check(run.status === 'done', `run finished (${run.status})`);
check(
  run.reviewRounds >= 2,
  `review took ${run.reviewRounds} rounds (one round changed something)`,
);
check(run.approved === true, 'final review approved');
check(
  run.files.includes('hello.py') && run.files.includes('test_hello.py'),
  `files touched: ${run.files.join(', ')}`,
);
check(run.helloHasDocstring, 'hello.py was changed by the review round (docstring added)');
check(
  run.gitStatus.includes('hello.py'),
  'result card has real git evidence (scratch run is a git repo)',
);
console.log(`  tests evidence: ${run.tests}`);
check(
  run.usageTokens > 0 &&
    run.usageTokens === run.recordedTokens &&
    run.usageTurns === run.recordedTurns,
  `F9 run usage total equals the sum of recorded turn usages (${run.usageTurns} turns, ${run.usageTokens} tokens)`,
);
check(
  run.stepTokens > 0 && run.stepTokens === run.recordedStepTokens,
  `F9 step usage adds up to the turns billed to steps (${run.stepTokens} of ${run.usageTokens} tokens; the rest is the planner)`,
);

process.exit(failed ? 1 : 0);
