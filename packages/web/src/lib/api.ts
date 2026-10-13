const TOKEN_KEY = 'switchyard_token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // private mode: session won't persist across reloads
  }
}

/**
 * The Mac launcher opens http://127.0.0.1:4777/#token=<token>. A URL fragment is never sent to any server;
 * we store the token, then remove it from the address bar and history entry straight away.
 */
export function consumeTokenFromHash(): boolean {
  const m = /^#token=([A-Za-z0-9_-]{16,128})$/.exec(window.location.hash);
  if (!m) return false;
  setToken(m[1]!);
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export async function login(token: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (res.status === 429)
    return { ok: false, error: 'Too many attempts. Wait a minute and try again.' };
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok: boolean };
  if (data.ok) setToken(token);
  return { ok: !!data.ok, error: data.ok ? undefined : 'That token was not accepted.' };
}

export async function checkSession(): Promise<{
  ok: boolean;
  remote?: boolean;
  readOnly?: boolean;
}> {
  const token = getToken();
  if (!token) return { ok: false };
  const res = await fetch('/api/auth/check', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { ok: false };
  return (await res.json()) as { ok: boolean; remote?: boolean; readOnly?: boolean };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) {
    clearToken();
    window.location.reload();
  }
  if (!res.ok) throw new ApiError(res.status, String(data.message ?? data.error ?? res.statusText));
  return data as T;
}

/**
 * Long-poll one JSON resource: resolves with the new body when it changes, or null on 304 (nothing changed).
 * The server holds the request up to `waitSec`, so an idle watcher costs about one request per 25 s.
 */
export async function pollChanged<T extends { hash: string }>(
  path: string,
  since: string | null,
  signal: AbortSignal,
  waitSec = 25,
): Promise<T | null> {
  const token = getToken();
  const q = `${path}${path.includes('?') ? '&' : '?'}wait=${waitSec}${since ? `&since=${since}` : ''}`;
  const res = await fetch(q, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (res.status === 304) return null;
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
