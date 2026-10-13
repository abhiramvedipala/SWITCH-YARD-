import { useState, type FormEvent } from 'react';
import { login } from '../lib/api.js';
import { Logo } from '../components/bits.js';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [token, setTokenInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await login(token.trim());
      if (r.ok) onSuccess();
      else setError(r.error ?? 'That token was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>
          <Logo size={22} /> Switchyard
        </h1>
        <p className="muted">
          Enter the token printed in your terminal when core first started (also saved to{' '}
          <code>~/.switchyard/ui-session</code>).
        </p>
        <input
          type="password"
          autoFocus
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="Paste token"
          aria-label="Session token"
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || token.length === 0}>
          {busy ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  );
}
