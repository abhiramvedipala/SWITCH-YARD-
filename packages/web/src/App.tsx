import { useEffect, useState } from 'react';
import { checkSession } from './lib/api.js';
import { Login } from './pages/Login.js';
import { Shell } from './pages/Shell.js';
import { useStore } from './store.js';

type AuthState = 'checking' | 'authed' | 'anon';

export function App() {
  const [auth, setAuth] = useState<AuthState>('checking');

  useEffect(() => {
    checkSession()
      .then((r) => {
        if (r.ok) useStore.getState().set({ remote: !!r.remote, readOnly: !!r.readOnly });
        setAuth(r.ok ? 'authed' : 'anon');
      })
      .catch(() => setAuth('anon'));
  }, []);

  if (auth === 'checking') return <div className="loading-screen">Loading…</div>;
  if (auth === 'anon')
    return (
      <Login
        onSuccess={() =>
          checkSession().then((r) => {
            useStore.getState().set({ remote: !!r.remote, readOnly: !!r.readOnly });
            setAuth('authed');
          })
        }
      />
    );
  return <Shell />;
}
