import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SWITCHYARD_HOME } from '../paths.js';
import { randomId } from '../auth/token.js';
import type { Db } from '../db/index.js';
import type {
  Detection,
  Harness,
  HarnessId,
  NormalizedEvent,
  TurnOptions,
  TurnResult,
} from './types.js';

/**
 * Chat-only participants backed by a provider's HTTP API and the owner's own key (DECISIONS 2026-10-14: the one
 * opt-in exception to "no outbound calls"). No tools, no files: each turn sends the conversation so far and streams
 * text back. Only the hard-coded official host is contacted.
 */
export type Provider = 'anthropic' | 'openai' | 'gemini';
export const PROVIDERS = ['anthropic', 'openai', 'gemini'] as const;

/**
 * Model IDs from each provider's model docs on 2026-10-14; the first is the default ("start with" pick), the rest
 * are suggestions. A chat node can override it with data.model.
 */
export const API_MODELS: Record<Provider, string[]> = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'],
  gemini: ['gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.5-flash-lite'],
};

const OFFICIAL_BASE: Record<Provider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// ------------------------------------------------------------------ keys
export const KEYS_DIR = join(SWITCHYARD_HOME, 'keys');
const keyFile = (p: Provider) => join(KEYS_DIR, p);
/** Printable ASCII, no spaces: what every provider's keys look like, and safe to put in a header. */
const KEY_RE = /^[\x21-\x7e]{8,512}$/;

