#!/usr/bin/env node
// Stops a running Switchyard server (started with `npm start`, the Mac launcher, or `npm run dev`'s core).
// It reads the pid file the server writes in ~/.switchyard (or $SWITCHYARD_HOME) and sends SIGTERM,
// which lets the server close its terminals and database cleanly.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.SWITCHYARD_HOME ?? join(homedir(), '.switchyard');
const pidFile = join(home, 'server.pid');
if (!existsSync(pidFile)) {
  console.log('Switchyard is not running (no pid file).');
  process.exit(0);
}
const pid = Number(readFileSync(pidFile, 'utf8').split('\n')[0]);
try {
  process.kill(pid, 0); // throws if the process is gone
  process.kill(pid, 'SIGTERM');
  console.log(`Stopped Switchyard (pid ${pid}).`);
} catch {
  console.log('Switchyard was not running (stale pid file).');
}
