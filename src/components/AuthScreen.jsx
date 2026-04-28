import React, { useState } from 'react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Field, Logo } from './ui.jsx';

export function AuthScreen() {
  const { actions, showMsg } = useStore();
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    if (!email.trim() || !password.trim() || (mode === 'signup' && !name.trim())) {
      setError('All fields required');
      return;
    }
    if (!email.includes('@')) {
      setError('Enter a valid email');
      return;
    }
    setBusy(true);
    try {
      const e = email.toLowerCase().trim();
      if (mode === 'signup') {
        const { token, user } = await api.post('/api/auth/signup', { email: e, name: name.trim(), password });
        actions.signup(user, token);
        showMsg('Welcome, ' + user.name);
      } else {
        const { token, user } = await api.post('/api/auth/login', { email: e, password });
        actions.login(user, token);
        showMsg('Welcome back, ' + user.name);
      }
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 400, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <Logo size={40} />
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Squideo Proposals</div>
            <div style={{ fontSize: 12, color: BRAND.muted }}>
              {mode === 'login' ? 'Sign in to your account' : 'Create an account'}
            </div>
          </div>
        </div>

        {mode === 'signup' && (
          <Field label="Full name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Adam Shelton" />
          </Field>
        )}
        <Field label="Email">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@squideo.com" />
        </Field>
        <Field label="Password">
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        </Field>

        {error && (
          <div style={{ background: '#FEE2E2', color: '#991B1B', fontSize: 13, padding: '10px 12px', borderRadius: 6, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <button onClick={submit} disabled={busy} className="btn" style={{ width: '100%', justifyContent: 'center', padding: 12 }}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 13, color: BRAND.muted }}>
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button
            onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); }}
            className="btn-link"
          >
            {mode === 'login' ? 'Sign up' : 'Sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}
