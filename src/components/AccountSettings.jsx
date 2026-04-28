import React, { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { resizeImage } from '../utils.js';
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

export function AccountSettings({ onClose }) {
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
    </Modal>
  );
}
