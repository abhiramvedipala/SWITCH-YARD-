import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { NormalizedEvent } from './types.js';

// API-key chat harnesses against a local fake of each provider (127.0.0.1 only; no real network).
// SSE bodies follow the documented streams; see the URLs in harness/api.ts.
process.env.SWITCHYARD_HOME = mkdtempSync(join(tmpdir(), 'sy-api-home-'));
type Built = Awaited<ReturnType<typeof import('../server.js').buildServer>>;
type ApiMod = typeof import('./api.js');
const PORT = 4796;
const KEYS = {
  anthropic: 'sk-ant-TESTKEY-anthropic-0001',
  openai: 'sk-proj-TESTKEY-openai-0002',
  gemini: 'AIzaTESTKEY-gemini-0003',
} as const;
type P = keyof typeof KEYS;

let built: Built;
let api: ApiMod;
let fakeBase: string;
const seen: { url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }[] =
  [];
let handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    seen.push({ url: req.url ?? '', headers: req.headers, body });
    handler(req, res, body);
  });
});

// Everything printed while the tests run, to prove no key is ever logged.
const printed: string[] = [];
const responses: string[] = [];

const sse = (res: ServerResponse, chunks: string[], hold = false) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  // Write in small pieces that split lines mid-way, like a real network does.
  for (const c of chunks) for (let i = 0; i < c.length; i += 37) res.write(c.slice(i, i + 37));
  if (!hold) res.end();
};

const STREAMS: Record<P, (reply: string) => string[]> = {
  // platform.claude.com streaming doc, "Basic streaming request" response.
  anthropic: (reply) => [
    'event: message_start\ndata: {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "content": [], "model": "claude-opus-5-5", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 25, "output_tokens": 1}}}\n\n',
    'event: content_block_start\ndata: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}\n\n',
    'event: ping\ndata: {"type": "ping"}\n\n',
    ...reply
      .split(/(?<= )/)
      .map(
        (t) =>
          `event: content_block_delta\r\ndata: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": ${JSON.stringify(t)}}}\r\n\r\n`,
      ),
    'event: content_block_stop\ndata: {"type": "content_block_stop", "index": 0}\n\n',
    'event: message_delta\ndata: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence":null}, "usage": {"output_tokens": 15}}\n\n',
    'event: message_stop\ndata: {"type": "message_stop"}\n\n',
  ],
  // Responses API streaming: response.created, response.output_text.delta (delta), response.completed (usage).
  openai: (reply) => [
    'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","status":"in_progress"}}\n\n',
    ...reply
      .split(/(?<= )/)
      .map(
        (t, i) =>
          `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":${JSON.stringify(t)},"sequence_number":${i + 1}}\n\n`,
      ),
    'event: response.completed\ndata: {"type":"response.completed","sequence_number":99,"response":{"id":"resp_1","status":"completed","usage":{"input_tokens":25,"input_tokens_details":{"cached_tokens":0},"output_tokens":15,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":40}}}\n\n',
  ],
  // streamGenerateContent?alt=sse: data-only GenerateContentResponse chunks, usageMetadata on each.
  gemini: (reply) => [
    'data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true}],"role":"model"}}]}\n\n',
    ...reply
      .split(/(?<= )/)
      .map(
        (t) =>
          `data: {"candidates":[{"content":{"parts":[{"text":${JSON.stringify(t)}}],"role":"model"},"index":0}],"usageMetadata":{"promptTokenCount":25,"candidatesTokenCount":10,"thoughtsTokenCount":5,"totalTokenCount":40},"modelVersion":"gemini-3.8-flash"}\n\n`,
      ),
  ],
};

const local = { authorization: '', host: `127.0.0.1:${PORT}` };
const call = async (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: object) => {
  const r = await built.app.inject({ method, url, headers: local, payload });
  responses.push(r.body);
  return r;
};

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  for (const p of Object.keys(KEYS))
    process.env[`SWITCHYARD_API_BASE_${p.toUpperCase()}`] = fakeBase;
  for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a.join(' ')));
  const { buildServer } = await import('../server.js');
  api = await import('./api.js');
  // GET /api/harnesses re-probes every harness; never let that spawn a real CLI here.
  const { harnesses } = await import('./index.js');
  for (const [id, h] of Object.entries(harnesses))
    if (!id.startsWith('api-'))
      vi.spyOn(h, 'detect').mockResolvedValue({ installed: id === 'mock' });
  const whois = async () => 'owner@x';
  built = await buildServer({ port: PORT, dbPath: ':memory:', quiet: true, whois });
  local.authorization = `Bearer ${built.token}`;
});
afterAll(async () => {
  await built.app.close();
  fake.close();
  vi.restoreAllMocks();
});
beforeEach(() => {
  seen.length = 0;
  for (const p of Object.keys(KEYS))
    process.env[`SWITCHYARD_API_BASE_${p.toUpperCase()}`] = fakeBase;
});

