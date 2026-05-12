import React, { useEffect, useRef, useState } from 'react';
import { Mail, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { resizeImage } from '../utils.js';
import { api } from '../api.js';
import { Field, Modal } from './ui.jsx';

function AvatarCircle({ avatar, name, size = 80 }) {
  if (avatar) {
    return (
      <img
        src={avatar}
        alt={name}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
      />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: BRAND.blue, color: 'white',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.4, fontWeight: 700,
    }}>
      {(name || '?')[0].toUpperCase()}
    </div>
  );
}

export function AccountSettings({ onClose, onLogout }) {
  const { state, actions, showMsg } = useStore();
  const user = state.session;
  const fileRef = useRef(null);

  const [avatarBusy, setAvatarBusy] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState(false);

  const handleAvatarFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setAvatarBusy(true);
    try {
      const dataUrl = await resizeImage(file, 200, 200, false);
      await actions.updateAvatar(dataUrl);
      showMsg('Profile photo updated');
    } catch {
      showMsg('Failed to update photo');
    } finally {
      setAvatarBusy(false);
      e.target.value = '';
    }
  };

  const removeAvatar = async () => {
    setAvatarBusy(true);
    try {
      await actions.updateAvatar(null);
      showMsg('Profile photo removed');
    } catch {
      showMsg('Failed to remove photo');
    } finally {
      setAvatarBusy(false);
    }
  };

  const changePassword = async () => {
    setPwError('');
    setPwSuccess(false);
    if (!currentPw || !newPw || !confirmPw) { setPwError('All fields are required'); return; }
    if (newPw !== confirmPw) { setPwError('New passwords do not match'); return; }
    if (newPw.length < 6) { setPwError('New password must be at least 6 characters'); return; }
    setPwBusy(true);
    try {
      await actions.updatePassword(currentPw, newPw);
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
      setPwSuccess(true);
      showMsg('Password updated');
    } catch (err) {
      setPwError(err.message || 'Something went wrong');
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>My account</h3>
        <button onClick={onClose} aria-label="Close" className="btn-icon"><X size={14} /></button>
      </div>

      {/* Profile photo */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: BRAND.ink }}>Profile photo</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <AvatarCircle avatar={user.avatar} name={user.name} size={72} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              className="btn"
              disabled={avatarBusy}
              onClick={() => fileRef.current?.click()}
              style={{ fontSize: 13 }}
            >
              {avatarBusy ? 'Uploading…' : user.avatar ? 'Change photo' : 'Upload photo'}
            </button>
            {user.avatar && (
              <button
                className="btn-ghost"
                disabled={avatarBusy}
                onClick={removeAvatar}
                style={{ fontSize: 13, color: '#DC2626' }}
              >
                Remove photo
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarFile} />
          </div>
        </div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 8 }}>JPG or PNG. Max 5MB. Will be resized to 200×200px.</div>
      </div>

      <div style={{ borderTop: '1px solid ' + BRAND.border, marginBottom: 24 }} />

      {/* Gmail connection */}
      <GmailConnectSection />

      <div style={{ borderTop: '1px solid ' + BRAND.border, marginBottom: 24 }} />

      {/* Change password */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: BRAND.ink }}>Change password</div>
        <Field label="Current password">
          <input
            className="input"
            type="password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            placeholder="••••••••"
          />
        </Field>
        <Field label="New password">
          <input
            className="input"
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="••••••••"
          />
        </Field>
        <Field label="Confirm new password">
          <input
            className="input"
            type="password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            placeholder="••••••••"
            onKeyDown={(e) => { if (e.key === 'Enter') changePassword(); }}
          />
        </Field>

        {pwError && (
          <div style={{ background: '#FEE2E2', color: '#991B1B', fontSize: 13, padding: '10px 12px', borderRadius: 6, marginBottom: 12 }}>
            {pwError}
          </div>
        )}
        {pwSuccess && (
          <div style={{ background: '#DCFCE7', color: '#166534', fontSize: 13, padding: '10px 12px', borderRadius: 6, marginBottom: 12 }}>
            Password updated successfully.
          </div>
        )}

        <button onClick={changePassword} disabled={pwBusy} className="btn" style={{ width: '100%', justifyContent: 'center' }}>
          {pwBusy ? 'Saving…' : 'Update password'}
        </button>
      </div>

      <div style={{ borderTop: '1px solid ' + BRAND.border, margin: '24px 0' }} />

      <TwoFactorSection onResetDone={onClose} />

      <div style={{ borderTop: '1px solid ' + BRAND.border, marginTop: 24, paddingTop: 20 }}>
        <button className="btn-ghost" onClick={onLogout} style={{ color: '#DC2626', width: '100%', justifyContent: 'center' }}>
          Sign out
        </button>
      </div>
    </Modal>
  );
}

