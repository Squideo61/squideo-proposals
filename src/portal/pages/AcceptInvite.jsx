// Invite acceptance: prefilled from the invite (name/phone/job title captured
// at signing), sets a password for new accounts; existing accounts just join
// the extra organisation.
import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import AuthShell, { AuthField, AuthError, AuthInfo } from './AuthShell.jsx';

export default function AcceptInvite({ token, onDone }) {
  const { refreshSession } = usePortal();
  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState(null);
  const [fatal, setFatal] = useState(null);
  const [alreadyAccepted, setAlreadyAccepted] = useState(false);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await portalApi.get(`auth?op=invite-info&token=${encodeURIComponent(token)}`);
        setInvite(data);
        setName(data.prefill?.name || '');
        setPhone(data.prefill?.phone || '');
        setJobTitle(data.prefill?.jobTitle || '');
      } catch (err) {
        if (err.status === 409) setAlreadyAccepted(true);
        else setFatal(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!invite?.existingAccount) {
      if (password.length < 10) return setError('Your password needs to be at least 10 characters.');
      if (password !== confirm) return setError("Those passwords don't match.");
    }
    setBusy(true);
    try {
      await portalApi.post('auth?op=accept-invite', {
        token, password: password || undefined, name, phone, jobTitle,
      });
      onDone?.();
      await refreshSession();
      window.location.hash = '#/';
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <AuthShell><div style={{ textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>Checking your invite…</div></AuthShell>;
  }
  if (alreadyAccepted) {
    return (
      <AuthShell>
        <AuthInfo>This invite has already been used — just sign in below.</AuthInfo>
        <button className="btn" style={{ width: '100%', padding: '11px 0' }} onClick={() => { onDone?.(); window.location.search = ''; }}>
          Go to sign in
        </button>
      </AuthShell>
    );
  }
  if (fatal) {
    return (
      <AuthShell>
        <AuthError>{fatal}</AuthError>
        <button className="btn" style={{ width: '100%', padding: '11px 0' }} onClick={() => { onDone?.(); window.location.search = ''; }}>
          Go to sign in
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 800, color: BRAND.ink }}>
        {invite.existingAccount ? `Join ${invite.companyName}` : 'Set up your portal account'}
      </h1>
      <p style={{ margin: '0 0 18px', fontSize: 13.5, color: BRAND.muted, lineHeight: 1.5 }}>
        {invite.existingAccount
          ? <>You already have a Squideo portal account — confirm below to add <strong>{invite.companyName}</strong> to it.</>
          : <>You're joining <strong>{invite.companyName}</strong>'s portal as <strong>{invite.email}</strong>. We've prefilled what we know — check it and choose a password.</>}
      </p>
      <AuthError>{error}</AuthError>
      <form onSubmit={submit}>
        {!invite.existingAccount && (
          <>
            <AuthField label="Your name">
              <input className="input" required value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
            </AuthField>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <AuthField label="Phone (optional)">
                <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ width: '100%' }} />
              </AuthField>
              <AuthField label="Job title (optional)">
                <input className="input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} style={{ width: '100%' }} />
              </AuthField>
            </div>
            <AuthField label="Choose a password (10+ characters)">
              <input className="input" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} />
            </AuthField>
            <AuthField label="Confirm password">
              <input className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ width: '100%' }} />
            </AuthField>
          </>
        )}
        <button className="btn" type="submit" disabled={busy} style={{ width: '100%', padding: '11px 0', fontSize: 14.5 }}>
          {busy ? 'Setting up…' : invite.existingAccount ? `Add ${invite.companyName} to my account` : 'Create my account'}
        </button>
      </form>
    </AuthShell>
  );
}
