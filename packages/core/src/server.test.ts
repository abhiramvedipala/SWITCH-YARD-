import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { originAllowed } from './ws.js';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;

describe('websocket origin check', () => {
  it('allows same-origin, loopback and tailnet origins', () => {
    expect(originAllowed(req({ host: '127.0.0.1:4777', origin: 'http://127.0.0.1:4777' }))).toBe(
      true,
    );
    expect(
      originAllowed(req({ host: '127.0.0.1:4777', origin: 'https://mac.tail1234.ts.net' })),
    ).toBe(true);
    expect(originAllowed(req({ host: '127.0.0.1:4777' }))).toBe(true);
  });
  it('rejects other sites', () => {
    expect(originAllowed(req({ host: '127.0.0.1:4777', origin: 'https://evil.example' }))).toBe(
      false,
    );
    expect(
      originAllowed(req({ host: '127.0.0.1:4777', origin: 'https://ts.net.evil.example' })),
    ).toBe(false);
    expect(originAllowed(req({ host: '127.0.0.1:4777', origin: 'not a url' }))).toBe(false);
  });
});

describe('remote detection', async () => {
  const { isRemoteRequest } = await import('./server.js');
  it('loopback is local; forwarded or non-loopback hosts are remote', () => {
    expect(isRemoteRequest(req({ host: '127.0.0.1:4777' }), 4777)).toBe(false);
    expect(isRemoteRequest(req({ host: 'localhost:4777' }), 4777)).toBe(false);
    expect(
      isRemoteRequest(req({ host: '127.0.0.1:4777', 'x-forwarded-for': '100.64.0.2' }), 4777),
    ).toBe(true);
    expect(isRemoteRequest(req({ host: 'mac.tail1234.ts.net' }), 4777)).toBe(true);
  });
});

describe('funnel detection', async () => {
  const { isFunnelRequest } = await import('./server.js');
  it('flags Tailscale Funnel requests only', () => {
    expect(isFunnelRequest(req({ host: 'x.ts.net', 'tailscale-funnel-request': '?1' }))).toBe(true);
    expect(isFunnelRequest(req({ host: 'x.ts.net', 'tailscale-user-login': 'a@b.c' }))).toBe(false);
  });
});
