import type { Harness, NodeCtx, TerminalLaunch } from './types.js';
import { busEnv } from './util.js';

export function defaultShell(): string {
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

export const shell: Harness = {
  id: 'shell',
  label: 'Shell',
  isAgent: false,
  async detect() {
    return { installed: true, path: defaultShell() };
  },
  terminalLaunch(ctx: NodeCtx): TerminalLaunch {
    return {
      cmd: defaultShell(),
      args: ['-l'],
      env: busEnv(ctx.node.id),
      cwd: ctx.cwd,
    };
  },
};
