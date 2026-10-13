import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { openDb, getSetting, setSetting } from '../db/index.js';
import { createRemoteVerifier, tailscaleWhois, WHOIS_TTL_MS } from './remote.js';

const serve = (ip: string, login: string) =>
  ({
    headers: { 'x-forwarded-for': ip, 'tailscale-user-login': login },
  }) as unknown as FastifyRequest;

const setup = (whois: (ip: string) => Promise<string | null>) => {
  const db = openDb(':memory:');
  const log = vi.fn();
  const runner = vi.fn(whois);
  return { db, log, runner, verify: createRemoteVerifier(db, runner, log) };
};

afterEach(() => vi.useRealTimers());

describe('remote verifier', () => {
  it('caches whois per IP for 60 s, then asks again', async () => {
    vi.useFakeTimers();
    const { verify, runner } = setup(async () => 'a@x');
    expect((await verify(serve('100.64.0.2', 'a@x'))).ok).toBe(true);
    expect((await verify(serve('100.64.0.2', 'a@x'))).ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(WHOIS_TTL_MS + 1);
    expect((await verify(serve('100.64.0.2', 'a@x'))).ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('uses the last x-forwarded-for entry (the one Serve appended)', async () => {
    const { verify, runner } = setup(async (ip) => (ip === '100.64.0.2' ? 'a@x' : 'victim@x'));
    expect((await verify(serve('100.64.0.7, 100.64.0.2', 'a@x'))).ok).toBe(true);
    expect(runner).toHaveBeenCalledWith('100.64.0.2');
    expect(await verify(serve('not-an-ip', 'a@x'))).toEqual({
      ok: false,
      reason: 'remote_identity_required',
    });
  });

  it('fails closed and logs once when whois cannot run (binary missing)', async () => {
    const { verify, runner, log } = setup(async () => {
      throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
    });
    expect(await verify(serve('100.64.0.2', 'a@x'))).toEqual({
      ok: false,
      reason: 'remote_identity_unverified',
    });
    expect(await verify(serve('100.64.0.3', 'a@x'))).toEqual({
      ok: false,
      reason: 'remote_identity_unverified',
    });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/whois 100\.64\.0\.2 failed.*ENOENT/);
  });

  it('pins the first verified login; a different login is refused until cleared locally', async () => {
    const { verify, db } = setup(async (ip) => (ip === '100.64.0.2' ? 'a@x' : 'c@x'));
    expect((await verify(serve('100.64.0.2', 'a@x'))).ok).toBe(true);
    expect(getSetting(db, 'remoteOwnerLogin', '')).toBe('a@x');
    expect(await verify(serve('100.64.0.3', 'c@x'))).toEqual({
      ok: false,
      reason: 'remote_not_owner',
    });
    setSetting(db, 'remoteOwnerLogin', '');
    expect((await verify(serve('100.64.0.3', 'c@x'))).ok).toBe(true);
    expect(getSetting(db, 'remoteOwnerLogin', '')).toBe('c@x');
  });
});

describe('tailscale whois runner', () => {
  it('parses `tailscale whois --json` from the first binary on PATH; missing fields are null', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'sy-fake-tailscale-'));
    writeFileSync(
      join(bin, 'tailscale'),
      [
        '#!/bin/sh',
        '[ "$1" = whois ] && [ "$2" = --json ] || exit 2',
        'case "$3" in',
        '  100.64.0.2) echo \'{"Node":{"Name":"phone"},"UserProfile":{"LoginName":"a@x"}}\' ;;',
        '  100.64.0.5) echo \'{"Node":{"Name":"tagged-node"}}\' ;;',
        '  *) echo "no such peer" >&2; exit 1 ;;',
        'esac',
      ].join('\n') + '\n',
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      expect(await tailscaleWhois('100.64.0.2')).toBe('a@x');
      expect(await tailscaleWhois('100.64.0.5')).toBeNull();
      await expect(tailscaleWhois('100.64.0.6')).rejects.toThrow(/no such peer/);
    } finally {
      process.env.PATH = path;
    }
  });
});
