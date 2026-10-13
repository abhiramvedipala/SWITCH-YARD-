/**
 * F8 with a fake agy (zero AI): Settings → agyPersistentSessions on, then
 * - a chat node: two turns on one process, a crash, a restart with --conversation, stdin closed on delete;
 * - a run whose build step is on agy: the build turn and the review-fix turns share one process, closed at the end.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type Entry = { start?: string[]; recv?: string; busy?: boolean; stdin?: string };

export async function runPersistentScenario(log: (s: string) => void = () => {}) {
  const home = process.env.SWITCHYARD_HOME;
  if (!home || !home.includes(tmpdir())) throw new Error('set SWITCHYARD_HOME to a temp dir first');
  const fake = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../harness/__fixtures__/fake-agy.mjs',
  );
  chmodSync(fake, 0o755);
  process.env.SWITCHYARD_AGY_BIN = fake; // never the real agy
  process.env.SWITCHYARD_GEMINI_DIR = join(home, 'gemini');
  const logFile = join(home, 'fake-agy.log');
  process.env.FAKE_AGY_LOG = logFile;
  const entries = (): Entry[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Entry)
      : [];
  const until = async (cond: () => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return cond();
  };

  const { createCore } = await import('../../core.js');
  const { setSetting } = await import('../../db/index.js');
  const { scratchRoot } = await import('../../paths.js');
  const core = createCore({ dbPath: join(home, 'persistent.db'), coreUrl: 'http://127.0.0.1:1' });
  setSetting(core.db, 'agyPersistentSessions', true);
  mkdirSync(scratchRoot(), { recursive: true });
  const ws = core.store.createWorkspace('f8', tmpdir());

  // ---- chat node
  const node = core.nodes.create(ws.id, { type: 'agent-chat', harness: 'agy', title: 'agy chat' });
  const t1 = await core.chat.send(node.id, 'hello');
  const t2 = await core.chat.send(node.id, 'and again');
  const conv = core.store.getNode(node.id)!.sessionRef;
  log(`chat turns: ${t1.ok}, ${t2.ok} (conversation ${conv})`);
  const crash = await core.chat.send(node.id, '[crash] please');
  log(`crash turn: ok=${crash.ok} error="${crash.error}"`);
  const t4 = await core.chat.send(node.id, 'still there?');
  const chatStarts = entries().filter((e) => e.start);
  const usageRows = (
    core.db.prepare('SELECT COUNT(*) n FROM usage WHERE node_id = ?').get(node.id) as { n: number }
  ).n;
  core.nodes.remove(node.id);
  const chatStdinClosed = await until(() => entries().some((e) => e.stdin === 'end'));
  log(
    `chat: ${chatStarts.length} spawns, ${usageRows} usage rows, stdin closed=${chatStdinClosed}`,
  );

  // ---- run with the build step on agy
  core.runs.available = ['mock', 'agy'];
  const before = entries().length;
  const run = await core.runs.create(ws.id, {
    goal: 'Write a note for F8',
    location: 'scratch',
    planner: 'mock',
    builder: 'mock',
    reviewer: 'mock',
  });
  await until(() => core.runs.get(run.id)!.status !== 'planning');
  const build = core.runs.get(run.id)!.steps.find((s) => s.role === 'build')!;
  core.runs.updateStep(run.id, build.id, { harness: 'agy' });
  core.runs.start(run.id);
  await until(() => ['done', 'failed', 'stopped'].includes(core.runs.get(run.id)!.status), 60_000);
  const fin = core.runs.get(run.id)!;
  const runLog = entries().slice(before);
  const runStdinClosed = await until(() =>
    entries()
      .slice(before)
      .some((e) => e.stdin === 'end'),
  );
  const runBuild = fin.steps.find((s) => s.id === build.id)!;
  log(
    `run ${fin.status}: agy spawns=${runLog.filter((e) => e.start).length}, prompts=${runLog.filter((e) => e.recv).length}, build turns billed=${runBuild.usage.turns}, stdin closed=${runStdinClosed}`,
  );
  core.monitor.stopLoop();
  core.db.close();
  return {
    chatOk: [t1.ok, t2.ok, t4.ok],
    conv,
    crashError: crash.error ?? '',
    chatSpawns: chatStarts.map((e) => e.start!),
    chatBusyOverlap: entries().some((e) => e.busy),
    usageRows,
    chatStdinClosed,
    runStatus: fin.status,
    runSpawns: runLog.filter((e) => e.start).length,
    runPrompts: runLog.filter((e) => e.recv).length,
    runBuildTurns: runBuild.usage.turns,
    runStdinClosed,
  };
}
