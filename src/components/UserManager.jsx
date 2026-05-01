import React, { useEffect, useState } from 'react';
import { Trash2, X, Send, Copy, Check } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Modal, Field, Badge } from './ui.jsx';

const STATUS_COLOR = {
  pending: 'yellow',
  used: 'green',
  expired: 'grey',
  revoked: 'grey',
};

export function UserManager({ onClose }) {
  const { state, actions, showMsg } = useStore();
  const currentUser = state.session;
  const isAdmin = currentUser?.role === 'admin';
  const users = Object.values(state.users);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviteError, setInviteError] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [invites, setInvites] = useState([]);
  const [copiedToken, setCopiedToken] = useState(null);

  const loadInvites = () => {
    if (!isAdmin) return;
    api.get('/api/invites').then(setInvites).catch(() => setInvites([]));
  };

  useEffect(() => { loadInvites(); }, [isAdmin]);

  const remove = (email) => {
    if (email === currentUser.email) {
      showMsg("You can't remove your own account while signed in.");
      return;
    }
    if (!confirm('Remove ' + email + '?')) return;
    actions.removeUser(email);
    showMsg('User removed');
  };

  const sendInvite = async () => {
    setInviteError('');
    const e = inviteEmail.trim().toLowerCase();
    if (!e || !e.includes('@')) { setInviteError('Enter a valid email'); return; }
    setInviteBusy(true);
    try {
      await api.post('/api/invites', { email: e, role: inviteRole });
      setInviteEmail('');
      setInviteRole('member');
      showMsg('Invite sent to ' + e);
      loadInvites();
    } catch (err) {
      setInviteError(err.message || 'Could not send invite');
    } finally {
      setInviteBusy(false);
    }
  };

  const revokeInvite = async (token) => {
    if (!confirm('Revoke this invite?')) return;
    try {
      await api.delete('/api/invites?token=' + encodeURIComponent(token));
      showMsg('Invite revoked');
      loadInvites();
    } catch (err) {
      showMsg(err.message || 'Could not revoke');
    }
  };

  const copyInviteLink = async (token) => {
    const link = `${window.location.origin}/?invite=${token}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 1500);
    } catch {
      window.prompt('Copy this link:', link);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Workspace members</h3>
        <button onClick={onClose} aria-label="Close" className="btn-icon"><X size={14} /></button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted }}>
        {isAdmin
          ? 'Invite teammates by email. They can only sign up via the invite link.'
          : 'Only admins can invite or remove members. Contact an admin for access changes.'}
      </p>

      {isAdmin && (
        <div style={{ background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>Invite a teammate</div>
          <Field label="Email">
            <input
              className="input"
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="teammate@example.com"
              onKeyDown={(e) => { if (e.key === 'Enter') sendInvite(); }}
            />
          </Field>
          <Field label="Role">
            <select className="input" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          {inviteError && (
            <div style={{ background: '#FEE2E2', color: '#991B1B', fontSize: 13, padding: '8px 10px', borderRadius: 6, marginBottom: 10 }}>{inviteError}</div>
          )}
          <button onClick={sendInvite} disabled={inviteBusy} className="btn" style={{ width: '100%', justifyContent: 'center' }}>
            <Send size={14} /> {inviteBusy ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      )}

      <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 8px' }}>Members</div>
      <div style={{ display: 'grid', gap: 8, marginBottom: isAdmin ? 18 : 0 }}>
        {users.map((u) => (
          <div key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8 }}>
            {u.avatar
              ? <img src={u.avatar} alt={u.name} style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
              : <div style={{ width: 36, height: 36, borderRadius: '50%', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0 }}>{(u.name && u.name[0] || '?').toUpperCase()}</div>
            }
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span>{u.name}</span>
                {u.role === 'admin' && <Badge color="blue">Admin</Badge>}
                {u.email === currentUser.email && <span style={{ fontSize: 11, color: BRAND.blue, fontWeight: 600 }}>YOU</span>}
              </div>
              <div style={{ fontSize: 12, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
            </div>
            {isAdmin && (
              <button
                onClick={() => remove(u.email)}
                disabled={u.email === currentUser.email}
                aria-label={'Remove user ' + u.email}
                className={'btn-icon' + (u.email === currentUser.email ? '' : ' is-danger')}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </div>

      {isAdmin && (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 8px' }}>Invites</div>
          {invites.length === 0 ? (
            <div style={{ fontSize: 13, color: BRAND.muted, padding: '8px 2px' }}>No invites yet.</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {invites.map((inv) => (
                <div key={inv.token} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.email}</span>
                      <Badge color={STATUS_COLOR[inv.status] || 'grey'}>{inv.status}</Badge>
                      {inv.role === 'admin' && <Badge color="blue">Admin</Badge>}
                    </div>
                    <div style={{ fontSize: 11, color: BRAND.muted }}>
                      Invited by {inv.invitedByEmail} · expires {new Date(inv.expiresAt).toLocaleDateString('en-GB')}
                    </div>
                  </div>
                  {inv.status === 'pending' && (
                    <>
                      <button
                        onClick={() => copyInviteLink(inv.token)}
                        aria-label="Copy invite link"
                        className="btn-icon"
                        title="Copy invite link"
                      >
                        {copiedToken === inv.token ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                      <button
                        onClick={() => revokeInvite(inv.token)}
                        aria-label="Revoke invite"
                        className="btn-icon is-danger"
                        title="Revoke"
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
