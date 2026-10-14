import type { Harness, HarnessId } from './types.js';
import { claude } from './claude.js';
import { agy } from './agy.js';
import { codex } from './codex.js';
import { shell } from './shell.js';
import { mock } from './mock.js';

export const harnesses: Record<HarnessId, Harness> = { claude, agy, codex, shell, mock };

export function getHarness(id: string | null | undefined): Harness {
  const h = harnesses[(id ?? 'shell') as HarnessId];
  if (!h) throw new Error(`unknown harness ${id}`);
  return h;
}

export function isHarnessId(id: unknown): id is HarnessId {
  return typeof id === 'string' && id in harnesses;
}
