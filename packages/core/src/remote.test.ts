import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

// Verified remote access (Tailscale Serve): every forwarded request, HTTP or /ws upgrade, must carry a
// tailnet login that a (fake) `tailscale whois` confirms and that matches the pinned owner.
type Built = Awaited<ReturnType<typeof import('./server.js').buildServer>>;
const PORT = 4794;
let built: Built;
let wsUrl: string;
const peers: Record<string, string> = { '100.64.0.2': 'a@x', '100.64.0.3': 'c@x' };
const whois = vi.fn(async (ip: string) => peers[ip] ?? null);

beforeAll(async () => {
  process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-remote-home-'));
  const { buildServer } = await import('./server.js');
  built = await buildServer({ port: PORT, dbPath: ':memory:', quiet: true, whois });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  wsUrl = `ws://127.0.0.1:${(built.app.server.address() as { port: number }).port}/ws`;
});
afterAll(() => built.app.close());

const serve = (ip: string, login: string) => ({
  'x-forwarded-for': ip,
  'tailscale-user-login': login,
});
const get = (url: string, headers: Record<string, string> = {}) =>
  built.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${built.token}`, host: `127.0.0.1:${PORT}`, ...headers },
  });
const patchSettings = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  built.app.inject({
    method: 'PATCH',
    url: '/api/settings',
    headers: { authorization: `Bearer ${built.token}`, host: `127.0.0.1:${PORT}`, ...headers },
    payload: body,
  });

describe('verified remote requests', () => {
  it('serve: login header confirmed by whois → 200, remote and read-only; whois is cached', async () => {
    whois.mockClear();
    const r = await get('/api/auth/check', serve('100.64.0.2', 'a@x'));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ remote: true, readOnly: true });
    expect((await get('/api/settings', serve('100.64.0.2', 'a@x'))).statusCode).toBe(200);
    expect(whois).toHaveBeenCalledTimes(1);
    expect((await get('/api/settings')).json().remoteOwnerLogin).toBe('a@x');
  });

  it('local requests are untouched and never consult whois', async () => {
    whois.mockClear();
    const r = await get('/api/auth/check');
    expect(r.json()).toMatchObject({ remote: false, readOnly: false });
    expect(whois).not.toHaveBeenCalled();
  });

  it('funnel is refused', async () => {
    const r = await get('/api/auth/check', {
      ...serve('100.64.0.2', 'a@x'),
      'tailscale-funnel-request': '?1',
    });
    expect(r.statusCode).toBe(403);
  });

  it('forwarded headers without identity are refused', async () => {
    const r = await get('/api/auth/check', { 'x-forwarded-for': '100.64.0.2' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('remote_identity_required');
    expect((await get('/', { 'x-forwarded-for': '100.64.0.2' })).statusCode).toBe(403);
  });

  it('spoofed login (header says b@x, whois says a@x) is refused', async () => {
    const r = await get('/api/auth/check', serve('100.64.0.2', 'b@x'));
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('remote_identity_unverified');
  });

  it('unknown peer (whois has no user) is refused', async () => {
    const r = await get('/api/auth/check', serve('100.64.0.9', 'a@x'));
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('remote_identity_unverified');
  });

  it('a second verified login is refused until the pin is cleared from the computer', async () => {
    const r = await get('/api/auth/check', serve('100.64.0.3', 'c@x'));
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('remote_not_owner');
    // The owner's phone can't clear it (read-only blocks the PATCH; with read-only off, the
    // explicit guard does), and nobody can set it to a value directly.
    const phone = serve('100.64.0.2', 'a@x');
    expect((await patchSettings({ remoteOwnerLogin: '' }, phone)).statusCode).toBe(403);
    await patchSettings({ remoteReadOnly: false });
    expect((await patchSettings({ remoteOwnerLogin: '' }, phone)).statusCode).toBe(400);
    await patchSettings({ remoteReadOnly: true });
    expect((await patchSettings({ remoteOwnerLogin: 'c@x' })).statusCode).toBe(400);
    expect((await patchSettings({ remoteOwnerLogin: '' })).statusCode).toBe(200);
    expect((await get('/api/auth/check', serve('100.64.0.3', 'c@x'))).statusCode).toBe(200);
    expect((await get('/api/settings')).json().remoteOwnerLogin).toBe('c@x');
    await patchSettings({ remoteOwnerLogin: '' });
    await get('/api/auth/check', serve('100.64.0.2', 'a@x')); // re-pin a@x for the socket tests
  });

  it('Mac notifications are off by default and only the computer can change them', async () => {
    expect((await get('/api/settings')).json().macNotifications).toBe(false);
    const phone = serve('100.64.0.2', 'a@x');
    expect((await patchSettings({ macNotifications: true }, phone)).statusCode).toBe(403);
    await patchSettings({ remoteReadOnly: false });
    expect((await patchSettings({ macNotifications: true }, phone)).statusCode).toBe(400);
    await patchSettings({ remoteReadOnly: true });
    expect((await get('/api/settings')).json().macNotifications).toBe(false);
    // From the computer it sticks (this server never starts the notifier, so nothing is posted).
    expect((await patchSettings({ macNotifications: true })).statusCode).toBe(200);
    expect((await get('/api/settings')).json().macNotifications).toBe(true);
    await patchSettings({ macNotifications: false });
  });
});

describe('websocket upgrade', () => {
  type Outcome = { status?: number; code?: number; hello?: Record<string, unknown> };
  const connect = (headers: Record<string, string>) =>
    new Promise<Outcome>((resolve) => {
      const s = new WebSocket(wsUrl, { headers: { host: `127.0.0.1:${PORT}`, ...headers } });
      s.on('unexpected-response', (_req, res) => {
        resolve({ status: res.statusCode });
        s.terminate();
      });
      s.on('open', () => s.send(JSON.stringify({ t: 'auth', token: built.token })));
      s.on('message', (d) => {
        resolve({ hello: JSON.parse(String(d)) as Record<string, unknown> });
        s.close();
      });
      s.on('close', (code) => resolve({ code }));
      s.on('error', () => undefined);
    });
  const tsnet = { origin: 'https://mac.tail1234.ts.net' };

  it('accepts a ts.net origin only for a verified remote request', async () => {
    expect(await connect(tsnet)).toEqual({ code: 4403 });
    expect(await connect({ ...tsnet, ...serve('100.64.0.2', 'b@x') })).toEqual({ status: 403 });
    expect(await connect({ ...tsnet, 'x-forwarded-for': '100.64.0.2' })).toEqual({ status: 403 });
    const ok = await connect({ ...tsnet, ...serve('100.64.0.2', 'a@x') });
    expect(ok.hello).toMatchObject({ t: 'hello', remote: true, readOnly: true });
  });

  it('loopback origins are unchanged', async () => {
    const ok = await connect({ origin: `http://127.0.0.1:${PORT}` });
    expect(ok.hello).toMatchObject({ t: 'hello', remote: false });
    expect(await connect({ origin: 'https://evil.example' })).toEqual({ code: 4403 });
  });
});
