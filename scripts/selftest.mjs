#!/usr/bin/env node
// Idle budget check: boots the built server on a throwaway home/port, lets it settle,
// then asserts RSS and CPU stay small. Never starts a real agent. Run after `npm run build`.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RSS_MB = Number(process.env.SELFTEST_RSS_MB ?? 140);
const CPU_PCT = Number(process.env.SELFTEST_CPU_PCT ?? 3);
const home = mkdtempSync(join(tmpdir(), 'switchyard-selftest-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, ['--max-semi-space-size=1', 'packages/core/dist/server.js'], {
  env: { ...process.env, SWITCHYARD_HOME: home, SWITCHYARD_PORT: String(port) },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stat = () => {
  // /proc is Linux; on macOS fall back to ps.
  try {
    const f = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const ticks = Number(f[11]) + Number(f[12]);
    const rss = Number(readFileSync(`/proc/${child.pid}/statm`, 'utf8').split(' ')[1]) * 4096;
    return { ticks: ticks / 100, rss };
  } catch {
    return null;
  }
};
const psRss = () =>
  new Promise((res) => {
    const p = spawn('ps', ['-o', 'rss=,time=', '-p', String(child.pid)]);
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.on('close', () => {
      const [rss, time] = o.trim().split(/\s+/);
      const [m, s] = (time ?? '0:0').split(':').map(parseFloat);
      res({ rss: Number(rss) * 1024, ticks: m * 60 + s });
    });
  });
const sample = async () => stat() ?? (await psRss());

let ok = false;
for (let i = 0; i < 60 && !ok; i++) {
  try {
    ok = (await fetch(`http://127.0.0.1:${port}/`)).ok;
  } catch {
    await sleep(500);
  }
}
let failed = !ok;
if (!ok) console.error('server did not come up');
else {
  await sleep(5000);
  const a = await sample();
  await sleep(10000);
  const b = await sample();
  const cpu = ((b.ticks - a.ticks) / 10) * 100;
  const mb = b.rss / 1024 / 1024;
  console.log(`idle RSS ${mb.toFixed(0)} MB (budget ${RSS_MB}), CPU ${cpu.toFixed(2)}% (budget ${CPU_PCT})`);
  failed = mb > RSS_MB || cpu > CPU_PCT;
}
child.kill('SIGTERM');
await sleep(500);
rmSync(home, { recursive: true, force: true });
console.log(failed ? 'selftest FAILED' : 'selftest ok');
process.exit(failed ? 1 : 0);
