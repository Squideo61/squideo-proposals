// Profile + password. Password changes sign out every other session.
//
// In manage mode this is also where staff set the client's logo — the same
// companies.logo the CRM's organisation page writes, so the branding can be
// fixed from inside the portal you're looking at.
import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, SectionHeading } from '../components.jsx';
import { LogoUploader } from '../../components/LogoUploader.jsx';

export default function Settings() {
  const { user, companyId, manageMode, showToast, refreshSession } = usePortal();
  const [name, setName] = useState(user?.name || '');
  const [phone, setPhone] = useState(user?.phone || '');
  const [jobTitle, setJobTitle] = useState(user?.jobTitle || '');
  const [profileBusy, setProfileBusy] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState(null);

  const saveProfile = async (e) => {
    e.preventDefault();
    setProfileBusy(true);
    try {
      await portalApi.patch('me', { name, phone, jobTitle });
      await refreshSession();
      showToast('Profile saved ✓');
    } catch (err) {
      showToast(err.message);
    } finally {
      setProfileBusy(false);
    }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    setPwError(null);
    if (newPassword.length < 10) return setPwError('Your new password needs to be at least 10 characters.');
    if (newPassword !== confirm) return setPwError("Those passwords don't match.");
    setPwBusy(true);
    try {
      await portalApi.patch('me', { currentPassword, newPassword });
      setCurrentPassword(''); setNewPassword(''); setConfirm('');
      showToast('Password changed ✓ — other devices have been signed out');
    } catch (err) {
      setPwError(err.message);
    } finally {
      setPwBusy(false);
    }
  };

  const field = (label, value, set, type = 'text', props = {}) => (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.ink, marginBottom: 6 }}>{label}</div>
      <input className="input" type={type} value={value} onChange={(e) => set(e.target.value)} style={{ width: '100%' }} {...props} />
    </label>
  );

  return (
    <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: BRAND.ink }}>Settings</h1>

      {manageMode && <ClientLogoCard companyId={companyId} onSaved={refreshSession} showToast={showToast} />}

      <Card>
        <SectionHeading>Your details</SectionHeading>
        <div style={{ fontSize: 12.5, color: BRAND.muted, marginBottom: 14 }}>Signed in as <strong style={{ color: BRAND.ink }}>{user?.email}</strong></div>
        <form onSubmit={saveProfile}>
          {field('Name', name, setName)}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {field('Phone', phone, setPhone)}
            {field('Job title', jobTitle, setJobTitle)}
          </div>
          <button className="btn" type="submit" disabled={profileBusy}>{profileBusy ? 'Saving…' : 'Save details'}</button>
        </form>
      </Card>

      <Card>
        <SectionHeading>Change password</SectionHeading>
        {pwError && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 14 }}>
            {pwError}
          </div>
        )}
        <form onSubmit={savePassword}>
          {field('Current password', currentPassword, setCurrentPassword, 'password', { autoComplete: 'current-password', required: true })}
          {field('New password (10+ characters)', newPassword, setNewPassword, 'password', { autoComplete: 'new-password', required: true, minLength: 10 })}
          {field('Confirm new password', confirm, setConfirm, 'password', { autoComplete: 'new-password', required: true })}
          <button className="btn" type="submit" disabled={pwBusy}>{pwBusy ? 'Saving…' : 'Change password'}</button>
        </form>
      </Card>
    </div>
  );
}

// Manage mode only. Writes companies.logo — the same record the CRM's
// organisation page edits, so a logo set here also pre-fills their next
// proposal, and one set there shows up here.
function ClientLogoCard({ companyId, onSaved, showToast }) {
  const [logo, setLogo] = useState(undefined); // undefined = still loading
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    setLogo(undefined);
    portalApi.get(`company-logo?companyId=${encodeURIComponent(companyId)}`)
      .then((d) => setLogo(d.logo || null))
      .catch(() => setLogo(null));
  }, [companyId]);

  const save = async (next) => {
    const previous = logo;
    setLogo(next); // optimistic — the uploader has already rendered it
    setBusy(true);
    try {
      await portalApi.post(`company-logo?companyId=${encodeURIComponent(companyId)}`, { logo: next });
      showToast(next ? 'Logo updated ✓' : 'Logo removed ✓');
      // Refresh the session so the header picks up the new URL (it carries the
      // logo's timestamp, so the browser fetches the new image rather than the
      // cached one).
      await onSaved();
    } catch (err) {
      setLogo(previous);
      showToast(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ border: '1px solid #F5C26B', background: '#FFFCF5' }}>
      <SectionHeading>Client logo</SectionHeading>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
        Staff only. Shows in the portal header and on their sign-in screen, and pre-fills every new proposal for this client.
      </p>
      {logo === undefined ? (
        <div style={{ fontSize: 13, color: BRAND.muted }}>Loading…</div>
      ) : (
        <div style={{ opacity: busy ? 0.6 : 1, pointerEvents: busy ? 'none' : undefined }}>
          <LogoUploader logo={logo} onChange={save} showMsg={showToast} />
        </div>
      )}
    </Card>
  );
}
