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
    // localStorage unavailable (private mode etc.) — session just won't persist across reloads
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export async function login(token: string): Promise<boolean> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { ok: boolean };
  if (data.ok) setToken(token);
  return data.ok;
}

export async function checkSession(): Promise<boolean> {
  const token = getToken();
  if (!token) return false;
  const res = await fetch('/api/auth/check', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

/** fetch() wrapper that attaches the stored bearer token to every /api/ call. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}
