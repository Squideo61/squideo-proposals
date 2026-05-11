import React, { useState } from 'react';
import { BRAND } from '../theme.js';
import { api } from '../api.js';
import { Field } from './ui.jsx';

const TABS = [
  { id: 'totp',   label: 'Authenticator' },
  { id: 'email',  label: 'Email code' },
  { id: 'backup', label: 'Backup code' },
];

export function TwoFactorChallenge({ challengeToken, onSuccess, onCancel }) {
  const [tab, setTab] = useState('totp');
  const [code, setCode] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');

  const switchTab = (id) => {
    setTab(id);
    setCode('');
    setError('');
  };

  const sendEmailCode = async () => {
    setSending(true); setError('');
    try {
      await api.post('/api/auth/2fa-send-email', { token: challengeToken });
      setEmailSent(true);
    } catch (err) {
      setError(err.message || 'Could not send code');
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    if (!code.trim()) { setError('Enter your code'); return; }
    setBusy(true); setError('');
    try {
      const { token, user } = await api.post('/api/auth/2fa-verify', {
        challenge_token: challengeToken,
        method: tab,
        code: code.trim(),
        remember_device: remember,
      });
      onSuccess({ token, user });
    } catch (err) {
      setError(err.message || 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Two-step verification</div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>
          Confirm it's you to finish signing in.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid ' + BRAND.border }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => switchTab(t.id)}
            style={{
              flex: 1,
              padding: '10px 8px',
              fontSize: 13,
              fontWeight: 600,
              background: 'transparent',
              border: 'none',
              borderBottom: '2px solid ' + (tab === t.id ? BRAND.blue : 'transparent'),
              color: tab === t.id ? BRAND.ink : BRAND.muted,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'totp' && (
        <Field label="6-digit code from your authenticator app">
          <input
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="123456"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        </Field>
      )}

      {tab === 'email' && (
        <>
          {!emailSent ? (
            <div style={{ marginBottom: 14 }}>
              <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 10px' }}>
                We'll email a 6-digit code to your account address.
              </p>
              <button onClick={sendEmailCode} disabled={sending} className="btn" style={{ width: '100%', justifyContent: 'center', padding: 10 }}>
                {sending ? 'Sending…' : 'Send code'}
              </button>
            </div>
          ) : (
            <Field label="Enter the 6-digit code from your email">
              <input
                className="input"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              />
            </Field>
          )}
          {emailSent && (
            <button onClick={sendEmailCode} disabled={sending} className="btn-link" style={{ fontSize: 12, marginBottom: 12 }}>
              {sending ? 'Sending…' : 'Resend code'}
            </button>
          )}
        </>
      )}

      {tab === 'backup' && (
        <Field label="Backup code">
          <input
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-F0-9-]/g, '').slice(0, 9))}
            placeholder="XXXX-XXXX"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        </Field>
      )}

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 13, color: BRAND.ink, cursor: 'pointer' }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember this browser for 30 days
      </label>

      {error && (
        <div style={errorStyle}>{error}</div>
      )}

      {(tab !== 'email' || emailSent) && (
        <button onClick={submit} disabled={busy} className="btn" style={{ width: '100%', justifyContent: 'center', padding: 12 }}>
          {busy ? 'Verifying…' : 'Verify and sign in'}
        </button>
      )}

      <div style={{ textAlign: 'center', marginTop: 14 }}>
        <button onClick={onCancel} className="btn-link" style={{ fontSize: 12 }}>Back to sign in</button>
      </div>
    </div>
  );
}

const cardStyle = {
  width: '100%', maxWidth: 400, background: 'white',
  border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 32,
};

const errorStyle = {
  background: '#FEE2E2', color: '#991B1B', fontSize: 13,
  padding: '10px 12px', borderRadius: 6, marginBottom: 12,
};
