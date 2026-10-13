import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { SWITCHYARD_HOME, ensureDirs } from '../paths.js';

const UI_SESSION_PATH = join(SWITCHYARD_HOME, 'ui-session');

/** Loads the UI session token, generating one on first run. */
export function loadOrCreateUiToken(): { token: string; created: boolean } {
  ensureDirs();
  if (existsSync(UI_SESSION_PATH)) {
    const token = readFileSync(UI_SESSION_PATH, 'utf8').trim();
    if (token.length > 0) return { token, created: false };
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(UI_SESSION_PATH, token, { mode: 0o600 });
  chmodSync(UI_SESSION_PATH, 0o600);
  return { token, created: true };
}

export function randomId(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
