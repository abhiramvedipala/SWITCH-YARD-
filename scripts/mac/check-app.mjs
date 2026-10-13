#!/usr/bin/env node
// Builds Switchyard.app into a temp dir and checks the bundle: Info.plist keys, a Mach-O binary, a valid
// ad-hoc signature (swift mode). With SWITCHYARD_MAC_LAUNCH=1 it also runs the app binary directly with
// SWITCHYARD_PORT/SWITCHYARD_HOME pointing at a free port and a temp home, waits for the server it
// starts, then kills both. Never touches ~/.switchyard or ~/Applications. Usage: npm run mac:check
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dest = mkdtempSync(join(tmpdir(), 'sy-mac-app-'));
const home = mkdtempSync(join(tmpdir(), 'sy-mac-home-'));
const app = join(dest, 'Switchyard.app');
const plist = join(app, 'Contents/Info.plist');
const env = { ...process.env, SWITCHYARD_HOME: home };
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', env, stdio: 'pipe' }).trim();
let failed = 0;
const check = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

try {
  const out = sh('bash', [join(root, 'scripts/mac/make-app.sh'), dest]);
  check(out.includes('Built '), `make-app.sh ran: ${out.split('\n').pop()}`);
  const meta = JSON.parse(readFileSync(join(home, 'mac-app.json'), 'utf8'));
  check(
    meta.repo === root && ['swift', 'bash'].includes(meta.mode),
    `mac-app.json: mode=${meta.mode}`,
  );

  check(sh('plutil', ['-lint', plist]).endsWith('OK'), 'Info.plist lints');
  const key = (k) => sh('plutil', ['-extract', k, 'raw', '-o', '-', plist]);
  check(key('CFBundleName') === 'Switchyard', 'CFBundleName = Switchyard');
  const exe = join(app, 'Contents/MacOS', key('CFBundleExecutable'));
  check(existsSync(exe), `executable exists: ${exe}`);

  if (meta.mode === 'swift') {
    check(
      key('CFBundleIdentifier') === 'local.switchyard.app',
      'CFBundleIdentifier = local.switchyard.app',
    );
    check(key('NSHighResolutionCapable') === 'true', 'NSHighResolutionCapable');
    check(/^\d+\.\d+$/.test(key('LSMinimumSystemVersion')), 'LSMinimumSystemVersion set');
    let lsui = 'absent';
    try {
      lsui = key('LSUIElement');
    } catch {
      // absent is what we want: a normal Dock app
    }
    check(lsui === 'absent', 'LSUIElement absent (regular Dock app)');
    check(sh('file', [exe]).includes('Mach-O'), 'binary is Mach-O');
    execFileSync('codesign', ['-v', app]);
    check(true, 'codesign -v passes');
    check(existsSync(join(app, 'Contents/Resources/Switchyard.icns')), 'icon generated');
  }

  if (process.env.SWITCHYARD_MAC_LAUNCH === '1') {
    const port = await freePort();
    const proc = spawn(exe, [], {
      env: { ...env, SWITCHYARD_PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await sleep(500);
      up = await fetch(`http://127.0.0.1:${port}/`).then(
        (r) => r.ok,
        () => false,
      );
    }
    check(up, `app started the server on port ${port}`);
    check(existsSync(join(home, 'ui-session')), 'server wrote ui-session into SWITCHYARD_HOME');
    if (meta.mode === 'swift')
      check(err.includes('server down, starting it'), 'app logged the bootstrap');
    proc.kill('SIGTERM');
    const pidFile = join(home, 'server.pid');
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').split('\n')[0]);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
      await sleep(500);
    }
    const stillUp = await fetch(`http://127.0.0.1:${port}/`).then(
      () => true,
      () => false,
    );
    check(!stillUp, 'server stopped via server.pid');
  }
} catch (e) {
  failed++;
  console.log(`FAIL  ${e.stderr ?? e.message ?? e}`);
} finally {
  rmSync(dest, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nmac:check OK');
process.exit(failed ? 1 : 0);