describe('API keys (Settings)', () => {
  it('saves each key as a 0600 file in a 0700 dir and only ever returns configured + last4', async () => {
    for (const p of Object.keys(KEYS) as P[]) {
      const r = await call('POST', `/api/keys/${p}`, { key: `  ${KEYS[p]}\n` });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ configured: true, last4: KEYS[p].slice(-4) });
      expect(statSync(join(api.KEYS_DIR, p)).mode & 0o777).toBe(0o600);
    }
    expect(statSync(api.KEYS_DIR).mode & 0o777).toBe(0o700);
    const all = (await call('GET', '/api/keys')).json();
    expect(all.openai).toEqual({ configured: true, last4: '0002' });
    const h = (await call('GET', '/api/harnesses?refresh=1')).json();
    expect(h.detections['api-gemini'].installed).toBe(true);
    expect(h.detections['api-gemini'].notes[0]).toMatch(/billed per token/);
    expect(h.available).not.toContain('api-gemini'); // runs need file-editing agents
  });

  it('rejects junk keys and unknown providers without echoing the input', async () => {
    const bad = await call('POST', '/api/keys/anthropic', { key: 'has spaces in it' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('has spaces');
    expect((await call('POST', '/api/keys/mistral', { key: 'abcdefgh123' })).statusCode).toBe(400);
  });

  it('Remove deletes the file and the harness reads as not installed', async () => {
    await call('POST', '/api/keys/openai', { key: 'sk-temp-remove-me' });
    const r = await call('DELETE', '/api/keys/openai');
    expect(r.json()).toEqual({ configured: false, last4: null });
    expect(existsSync(join(api.KEYS_DIR, 'openai'))).toBe(false);
    expect((await call('GET', '/api/harnesses')).json().detections['api-openai'].installed).toBe(
      false,
    );
    await call('POST', '/api/keys/openai', { key: KEYS.openai });
  });

  it('a remote (phone) session can neither read nor set keys, even with read-only off', async () => {
    const remote = {
      ...local,
      'x-forwarded-for': '100.64.0.9',
      'tailscale-user-login': 'owner@x',
    };
    const asRemote = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
      built.app.inject({ method, url, headers: remote, payload });
    expect(
      (await asRemote('POST', '/api/keys/anthropic', { key: 'sk-phone-123456' })).statusCode,
    ).toBe(403);
    await call('PATCH', '/api/settings', { remoteReadOnly: false });
    try {
      const set = await asRemote('POST', '/api/keys/anthropic', { key: 'sk-phone-123456' });
      expect(set.statusCode).toBe(403);
      expect(set.json().error).toBe('local_only');
      expect((await asRemote('DELETE', '/api/keys/anthropic')).statusCode).toBe(403);
      expect((await asRemote('GET', '/api/keys')).statusCode).toBe(403);
      expect(api.readKey('anthropic')).toBe(KEYS.anthropic);
    } finally {
      await call('PATCH', '/api/settings', { remoteReadOnly: true });
    }
  });
});

