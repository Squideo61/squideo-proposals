import React, { useState } from 'react';
import { Plus, Edit3, Trash2, Lock } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Badge } from '../ui.jsx';
import { permissionsInclude } from '../../lib/permissions.js';
import { RoleEditor } from './RoleEditor.jsx';

export function RolesTab() {
  const { state, actions, showMsg } = useStore();
  const session = state.session;
  const canManage = permissionsInclude(session?.permissions || [], 'roles.manage');
  const roles = Object.values(state.roles || {}).sort((a, b) => {
    if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  const [editing, setEditing] = useState(null); // role row or { __new: true }
  const [creating, setCreating] = useState(false);

  if (!canManage) {
    return (
      <div style={{
        padding: 16,
        background: '#FEF3C7',
        border: '1px solid #FCD34D',
        borderRadius: 8,
        fontSize: 13,
        color: '#92400E',
      }}>
        You don't have permission to edit roles. Ask an admin to grant
        <code style={{ background: '#FCD34D33', padding: '0 4px', borderRadius: 3 }}> roles.manage</code>.
      </div>
    );
  }

  const remove = async (role) => {
    if (role.is_system) {
      showMsg('System roles cannot be deleted');
      return;
    }
    if (!window.confirm(`Delete role "${role.name}"?`)) return;
    try {
      await actions.deleteRole(role.id);
      showMsg('Role deleted');
    } catch (err) {
      showMsg(err.message || 'Could not delete role');
    }
  };

  const createNew = async () => {
    setCreating(true);
    try {
      const row = await actions.createRole({
        name: 'New role',
        permissions: [],
        notificationDefaults: {},
      });
      setEditing(row);
    } catch (err) {
      showMsg(err.message || 'Could not create role');
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Roles ({roles.length})</h3>
        <button onClick={createNew} disabled={creating} className="btn">
          <Plus size={14} /> New role
        </button>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {roles.map((r) => {
          const userCount = Object.values(state.users || {}).filter(u => u.role === r.id).length;
          const permCount = (r.permissions || []).includes('*') ? 'all' : (r.permissions || []).length;
          const notifOn = Object.values(r.notification_defaults || {}).filter(Boolean).length;
          return (
            <div key={r.id} style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto auto auto',
              alignItems: 'center',
              gap: 12,
              padding: 14,
              background: 'white',
              border: '1px solid ' + BRAND.border,
              borderRadius: 8,
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 15 }}>
                  {r.name}
                  {r.is_system && (
                    <span title="System role — name fixed, members allowed">
                      <Lock size={12} color={BRAND.muted} />
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>
                  {permCount === 'all'
                    ? 'Every permission'
                    : `${permCount} permission${permCount === 1 ? '' : 's'}`}
                  {' · '}
                  {notifOn} notification{notifOn === 1 ? '' : 's'} on
                </div>
              </div>
              <Badge color={userCount ? 'blue' : 'grey'}>
                {userCount} user{userCount === 1 ? '' : 's'}
              </Badge>
              <button
                onClick={() => setEditing(r)}
                aria-label={'Edit role ' + r.name}
                className="btn-icon"
                title="Edit"
              >
                <Edit3 size={14} />
              </button>
              <button
                onClick={() => remove(r)}
                aria-label={'Delete role ' + r.name}
                className="btn-icon is-danger"
                disabled={r.is_system || userCount > 0}
                title={r.is_system ? 'System role cannot be deleted' : userCount > 0 ? 'Reassign users first' : 'Delete role'}
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {editing && (
        <RoleEditor
          role={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
