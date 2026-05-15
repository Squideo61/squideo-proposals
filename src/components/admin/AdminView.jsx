import React from 'react';
import { ChevronLeft, Users, Shield, Bell } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { permissionsInclude } from '../../lib/permissions.js';
import { UsersTab } from './UsersTab.jsx';
import { RolesTab } from './RolesTab.jsx';
import { NotificationsTab } from './NotificationsTab.jsx';

const TABS = [
  { id: 'users',         label: 'Users + invites',  icon: Users,  perm: 'users.manage' },
  { id: 'roles',         label: 'Roles',            icon: Shield, perm: 'roles.manage' },
  { id: 'notifications', label: 'Notifications',    icon: Bell,   perm: 'users.manage' },
];

export function AdminView({ tab = 'users', onBack, onChangeTab }) {
  const { state } = useStore();
  const session = state.session;
  const permissions = session?.permissions || [];
  const visibleTabs = TABS.filter(t => permissionsInclude(permissions, t.perm));

  // If the requested tab isn't visible to the caller, fall through to the
  // first one they can see. Prevents a deep link from rendering a blank
  // section when permissions don't match.
  const active = visibleTabs.find(t => t.id === tab) || visibleTabs[0];

  if (visibleTabs.length === 0) {
    return (
      <div style={{ padding: 40, maxWidth: 600, margin: '0 auto' }}>
        <button onClick={onBack} className="btn-ghost" style={{ marginBottom: 16 }}>
          <ChevronLeft size={16} /> Back
        </button>
        <div style={{
          padding: 24,
          background: '#FEF3C7',
          border: '1px solid #FCD34D',
          borderRadius: 10,
          color: '#92400E',
          fontSize: 14,
        }}>
          You don't have access to the admin section. Ask a workspace admin to
          grant you the relevant permissions.
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: BRAND.paper }}>
      <div style={{
        background: 'white',
        borderBottom: '1px solid ' + BRAND.border,
        padding: '16px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
      }}>
        <button onClick={onBack} className="btn-ghost">
          <ChevronLeft size={16} /> Back
        </button>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Admin</h1>
      </div>

      <div style={{
        background: 'white',
        borderBottom: '1px solid ' + BRAND.border,
        padding: '0 24px',
        display: 'flex',
        gap: 4,
      }}>
        {visibleTabs.map((t) => {
          const Icon = t.icon;
          const isActive = active?.id === t.id;
          return (
            <button
              key={t.id}
              onClick={() => onChangeTab && onChangeTab(t.id)}
              style={{
                padding: '12px 16px',
                background: 'transparent',
                border: 'none',
                borderBottom: '2px solid ' + (isActive ? BRAND.blue : 'transparent'),
                color: isActive ? BRAND.blue : BRAND.ink,
                fontWeight: isActive ? 700 : 500,
                fontSize: 14,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: -1,
              }}
            >
              <Icon size={16} />
              {t.label}
            </button>
          );
        })}
      </div>

      <div style={{ padding: '24px', maxWidth: 1100, margin: '0 auto' }}>
        {active?.id === 'users' && <UsersTab />}
        {active?.id === 'roles' && <RolesTab />}
        {active?.id === 'notifications' && <NotificationsTab />}
      </div>
    </div>
  );
}
