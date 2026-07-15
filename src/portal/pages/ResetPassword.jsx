import React, { useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal, rememberedLogoUrl } from '../PortalContext.jsx';
import AuthShell, { AuthField, AuthError } from './AuthShell.jsx';

export default function ResetPassword({ token, onDone }) {
  const { refreshSession } = usePortal();
  const [logoUrl] = useState(rememberedLogoUrl);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (password.length < 10) return setError('Your password needs to be at least 10 characters.');
    if (password !== confirm) return setError("Those passwords don't match.");
    setBusy(true);
    try {
      await portalApi.post('auth?op=reset-consume', { token, password });
      onDone?.();
      await refreshSession();
      window.location.hash = '#/';
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell logoUrl={logoUrl}>
      <h1 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 800, color: BRAND.ink }}>Choose a new password</h1>
      <p style={{ margin: '0 0 18px', fontSize: 13.5, color: BRAND.muted }}>You'll be signed in straight after.</p>
      <AuthError>{error}</AuthError>
      <form onSubmit={submit}>
        <AuthField label="New password (10+ characters)">
          <input className="input" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} />
        </AuthField>
        <AuthField label="Confirm password">
          <input className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ width: '100%' }} />
        </AuthField>
        <button className="btn" type="submit" disabled={busy} style={{ width: '100%', padding: '11px 0', fontSize: 14.5 }}>
          {busy ? 'Saving…' : 'Save & sign in'}
        </button>
      </form>
    </AuthShell>
  );
}
