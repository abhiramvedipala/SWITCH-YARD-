#!/usr/bin/env node
// Runs the web build in watch mode and the core server in watch mode side by side,
// without pulling in a process-runner dependency. Core serves packages/web/dist directly,
// so the DoD ("npm run dev" -> http://127.0.0.1:4777 shows the app) holds without a dev proxy.
import { spawn } from 'node:child_process';

const children = [];

function run(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: false });
  children.push(child);
  child.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}`);
    shutdown(code ?? 1);
  });
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code ?? 0);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('web', 'npm', ['run', 'dev', '-w', '@switchyard/web'], process.cwd());
run('bus-mcp', 'npm', ['run', 'dev', '-w', '@switchyard/bus-mcp'], process.cwd());
run('core', 'npm', ['run', 'dev', '-w', '@switchyard/core'], process.cwd());
