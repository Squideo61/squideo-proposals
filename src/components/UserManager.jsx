import React from 'react';
import { Trash2, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { Modal } from './ui.jsx';

export function UserManager({ onClose }) {
  const { state, actions, showMsg } = useStore();
  const currentUser = state.session;
  const users = Object.values(state.users);

  const remove = (email) => {
    if (email === currentUser.email) {
      showMsg("You can't remove your own account while signed in.");
      return;
    }
    if (!confirm('Remove ' + email + '?')) return;
    actions.removeUser(email);
    showMsg('User removed');
  };

  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Workspace users</h3>
        <button onClick={onClose} aria-label="Close" className="btn-icon"><X size={14} /></button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted }}>New users sign up themselves at the login screen.</p>
      <div style={{ display: 'grid', gap: 8 }}>
        {users.map((u) => (
          <div key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8 }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
              {u.name[0].toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {u.name}
                {u.email === currentUser.email && <span style={{ marginLeft: 8, fontSize: 11, color: BRAND.blue, fontWeight: 600 }}>YOU</span>}
              </div>
              <div style={{ fontSize: 12, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
            </div>
            <button
              onClick={() => remove(u.email)}
              disabled={u.email === currentUser.email}
              aria-label={'Remove user ' + u.email}
              className={'btn-icon' + (u.email === currentUser.email ? '' : ' is-danger')}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
