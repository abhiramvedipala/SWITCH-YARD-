import { useEffect, useState } from 'react';
import { checkSession } from './lib/api.js';
import { Login } from './pages/Login.js';
import { Canvas } from './pages/Canvas.js';

type AuthState = 'checking' | 'authed' | 'anon';

export function App() {
  const [auth, setAuth] = useState<AuthState>('checking');

  useEffect(() => {
    checkSession().then((ok) => setAuth(ok ? 'authed' : 'anon'));
  }, []);

  if (auth === 'checking') return <div className="loading-screen">Loading…</div>;
  if (auth === 'anon') return <Login onSuccess={() => setAuth('authed')} />;
  return <Canvas />;
}