function TwoFactorSection({ onResetDone }) {
  const { actions, showMsg } = useStore();
  const [mode, setMode] = useState(null); // null | 'reset' | 'regen'
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [codes, setCodes] = useState(null);

  const cancel = () => { setMode(null); setPassword(''); setError(''); setCodes(null); };

  const reset = async () => {
    if (!password) { setError('Enter your current password'); return; }
    setBusy(true); setError('');
    try {
      await api.post('/api/auth/2fa-reset', { password });
      showMsg('Two-step verification reset. Signing out…');
      setTimeout(() => actions.logout(), 800);
      onResetDone?.();
    } catch (err) {
      setError(err.message || 'Could not reset');
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (!password) { setError('Enter your current password'); return; }
    setBusy(true); setError('');
    try {
      const { backup_codes } = await api.post('/api/auth/2fa-regenerate-backup', { password });
      setCodes(backup_codes);
      setPassword('');
    } catch (err) {
      setError(err.message || 'Could not regenerate codes');
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    const blob = new Blob(
      ['Squideo Proposals backup codes\n\n' + codes.join('\n') + '\n\nStore these somewhere safe. Each code works once.\n'],
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
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: BRAND.ink }}>Two-step verification</div>

      {!mode && (
        <div style={{ background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 14 }}>
          <div style={{ fontSize: 13, marginBottom: 10 }}>
            Authenticator app + email codes are enabled on your account.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setMode('regen')} className="btn-ghost" style={{ fontSize: 13 }}>
              Regenerate backup codes
            </button>
            <button onClick={() => setMode('reset')} className="btn-ghost" style={{ fontSize: 13, color: '#DC2626' }}>
              Reset authenticator
            </button>
          </div>
        </div>
      )}

      {mode && !codes && (
        <div style={{ background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 14 }}>
          <div style={{ fontSize: 13, marginBottom: 10 }}>
            {mode === 'reset'
              ? 'Resetting removes your authenticator and backup codes. You\'ll be signed out and asked to set up two-step verification again on your next login.'
              : 'Generate a fresh set of 10 backup codes. Your old codes will stop working immediately.'}
          </div>
          <Field label="Current password">
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') (mode === 'reset' ? reset() : regenerate()); }}
            />
          </Field>
          {error && (
            <div style={{ background: '#FEE2E2', color: '#991B1B', fontSize: 13, padding: '10px 12px', borderRadius: 6, marginBottom: 10 }}>
              {error}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={mode === 'reset' ? reset : regenerate}
              disabled={busy}
              className="btn"
              style={{ flex: 1, justifyContent: 'center' }}
            >
              {busy ? 'Working…' : mode === 'reset' ? 'Reset authenticator' : 'Regenerate codes'}
            </button>
            <button onClick={cancel} disabled={busy} className="btn-ghost">Cancel</button>
          </div>
        </div>
      )}

      {codes && (
        <div style={{ background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 14 }}>
          <div style={{ fontSize: 13, marginBottom: 10 }}>
            <strong>Save these now.</strong> They won't be shown again.
          </div>
          <div style={{ background: '#F1F4F7', border: '1px solid ' + BRAND.border, borderRadius: 6, padding: 12, marginBottom: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontFamily: 'monospace', fontSize: 13 }}>
              {codes.map(c => <div key={c}>{c}</div>)}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={download} className="btn-ghost" style={{ flex: 1, justifyContent: 'center' }}>Download as .txt</button>
            <button onClick={cancel} className="btn">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

function GmailConnectSection() {
  const { state, actions, showMsg } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const account = state.gmailAccount;
  const connected = !!(account && account.connected);

  const connect = async () => {
    setError('');
    setBusy(true);
    try {
      const url = await actions.connectGmail();
      if (!url) throw new Error('No auth URL returned');
      // Open in a popup so we don't lose any unsaved state in the modal.
      const popup = window.open(url, 'squideo_gmail_oauth', 'width=520,height=640');
      if (!popup) {
        // Popup blocker — fall back to a same-tab navigation.
        window.location.href = url;
        return;
      }
      // Poll for the popup closing, then refresh the connection status.
      const timer = setInterval(async () => {
        if (popup.closed) {
          clearInterval(timer);
          await actions.refreshGmailAccount();
          setBusy(false);
        }
      }, 500);
    } catch (err) {
      setError(err?.message || 'Could not start Gmail connection');
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect Gmail? Outbound emails from Squideo will fall back to the system sender.')) return;
    setBusy(true);
    try {
      await actions.disconnectGmail();
      await actions.refreshGmailAccount();
      showMsg('Gmail disconnected');
    } finally {
      setBusy(false);
    }
  };

  // Backfill state derived from the server response. "In progress" means it's
  // either never been run OR was started but not yet stamped complete.
  const backfillInProgress = connected
    && account.backfillStartedAt
    && !account.backfillCompletedAt;
  const backfillNeverRun = connected && !account.backfillStartedAt;

  // While a backfill is running, poll the status every 3 seconds so the user
  // sees the message count climb live. Fire a toast on the in_progress→done
  // transition. The wasInProgress ref guards against double-firing across
  // re-renders.
  const wasInProgress = useRef(backfillInProgress);
  useEffect(() => {
    if (wasInProgress.current && !backfillInProgress && account?.backfillCompletedAt) {
      showMsg(`Gmail backfill complete — ${account.backfillIngested || 0} messages added`);
    }
    wasInProgress.current = backfillInProgress;
  }, [backfillInProgress, account?.backfillCompletedAt, account?.backfillIngested, showMsg]);

  useEffect(() => {
    if (!backfillInProgress) return undefined;
    const timer = setInterval(() => { actions.refreshGmailAccount(); }, 3000);
    return () => clearInterval(timer);
  }, [backfillInProgress, actions]);

  const runBackfill = async () => {
    setError('');
    try {
      await actions.backfillGmail();
      showMsg('Backfill started');
    } catch (err) {
      setError(err?.message || 'Backfill failed to start');
    }
  };

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: BRAND.ink }}>Gmail integration</div>
      <div style={{ background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flexShrink: 0, width: 36, height: 36, borderRadius: 8, background: connected ? '#DCFCE7' : '#F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Mail size={18} color={connected ? '#16A34A' : BRAND.muted} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {connected ? (
              <>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{account.gmailAddress}</div>
                <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>
                  Squideo can send email on your behalf and syncs replies into the right deal.
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Not connected</div>
                <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>
                  Connect your Gmail to send deal emails directly from Squideo.
                </div>
              </>
            )}
          </div>
          {connected ? (
            <button onClick={disconnect} disabled={busy} className="btn-ghost" style={{ flexShrink: 0 }}>
              {busy ? '…' : 'Disconnect'}
            </button>
          ) : (
            <button onClick={connect} disabled={busy} className="btn" style={{ flexShrink: 0 }}>
              {busy ? 'Connecting…' : 'Connect Gmail'}
            </button>
          )}
        </div>
        {connected && (
          <div style={{ marginTop: 10, fontSize: 12, color: BRAND.muted, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {backfillInProgress && <span>Backfilling last 30 days… <strong>{account.backfillIngested}</strong> messages so far.</span>}
            {!backfillInProgress && account.backfillCompletedAt && <span>Backfilled <strong>{account.backfillIngested}</strong> messages from the last 30 days.</span>}
            {backfillNeverRun && <span>Backfill hasn't run yet on this account.</span>}
            <button onClick={runBackfill} className="btn-ghost" style={{ fontSize: 12, padding: '2px 8px' }}>
              {backfillInProgress ? 'Retry backfill' : 'Backfill 30 days'}
            </button>
          </div>
        )}
        {error && (
          <div style={{ marginTop: 10, background: '#FEE2E2', color: '#991B1B', fontSize: 13, padding: '8px 10px', borderRadius: 6 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
