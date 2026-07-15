import React, { useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal, rememberedLogoUrl } from '../PortalContext.jsx';
import AuthShell, { AuthField, AuthError, AuthInfo } from './AuthShell.jsx';

export default function Login({ initialError = null }) {
  const { refreshSession } = usePortal();
  const [logoUrl] = useState(rememberedLogoUrl);
  const [mode, setMode] = useState('password'); // 'password' | 'magic' | 'forgot'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [info, setInfo] = useState(null);

  const submitPassword = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    try {
      await portalApi.post('auth?op=login', { email, password });
      await refreshSession();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitMagic = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await portalApi.post('auth?op=magic-request', { email });
      setInfo(r.message || 'If that email has a portal account, a sign-in link is on its way.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitForgot = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await portalApi.post('auth?op=reset-request', { email });
      setInfo(r.message || 'If that email has a portal account, a reset link is on its way.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const tabStyle = (active) => ({
    flex: 1, padding: '9px 0', border: 'none', cursor: 'pointer',
    borderRadius: 8, fontSize: 13, fontWeight: 700,
    background: active ? BRAND.ink : 'transparent',
    color: active ? '#fff' : BRAND.muted,
  });

  return (
    <AuthShell logoUrl={logoUrl}>
      <h1 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 800, color: BRAND.ink }}>Welcome back</h1>
      <p style={{ margin: '0 0 18px', fontSize: 13.5, color: BRAND.muted, lineHeight: 1.5 }}>
        Track your projects, review drafts and download your videos.
      </p>

      {mode !== 'forgot' && (
        <div style={{ display: 'flex', gap: 4, background: '#F1F4F7', borderRadius: 10, padding: 4, marginBottom: 18 }}>
          <button type="button" style={tabStyle(mode === 'password')} onClick={() => { setMode('password'); setInfo(null); setError(null); }}>
            Password
          </button>
          <button type="button" style={tabStyle(mode === 'magic')} onClick={() => { setMode('magic'); setInfo(null); setError(null); }}>
            Email me a link
          </button>
        </div>
      )}

      <AuthError>{error}</AuthError>
      <AuthInfo>{info}</AuthInfo>

      {mode === 'password' && (
        <form onSubmit={submitPassword}>
          <AuthField label="Email">
            <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%' }} />
          </AuthField>
          <AuthField label="Password">
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} />
          </AuthField>
          <button className="btn" type="submit" disabled={busy} style={{ width: '100%', padding: '11px 0', fontSize: 14.5 }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <button
            type="button"
            className="btn-link"
            style={{ display: 'block', margin: '14px auto 0', fontSize: 12.5 }}
            onClick={() => { setMode('forgot'); setInfo(null); setError(null); }}
          >
            Forgotten your password?
          </button>
        </form>
      )}

      {mode === 'magic' && (
        <form onSubmit={submitMagic}>
          <AuthField label="Email">
            <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%' }} />
          </AuthField>
          <button className="btn" type="submit" disabled={busy} style={{ width: '100%', padding: '11px 0', fontSize: 14.5 }}>
            {busy ? 'Sending…' : 'Email me a sign-in link'}
          </button>
          <p style={{ margin: '12px 0 0', fontSize: 12, color: BRAND.muted, textAlign: 'center' }}>
            No password needed — we'll send a one-time link that signs you straight in.
          </p>
        </form>
      )}

      {mode === 'forgot' && (
        <form onSubmit={submitForgot}>
          <AuthField label="Email">
            <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%' }} />
          </AuthField>
          <button className="btn" type="submit" disabled={busy} style={{ width: '100%', padding: '11px 0', fontSize: 14.5 }}>
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
          <button
            type="button"
            className="btn-link"
            style={{ display: 'block', margin: '14px auto 0', fontSize: 12.5 }}
            onClick={() => { setMode('password'); setInfo(null); setError(null); }}
          >
            ← Back to sign in
          </button>
        </form>
      )}
    </AuthShell>
  );
}