export function readKey(p: Provider): string | null {
  try {
    return readFileSync(keyFile(p), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Replaces the key file: dir 0700, file 0600, created fresh so an old file's mode never carries over. */
export function writeKey(p: Provider, key: string): void {
  const k = key.trim();
  if (!KEY_RE.test(k))
    throw new Error('That does not look like an API key (8-512 printable characters, no spaces).');
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  chmodSync(KEYS_DIR, 0o700);
  rmSync(keyFile(p), { force: true });
  writeFileSync(keyFile(p), k, { mode: 0o600, flag: 'wx' });
}

export function removeKey(p: Provider): void {
  rmSync(keyFile(p), { force: true });
}

/** All the UI ever learns about a key. */
export function keyStatus(p: Provider): { configured: boolean; last4: string | null } {
  const k = readKey(p);
  return { configured: !!k, last4: k ? k.slice(-4) : null };
}

// ------------------------------------------------------------------ base URL guard
/** The official host, or (tests only) SWITCHYARD_API_BASE_<PROVIDER> when it points at 127.0.0.1. */
export function apiBase(p: Provider): string {
  const name = `SWITCHYARD_API_BASE_${p.toUpperCase()}`;
  const raw = process.env[name];
  if (!raw) return OFFICIAL_BASE[p];
  let u: URL | null = null;
  try {
    u = new URL(raw);
  } catch {
    // refused below
  }
  if (!u || u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password)
    throw new Error(
      `${name} is a test-only override and must be http://127.0.0.1:<port>; refusing.`,
    );
  return u.origin;
}

// ------------------------------------------------------------------ history (the APIs are stateless)
interface Turn {
  role: 'user' | 'assistant';
  text: string;
}
const MAX_TURNS = 100;
const MAX_CHARS = 400_000;
const MAX_SESSIONS = 200;

// ponytail: one core per process, so one bound db; createCore binds it.
let historyDb: Db | null = null;
export function bindApiHistory(db: Db): void {
  historyDb = db;
}

/** Keep the newest 100 turns and ~400k chars, dropping oldest user/assistant pairs; the latest pair always stays. */
export function trimHistory(turns: Turn[]): Turn[] {
  let t = turns.slice(-MAX_TURNS);
  let size = t.reduce((n, m) => n + m.text.length, 0);
  while (t.length > 2 && size > MAX_CHARS) {
    size -= t[0]!.text.length + t[1]!.text.length;
    t = t.slice(2);
  }
  while (t[0]?.role === 'assistant') t = t.slice(1);
  return t;
}

function loadHistory(db: Db, ref: string): Turn[] {
  const row = db.prepare('SELECT messages_json FROM api_history WHERE session_ref = ?').get(ref) as
    { messages_json: string } | undefined;
  return row ? (JSON.parse(row.messages_json) as Turn[]) : [];
}

function saveHistory(db: Db, ref: string, turns: Turn[]): void {
  db.prepare(
    `INSERT INTO api_history (session_ref, messages_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(session_ref) DO UPDATE SET messages_json = excluded.messages_json, updated_at = excluded.updated_at`,
  ).run(ref, JSON.stringify(trimHistory(turns)), Date.now());
  // Sessions of deleted/cleared nodes are never read again; keep only the newest 200.
  db.prepare(
    'DELETE FROM api_history WHERE session_ref NOT IN (SELECT session_ref FROM api_history ORDER BY updated_at DESC LIMIT ?)',
  ).run(MAX_SESSIONS);
}

export function dropApiHistory(db: Db, ref: string | null): void {
  if (ref) db.prepare('DELETE FROM api_history WHERE session_ref = ?').run(ref);
}

// ------------------------------------------------------------------ SSE
/** Minimal server-sent-events reader: `event:` and `data:` fields, a blank line dispatches. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const dec = new TextDecoder();
  let buf = '';
  let event = '';
  let data: string[] = [];
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        if (data.length) yield { event: event || 'message', data: data.join('\n') };
        event = '';
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
  }
  if (data.length) yield { event: event || 'message', data: data.join('\n') };
}

// ------------------------------------------------------------------ providers
// Loosely typed provider payloads: they grow new fields over time and we read a few by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
interface Parsed {
  delta?: string;
  input?: number;
  output?: number;
  error?: string;
}
interface Impl {
  label: string;
  vendor: string;
  request(
    base: string,
    model: string,
    key: string,
    system: string | undefined,
    turns: Turn[],
  ): { url: string; headers: Record<string, string>; body: unknown };
  parse(d: J): Parsed;
}

const IMPL: Record<Provider, Impl> = {
  // Messages API: https://platform.claude.com/docs/en/build-with-claude/streaming
  anthropic: {
    label: 'Claude API',
    vendor: 'Anthropic',
    request: (base, model, key, system, turns) => ({
      url: `${base}/v1/messages`,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: {
        model,
        max_tokens: 16_000,
        stream: true,
        ...(system ? { system } : {}),
        messages: turns.map((t) => ({ role: t.role, content: t.text })),
      },
    }),
    parse: (d) => {
      if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta')
        return { delta: d.delta.text };
      if (d.type === 'message_start')
        return { input: d.message?.usage?.input_tokens, output: d.message?.usage?.output_tokens };
      // message_delta usage is cumulative.
      if (d.type === 'message_delta')
        return { input: d.usage?.input_tokens, output: d.usage?.output_tokens };
      if (d.type === 'error') return { error: d.error?.message ?? 'stream error' };
      return {};
    },
  },
  // Responses API (OpenAI's recommended API; store:false so nothing is kept server side, we send history ourselves).
  openai: {
    label: 'OpenAI API',
    vendor: 'OpenAI',
    request: (base, model, key, system, turns) => ({
      url: `${base}/v1/responses`,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: {
        model,
        stream: true,
        store: false,
        ...(system ? { instructions: system } : {}),
        input: turns.map((t) => ({ role: t.role, content: t.text })),
      },
    }),
    parse: (d) => {
      if (d.type === 'response.output_text.delta') return { delta: d.delta };
      if (d.type === 'response.completed' || d.type === 'response.incomplete')
        return {
          input: d.response?.usage?.input_tokens,
          output: d.response?.usage?.output_tokens,
        };
      if (d.type === 'response.failed')
        return { error: d.response?.error?.message ?? 'response failed' };
      if (d.type === 'error') return { error: d.message ?? 'stream error' };
      return {};
    },
  },
  // Gemini API models.streamGenerateContent with alt=sse; the key goes in a header, never the URL.
  gemini: {
    label: 'Gemini API',
    vendor: 'Google',
    request: (base, model, key, system, turns) => ({
      url: `${base}/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: turns.map((t) => ({
          role: t.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: t.text }],
        })),
      },
    }),
    parse: (d) => {
      if (d.error) return { error: d.error.message ?? 'stream error' };
      if (d.promptFeedback?.blockReason)
        return { error: `the prompt was blocked (${d.promptFeedback.blockReason})` };
      const parts: J[] = d.candidates?.[0]?.content?.parts ?? [];
      const delta = parts
        .filter((x) => !x.thought && typeof x.text === 'string')
        .map((x) => x.text)
        .join('');
      const u = d.usageMetadata;
      return {
        delta: delta || undefined,
        input: u?.promptTokenCount,
        output: u ? (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) : undefined,
      };
    },
  },
};

function httpError(impl: Impl, status: number, body: string): string {
  let msg = body.slice(0, 300);
  try {
    const j = JSON.parse(body) as J;
    msg = String(j.error?.message ?? j.message ?? msg);
  } catch {
    // not JSON
  }
  if (status === 401 || /API key not valid/i.test(msg))
    return `${impl.label} rejected the API key (${status}). Check or replace it in Settings → API keys.`;
  if (status === 429)
    return `${impl.label} rate limit or quota reached (429). Wait a moment and try again.${msg ? ` ${msg}` : ''}`;
  return `${impl.label} error ${status}${msg ? `: ${msg}` : ''}`;
}

export async function apiTurn(p: Provider, opts: TurnOptions): Promise<TurnResult> {
  const impl = IMPL[p];
  const emit = (e: NormalizedEvent) => opts.onEvent?.(e);
  const sessionId = opts.sessionId || randomId(9);
  const usage = { input_tokens: 0, output_tokens: 0 };
  let text = '';
  let error: string | undefined;
  let key: string | null = null;
  let timedOut = false;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (opts.signal?.aborted) ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  emit({ kind: 'status', state: 'working' });
  try {
    const db = historyDb;
    if (!db) throw new Error('conversation store is not open');
    key = readKey(p);
    if (!key) throw new Error(`No ${impl.vendor} API key yet. Add one in Settings → API keys.`);
    const model = opts.model?.trim() || API_MODELS[p][0]!;
    if (!MODEL_RE.test(model)) throw new Error(`"${model.slice(0, 100)}" is not a valid model id`);
    const base = apiBase(p);
    const turns: Turn[] = [...loadHistory(db, sessionId), { role: 'user', text: opts.prompt }];
    const req = impl.request(base, model, key, opts.appendSystemPrompt, turns);
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: ctrl.signal,
        redirect: 'error', // never follow a redirect off the official host
      });
    } catch (err) {
      if (ctrl.signal.aborted) throw err;
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(
        `Could not reach ${new URL(base).host} (${cause?.code ?? cause?.message ?? String(err)}). Check the internet connection.`,
      );
    }
    if (!res.ok || !res.body)
      throw new Error(httpError(impl, res.status, await res.text().catch(() => '')));
    for await (const ev of readSse(res.body)) {
      let d: J;
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const out = impl.parse(d);
      if (out.error) throw new Error(`${impl.label}: ${out.error}`);
      if (out.delta) {
        text += out.delta;
        emit({ kind: 'text', delta: out.delta });
      }
      if (typeof out.input === 'number') usage.input_tokens = out.input;
      if (typeof out.output === 'number') usage.output_tokens = out.output;
    }
    saveHistory(db, sessionId, [...turns, { role: 'assistant', text }]);
  } catch (err) {
    error = ctrl.signal.aborted
      ? timedOut
        ? 'timed out'
        : 'stopped'
      : String((err as Error).message ?? err);
    // Some providers echo part of a rejected key; never let it reach the transcript or a log.
    if (key) error = error.split(key).join('[key]');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  if (error) emit({ kind: 'error', message: error });
  emit({ kind: 'result', text, sessionId, usage });
  emit({ kind: 'status', state: 'idle' });
  return { ok: !error, text, sessionId, usage, error };
}

function apiHarness(p: Provider): Harness {
  const impl = IMPL[p];
  return {
    id: `api-${p}` as HarnessId,
    label: impl.label,
    isAgent: false,
    async detect(): Promise<Detection> {
      const installed = readKey(p) !== null;
      return {
        installed,
        models: API_MODELS[p],
        notes: [
          `Uses your ${impl.vendor} API key, billed per token.`,
          'Chat only: no tools, no file access.',
        ],
        installHint: installed ? undefined : 'Add a key in Settings → API keys.',
      };
    },
    terminalLaunch() {
      throw new Error(`${impl.label} is chat-only: add it as a chat node, not a terminal.`);
    },
    runTurn: (opts) => apiTurn(p, opts),
  };
}

export const apiAnthropic = apiHarness('anthropic');
export const apiOpenai = apiHarness('openai');
export const apiGemini = apiHarness('gemini');
