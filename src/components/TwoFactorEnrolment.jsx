import React, { useEffect, useState } from 'react';
import { BRAND } from '../theme.js';
import { api } from '../api.js';
import { Field } from './ui.jsx';

export function TwoFactorEnrolment({ enrolmentToken, onSuccess, onCancel }) {
  const [step, setStep] = useState('intro'); // intro | scan | verify | codes
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);
  const [finalSession, setFinalSession] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const start = async () => {
    setBusy(true); setError('');
    try {
      const { secret_base32, qr_data_url } = await api.post('/api/auth/2fa-enrol-start', {
        enrolment_token: enrolmentToken,
        method: 'totp',
      });
      setSecret(secret_base32);
      setQrDataUrl(qr_data_url);
      setStep('scan');
    } catch (err) {
      setError(err.message || 'Could not start enrolment');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!code.trim()) { setError('Enter the 6-digit code'); return; }
    setBusy(true); setError('');
    try {
      const { token, user, backup_codes } = await api.post('/api/auth/2fa-enrol-confirm', {
        enrolment_token: enrolmentToken,
        code: code.trim(),
      });
      setBackupCodes(backup_codes);
      setFinalSession({ token, user });
      setStep('codes');
    } catch (err) {
      setError(err.message || 'Could not confirm code');
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    if (!acknowledged || !finalSession) return;
    onSuccess(finalSession);
  };

  const download = () => {
    const blob = new Blob(
      ['Squideo Proposals backup codes\n\n' + backupCodes.join('\n') + '\n\nStore these somewhere safe. Each code works once.\n'],
      { type: 'text/plain' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'squideo-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Set up two-step verification</div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>
          Required for all Squideo accounts. Takes about a minute.
        </div>
      </div>

      {step === 'intro' && (
        <>
          <p style={{ fontSize: 13, color: BRAND.ink, margin: '0 0 12px', lineHeight: 1.5 }}>
            We'll pair your account with an authenticator app on your phone (e.g. <strong>Google Authenticator</strong>, <strong>1Password</strong>, <strong>Authy</strong>). After this you can also receive codes by email.
          </p>
          <button onClick={start} disabled={busy} className="btn" style={{ width: '100%', justifyContent: 'center', padding: 12 }}>
            {busy ? 'Please wait…' : 'Get started'}
          </button>
          {error && <div style={errorStyle}>{error}</div>}
          <div style={{ textAlign: 'center', marginTop: 14 }}>
            <button onClick={onCancel} className="btn-link" style={{ fontSize: 12 }}>Cancel</button>
          </div>
        </>
      )}

      {step === 'scan' && (
        <>
          <p style={{ fontSize: 13, color: BRAND.ink, margin: '0 0 12px', lineHeight: 1.5 }}>
            Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
          </p>
          {qrDataUrl && (
            <div style={{ display: 'flex', justifyContent: 'center', margin: '0 0 12px' }}>
              <img src={qrDataUrl} alt="Authenticator QR code" style={{ width: 200, height: 200, border: '1px solid ' + BRAND.border, borderRadius: 8 }} />
            </div>
          )}
          <div style={{ fontSize: 11, color: BRAND.muted, textAlign: 'center', marginBottom: 4 }}>
            Or enter this key manually:
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, textAlign: 'center', background: '#F1F4F7', border: '1px solid ' + BRAND.border, borderRadius: 6, padding: '8px 10px', marginBottom: 16, wordBreak: 'break-all' }}>
            {secret}
          </div>
          <Field label="6-digit code from your app">
            <input
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
            />
          </Field>
          {error && <div style={errorStyle}>{error}</div>}
          <button onClick={confirm} disabled={busy} className="btn" style={{ width: '100%', justifyContent: 'center', padding: 12 }}>
            {busy ? 'Verifying…' : 'Confirm and continue'}
          </button>
          <div style={{ textAlign: 'center', marginTop: 14 }}>
            <button onClick={onCancel} className="btn-link" style={{ fontSize: 12 }}>Cancel</button>
          </div>
        </>
      )}

      {step === 'codes' && backupCodes && (
        <>
          <p style={{ fontSize: 13, color: BRAND.ink, margin: '0 0 12px', lineHeight: 1.5 }}>
            <strong>Save these 10 backup codes now.</strong> Each one works once if you lose access to your authenticator app and your email.
          </p>
          <div style={{ background: '#F1F4F7', border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 14, marginBottom: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontFamily: 'monospace', fontSize: 13 }}>
              {backupCodes.map((c) => <div key={c}>{c}</div>)}
            </div>
          </div>
          <button onClick={download} className="btn-ghost" style={{ width: '100%', justifyContent: 'center', padding: 10, marginBottom: 14 }}>
            Download as .txt
          </button>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 16, fontSize: 13, color: BRAND.ink, cursor: 'pointer' }}>
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} style={{ marginTop: 3 }} />
            <span>I've saved these codes somewhere safe. I understand they won't be shown again.</span>
          </label>
          <button onClick={finish} disabled={!acknowledged} className="btn" style={{ width: '100%', justifyContent: 'center', padding: 12 }}>
            Finish and sign in
          </button>
        </>
      )}
    </div>
  );
}

const cardStyle = {
  width: '100%', maxWidth: 440, background: 'white',
  border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 32,
};

const errorStyle = {
  background: '#FEE2E2', color: '#991B1B', fontSize: 13,
  padding: '10px 12px', borderRadius: 6, marginTop: 12, marginBottom: 0,
};
