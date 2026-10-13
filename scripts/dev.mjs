#!/usr/bin/env node
// `npm run dev`: the Vite dev server with HMR on http://127.0.0.1:5173 (it proxies /api, /bus and /ws to core,
// see packages/web/vite.config.ts), bus-mcp in watch mode and core with auto-reload, side by side and without
// pulling in a process-runner dependency.
// `npm run dev:build` (--build): the old mode. A watch build into packages/web/dist that core serves itself,
// so http://127.0.0.1:4777 shows the app without a dev proxy (no HMR; reload the page after a change).
import { spawn } from 'node:child_process';

const hmr = !process.argv.includes('--build');
const core = `http://127.0.0.1:${process.env.SWITCHYARD_PORT ?? 4777}`;
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

console.log(
  hmr
    ? `\nSwitchyard dev UI (HMR): http://127.0.0.1:5173   (core: ${core})\n`
    : `\nSwitchyard dev UI (watch build, no HMR): ${core}\n`,
);
run('web', 'npm', ['run', hmr ? 'dev' : 'dev:build', '-w', '@switchyard/web'], process.cwd());
run('bus-mcp', 'npm', ['run', 'dev', '-w', '@switchyard/bus-mcp'], process.cwd());
run('core', 'npm', ['run', 'dev', '-w', '@switchyard/core'], process.cwd());