describe.each(Object.keys(KEYS) as P[])('%s harness', (p) => {
  const turn = async (prompt: string, sessionId: string | null, extra: object = {}) => {
    const events: NormalizedEvent[] = [];
    const res = await api.apiTurn(p, {
      prompt,
      cwd: tmpdir(),
      sessionId,
      appendSystemPrompt: 'Be brief.',
      onEvent: (e) => events.push(e),
      ...extra,
    });
    return { res, events };
  };

  it('streams text deltas, reports usage, and sends the prior turns on the 2nd turn', async () => {
    handler = (_req, res) => sse(res, STREAMS[p]('Hello there friend'));
    const one = await turn('Hi', null);
    expect(one.res).toMatchObject({ ok: true, text: 'Hello there friend' });
    expect(one.events.filter((e) => e.kind === 'text').length).toBeGreaterThan(1);
    expect(one.events.at(-2)).toMatchObject({ kind: 'result', text: 'Hello there friend' });
    expect(one.res.usage).toEqual({ input_tokens: 25, output_tokens: 15 });
    const sid = one.res.sessionId!;
    expect(sid).toBeTruthy();

    const r1 = seen[0]!;
    if (p === 'anthropic') {
      expect(r1.url).toBe('/v1/messages');
      expect(r1.headers['x-api-key']).toBe(KEYS.anthropic);
      expect(r1.headers['anthropic-version']).toBe('2023-06-01');
      expect(r1.body).toMatchObject({
        model: 'claude-opus-5-5',
        stream: true,
        system: 'Be brief.',
      });
    } else if (p === 'openai') {
      expect(r1.url).toBe('/v1/responses');
      expect(r1.headers.authorization).toBe(`Bearer ${KEYS.openai}`);
      expect(r1.body).toMatchObject({ model: 'gpt-6-astra', stream: true, store: false });
      expect(r1.body.instructions).toBe('Be brief.');
    } else {
      expect(r1.url).toBe('/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
      expect(r1.headers['x-goog-api-key']).toBe(KEYS.gemini);
      expect(r1.url).not.toContain('key=');
    }

    handler = (_req, res) => sse(res, STREAMS[p]('Second answer'));
    const two = await turn('And again?', sid, { model: 'custom-model-1' });
    expect(two.res).toMatchObject({ ok: true, text: 'Second answer', sessionId: sid });
    const b = seen[1]!.body;
    const history =
      p === 'anthropic'
        ? (b.messages as { role: string; content: string }[]).map((m) => [m.role, m.content])
        : p === 'openai'
          ? (b.input as { role: string; content: string }[]).map((m) => [m.role, m.content])
          : (b.contents as { role: string; parts: { text: string }[] }[]).map((m) => [
              m.role,
              m.parts[0]!.text,
            ]);
    const asst = p === 'gemini' ? 'model' : 'assistant';
    expect(history).toEqual([
      ['user', 'Hi'],
      [asst, 'Hello there friend'],
      ['user', 'And again?'],
    ]);
    if (p === 'gemini') expect(seen[1]!.url).toContain('/models/custom-model-1:');
    else expect(b.model).toBe('custom-model-1');
  });

  it('maps 401 to a clear bad-key message (scrubbing any echoed key) and 429 to rate limit', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEYS[p]}` } }));
    };
    const bad = await turn('Hi', null);
    expect(bad.res.ok).toBe(false);
    expect(bad.res.error).toMatch(/rejected the API key \(401\).*Settings → API keys/);
    expect(bad.events).toContainEqual({ kind: 'error', message: bad.res.error });

    handler = (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `slow down ${KEYS[p]}` } }));
    };
    const slow = await turn('Hi', null);
    expect(slow.res.error).toMatch(/rate limit or quota reached \(429\)/);
    expect(slow.res.error).toContain('[key]');
    expect(slow.res.error).not.toContain(KEYS[p]);
  });

  it('honours abort mid-stream and keeps no history for the stopped turn', async () => {
    const ctrl = new AbortController();
    handler = (_req, res) => {
      sse(res, STREAMS[p]('partial ').slice(0, 2), true);
      setTimeout(() => ctrl.abort(), 50);
    };
    const r = await turn('Hi', 'abort-session', { signal: ctrl.signal });
    expect(r.res).toMatchObject({ ok: false, error: 'stopped' });
    handler = (_req, res) => sse(res, STREAMS[p]('fresh'));
    await turn('Again', 'abort-session');
    const msgs = JSON.stringify(seen.at(-1)!.body);
    expect(msgs).not.toContain('"Hi"');
  });

  it('times out a stalled stream', async () => {
    handler = (_req, res) => sse(res, [], true);
    const r = await turn('Hi', null, { timeoutMs: 150 });
    expect(r.res.error).toBe('timed out');
  });
});

describe('outbound guard', () => {
  it('refuses any base-URL override that is not http://127.0.0.1 and contacts nothing', async () => {
    for (const bad of [
      'https://api.evil.example',
      'http://127.0.0.1.evil.example:9',
      'http://localhost:9',
      'http://127.0.0.1@evil.example',
      'file:///etc/passwd',
      'not a url',
    ]) {
      process.env.SWITCHYARD_API_BASE_ANTHROPIC = bad;
      const r = await api.apiTurn('anthropic', { prompt: 'Hi', cwd: tmpdir() });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/test-only override.*127\.0\.0\.1.*refusing/);
    }
    expect(seen).toHaveLength(0);
    delete process.env.SWITCHYARD_API_BASE_OPENAI;
    expect(api.apiBase('openai')).toBe('https://api.openai.com');
    expect(api.apiBase('gemini')).toBe(fakeBase);
  });

  it('reports a network failure clearly and rejects a malformed model id', async () => {
    process.env.SWITCHYARD_API_BASE_OPENAI = 'http://127.0.0.1:9'; // nothing listens there
    const r = await api.apiTurn('openai', { prompt: 'Hi', cwd: tmpdir() });
    expect(r.error).toMatch(/Could not reach 127\.0\.0\.1:9/);
    const m = await api.apiTurn('gemini', { prompt: 'Hi', cwd: tmpdir(), model: '../../x' });
    expect(m.error).toMatch(/not a valid model id/);
    expect(seen).toHaveLength(0);
  });

  it('is chat-only: no terminal launch, and agent-terminal nodes refuse API harnesses', async () => {
    const { harnesses } = await import('./index.js');
    expect(harnesses['api-anthropic'].isAgent).toBe(false);
    expect(() => harnesses['api-openai'].terminalLaunch({} as never)).toThrow(/chat-only/);
    const ws = built.core.store.createWorkspace('t', tmpdir());
    const term = await call('POST', `/api/workspaces/${ws.id}/nodes`, {
      type: 'agent-terminal',
      harness: 'api-anthropic',
    });
    expect(term.statusCode).toBe(400);
  });
});

describe('chat node backed by an API harness', () => {
  it('drives turns with the node model override, records usage, and Clear drops the history', async () => {
    const ws = built.core.store.createWorkspace('chat', tmpdir());
    const created = await call('POST', `/api/workspaces/${ws.id}/nodes`, {
      type: 'agent-chat',
      harness: 'api-anthropic',
      data: { model: 'claude-sonnet-5-5' },
    });
    expect(created.statusCode).toBe(200);
    const node = created.json();
    expect(node.title).toBe('Claude API 1');
    handler = (_req, res) => sse(res, STREAMS.anthropic('Hi from the API'));
    const sent = await built.core.chat.send(node.id, 'Hello');
    expect(sent.ok).toBe(true);
    expect(seen[0]!.body.model).toBe('claude-sonnet-5-5');
    expect(seen[0]!.body.system).toBeUndefined(); // no bus-tools blurb for a chat-only model
    const after = built.core.store.getNode(node.id)!;
    expect((after.data.messages as { text: string }[]).at(-1)!.text).toBe('Hi from the API');
    const usage = (await call('GET', `/api/usage?nodeId=${node.id}`)).json();
    expect(usage.total).toMatchObject({ turns: 1, inputTokens: 25, outputTokens: 15 });
    const ref = after.sessionRef!;
    const count = () =>
      built.core.db.prepare('SELECT COUNT(*) n FROM api_history WHERE session_ref=?').get(ref) as {
        n: number;
      };
    expect(count().n).toBe(1);
    built.core.chat.clear(node.id);
    expect(count().n).toBe(0);
  });
});

describe('history cap', () => {
  it('keeps the newest 100 turns, then drops oldest pairs past ~400k chars, never starting on a reply', () => {
    const pairs = (n: number, len = 1) =>
      Array.from({ length: n }, (_, i) => [
        { role: 'user' as const, text: `u${i}`.padEnd(len, '.') },
        { role: 'assistant' as const, text: `a${i}`.padEnd(len, '.') },
      ]).flat();
    const t = api.trimHistory(pairs(80));
    expect(t).toHaveLength(100);
    expect(t[0]).toEqual({ role: 'user', text: 'u30' });
    const big = api.trimHistory(pairs(10, 50_000));
    expect(big).toHaveLength(8);
    expect(big[0]!.role).toBe('user');
    const huge = api.trimHistory(pairs(1, 900_000));
    expect(huge).toHaveLength(2); // the latest exchange always stays
  });
});

describe('secrets', () => {
  it('no key appears in any API response or anything printed during these tests', () => {
    const all = [...printed, ...responses].join('\n');
    for (const k of Object.values(KEYS)) expect(all).not.toContain(k);
    for (const k of Object.values(KEYS)) expect(JSON.stringify(process.env)).not.toContain(k);
  });
});
