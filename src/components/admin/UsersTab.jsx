import React, { useEffect, useState } from 'react';
import { Trash2, Send, Copy, Check, Bell } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Field, Badge } from '../ui.jsx';
import { permissionsInclude } from '../../lib/permissions.js';
import { UserNotificationEditor } from './UserNotificationEditor.jsx';

const STATUS_COLOR = {
  pending: 'yellow',
  used: 'green',
  expired: 'grey',
  revoked: 'grey',
};

export function UsersTab() {
  const { state, actions, showMsg } = useStore();
  const session = state.session;
  const perms = session?.permissions || [];
  const canManage = permissionsInclude(perms, 'users.manage');
  const users = Object.values(state.users);
  const roles = Object.values(state.roles || {});

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviteError, setInviteError] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [invites, setInvites] = useState([]);
  const [copiedToken, setCopiedToken] = useState(null);
  const [notifEditorFor, setNotifEditorFor] = useState(null);

  const loadInvites = () => {
    if (!canManage) return;
    api.get('/api/invites').then(setInvites).catch(() => setInvites([]));
  };

  useEffect(() => { loadInvites(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [canManage]);

  const remove = (email) => {
    if (email === session.email) {
      showMsg("You can't remove your own account while signed in.");
      return;
    }
    if (!window.confirm('Remove ' + email + '?')) return;
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
    if (!window.confirm('Revoke this invite?')) return;
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

  const changeUserRole = async (email, role) => {
    if (email === session.email) {
      showMsg("You can't change your own role.");
      return;
    }
    try {
      await actions.updateUserRole(email, role);
      showMsg('Role updated');
    } catch (err) {
      showMsg(err.message || 'Could not update role');
    }
  };

  return (
    <>
      {!canManage && (
        <div style={{
          padding: 16,
          background: '#FEF3C7',
          border: '1px solid #FCD34D',
          borderRadius: 8,
          marginBottom: 20,
          fontSize: 13,
          color: '#92400E',
        }}>
          You can see who's in the workspace but only an admin can invite or
          remove people.
        </div>
      )}

      {canManage && (
        <div style={{
          background: 'white',
          border: '1px solid ' + BRAND.border,
          borderRadius: 12,
          padding: 20,
          marginBottom: 24,
        }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700 }}>Invite a teammate</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 12, alignItems: 'flex-end' }}>
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
                {roles.length === 0
                  ? <option value="member">Member</option>
                  : roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
            <button onClick={sendInvite} disabled={inviteBusy} className="btn" style={{ padding: '10px 18px' }}>
              <Send size={14} /> {inviteBusy ? 'Sending…' : 'Send invite'}
            </button>
          </div>
          {inviteError && (
            <div style={{ background: '#FEE2E2', color: '#991B1B', fontSize: 13, padding: '8px 10px', borderRadius: 6, marginTop: 8 }}>{inviteError}</div>
          )}
        </div>
      )}

      <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700 }}>Members ({users.length})</h3>
      <div style={{ display: 'grid', gap: 8, marginBottom: 32 }}>
        {users.map((u) => (
          <div key={u.email} style={{
            display: 'grid',
            gridTemplateColumns: '48px 1fr auto auto auto',
            alignItems: 'center',
            gap: 12,
            padding: 12,
            background: 'white',
            border: '1px solid ' + BRAND.border,
            borderRadius: 8,
          }}>
            {u.avatar
              ? <img src={u.avatar} alt={u.name} style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />
              : <div style={{ width: 36, height: 36, borderRadius: '50%', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{(u.name && u.name[0] || '?').toUpperCase()}</div>
            }
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span>{u.name}</span>
                {u.email === session.email && <span style={{ fontSize: 11, color: BRAND.blue, fontWeight: 600 }}>YOU</span>}
              </div>
              <div style={{ fontSize: 12, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
            </div>
            {canManage && u.email !== session.email
              ? (
                <select
                  className="input"
                  value={u.role || 'member'}
                  onChange={(e) => changeUserRole(u.email, e.target.value)}
                  style={{ minWidth: 140 }}
                >
                  {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              )
              : <Badge color="blue">{state.roles?.[u.role]?.name || u.role || 'member'}</Badge>
            }
            <button
              onClick={() => setNotifEditorFor(u.email)}
              aria-label={'Edit notifications for ' + u.email}
              title="Edit notifications"
              className="btn-icon"
            >
              <Bell size={14} />
            </button>
            {canManage && u.email !== session.email
              ? (
                <button
                  onClick={() => remove(u.email)}
                  aria-label={'Remove user ' + u.email}
                  className="btn-icon is-danger"
                >
                  <Trash2 size={14} />
                </button>
              )
              : <span />}
          </div>
        ))}
      </div>

      {canManage && (
        <>
          <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700 }}>Invites ({invites.length})</h3>
          {invites.length === 0 ? (
            <div style={{ fontSize: 13, color: BRAND.muted, padding: '8px 2px' }}>No invites yet.</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {invites.map((inv) => (
                <div key={inv.token} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: 10,
                  background: 'white',
                  border: '1px solid ' + BRAND.border,
                  borderRadius: 8,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.email}</span>
                      <Badge color={STATUS_COLOR[inv.status] || 'grey'}>{inv.status}</Badge>
                      <Badge color="blue">{state.roles?.[inv.role]?.name || inv.role}</Badge>
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

      {notifEditorFor && (
        <UserNotificationEditor
          email={notifEditorFor}
          onClose={() => setNotifEditorFor(null)}
        />
      )}
    </>
  );
}
