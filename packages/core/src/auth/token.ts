import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SWITCHYARD_HOME = join(homedir(), '.switchyard');
const UI_SESSION_PATH = join(SWITCHYARD_HOME, 'ui-session');

function ensureHome(): void {
  if (!existsSync(SWITCHYARD_HOME)) {
    mkdirSync(SWITCHYARD_HOME, { recursive: true, mode: 0o700 });
  }
}

/** Loads the UI session token, generating and printing one on first run. */
export function loadOrCreateUiToken(): { token: string; created: boolean } {
  ensureHome();
  if (existsSync(UI_SESSION_PATH)) {
    const token = readFileSync(UI_SESSION_PATH, 'utf8').trim();
    if (token.length > 0) return { token, created: false };
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(UI_SESSION_PATH, token, { mode: 0o600 });
  chmodSync(UI_SESSION_PATH, 0o600);
  return { token, created: true };
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // still run a comparison of equal length to avoid an early-return timing leak
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
