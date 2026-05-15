import React, { useMemo, useState } from 'react';
import { X, Save } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Modal, Field } from '../ui.jsx';
import { PERMISSIONS } from '../../lib/permissions.js';
import { NOTIFICATIONS } from '../../lib/notifications.js';

// Group permissions / notifications by their `group` field so the editor
// renders a tidy nested checkbox list rather than 15 flat rows.
function groupBy(list, key) {
  const out = {};
  for (const item of list) {
    const g = item[key] || 'Other';
    if (!out[g]) out[g] = [];
    out[g].push(item);
  }
  return out;
}

export function RoleEditor({ role, onClose }) {
  const { actions, showMsg } = useStore();
  const isSystem = !!role?.is_system;

  const [name, setName] = useState(role?.name || '');
  const initialPermissions = role?.permissions || [];
  const [grantAll, setGrantAll] = useState(initialPermissions.includes('*'));
  const [permSet, setPermSet] = useState(new Set(initialPermissions.filter(p => p !== '*')));
  const [notifDefaults, setNotifDefaults] = useState(role?.notification_defaults || {});
  const [saving, setSaving] = useState(false);

  const permGroups = useMemo(() => groupBy(PERMISSIONS, 'group'), []);
  const notifGroups = useMemo(() => groupBy(NOTIFICATIONS, 'group'), []);

  const togglePerm = (slug) => {
    setPermSet(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const toggleNotif = (key) => {
    setNotifDefaults(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const save = async () => {
    if (!name.trim()) {
      showMsg('Role name is required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        permissions: grantAll ? ['*'] : Array.from(permSet),
        notificationDefaults: notifDefaults,
      };
      await actions.saveRole(role.id, payload);
      showMsg(`Role "${payload.name}" saved`);
      onClose && onClose();
    } catch (err) {
      showMsg(err.message || 'Could not save role');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={780}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
          Edit role{isSystem ? ' (system)' : ''}
        </h3>
        <button onClick={onClose} aria-label="Close" className="btn-icon"><X size={14} /></button>
      </div>

      <Field label="Name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sales Manager"
        />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 12 }}>
        {/* Permissions */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Permissions</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10, background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 8, marginBottom: 12, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={grantAll}
              onChange={(e) => setGrantAll(e.target.checked)}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Grant every permission</div>
              <div style={{ fontSize: 11, color: BRAND.muted }}>
                Future permissions added in updates will be auto-granted.
              </div>
            </div>
          </label>
          {!grantAll && (
            <div style={{ display: 'grid', gap: 12 }}>
              {Object.entries(permGroups).map(([group, items]) => (
                <div key={group}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{group}</div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    {items.map(p => (
                      <label key={p.slug} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 4px', fontSize: 13, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={permSet.has(p.slug)}
                          onChange={() => togglePerm(p.slug)}
                          style={{ marginTop: 3 }}
                        />
                        <span>{p.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Notification defaults */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Default notifications</div>
          <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 10 }}>
            What members of this role get by default. Individuals can override
            each one in their own account settings.
          </div>
          <div style={{ display: 'grid', gap: 12 }}>
            {Object.entries(notifGroups).map(([group, items]) => (
              <div key={group}>
                <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{group}</div>
                <div style={{ display: 'grid', gap: 4 }}>
                  {items.map(n => (
                    <label key={n.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 4px', fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={!!notifDefaults[n.key]}
                        onChange={() => toggleNotif(n.key)}
                        style={{ marginTop: 3 }}
                      />
                      <div>
                        <div>{n.label}</div>
                        <div style={{ fontSize: 11, color: BRAND.muted }}>{n.description}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20, borderTop: '1px solid ' + BRAND.border, paddingTop: 16 }}>
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={save} disabled={saving} className="btn">
          <Save size={14} /> {saving ? 'Saving…' : 'Save role'}
        </button>
      </div>
    </Modal>
  );
}
