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
const { runPersistentScenario } = await import('./persistent-scenario.js');
const { runRoomsScenario } = await import('./rooms-scenario.js');

let failed = false;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed = true;
};

console.log('== bus (Phase 3 DoD) ==');
const r = await runBusScenario((s) => console.log(`  ${s}`));
check(
  r.tools.length === 17 &&
    ['whoami', 'list_rooms', 'read_room', 'post_to_room'].every((t) => r.tools.includes(t)),
  `bus-mcp exposes 17 tools incl. whoami and the room tools (${r.tools.length})`,
);
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

console.log('== persistent agy session (F8, fake agy) ==');
const f8 = await runPersistentScenario((s) => console.log(`  ${s}`));
check(
  f8.chatOk.every(Boolean) && f8.chatSpawns.length === 2 && !f8.chatBusyOverlap,
  `F8 chat node: 4 turns on ${f8.chatSpawns.length} processes (one restart after the crash), never two prompts at once`,
);
check(
  /exited unexpectedly/.test(f8.crashError) &&
    f8.chatSpawns[1]!.join(' ').includes(`--conversation ${f8.conv}`),
  'F8 crash fails the turn; the restart resumes with --conversation <last id>',
);
check(f8.usageRows === 4, `F8 usage recorded per turn (${f8.usageRows} rows)`);
check(f8.chatStdinClosed, 'F8 deleting the node closes the session stdin');
check(
  f8.runSpawns === 1 && f8.runPrompts === f8.runBuildTurns && f8.runPrompts >= 2,
  `F8 run: build + review-fix turns share one agy process (${f8.runPrompts} prompts, ${f8.runSpawns} spawn)`,
);
check(f8.runStdinClosed, `F8 run end (${f8.runStatus}) closes the step session`);

console.log('== rooms (two mock participants + a canvas agent over bus-mcp) ==');
const rm = await runRoomsScenario((s) => console.log(`  ${s}`));
check(
  rm.listed.length === 1 && rm.listed[0]!.roomId === rm.roomId,
  'list_rooms shows the room of the agent’s workspace',
);
check(rm.afterFyi === 0, 'an agent post without an @mention starts no participant');
check(
  rm.afterMention.length === 1 && rm.afterMention[0]!.startsWith('Mock B:'),
  'an agent @mention starts only that participant',
);
check(
  rm.read.length === 5 && rm.read.filter((m) => m.authorKind === 'participant').length === 3,
  `read_room since= returns what came after (${rm.read.length} messages)`,
);
check(rm.usageTurns === 3, `usage recorded per participant turn (${rm.usageTurns})`);

process.exit(failed ? 1 : 0);
