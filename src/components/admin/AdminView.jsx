import React from 'react';
import { ChevronLeft, Users, Shield, Bell, Wallet, CalendarClock, Percent, Plane, FileText } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { permissionsInclude } from '../../lib/permissions.js';
import { UsersTab } from './UsersTab.jsx';
import { RolesTab } from './RolesTab.jsx';
import { NotificationsTab } from './NotificationsTab.jsx';
import { StorageTab } from './StorageTab.jsx';
import { IntroCallRulesTab } from './IntroCallRulesTab.jsx';
import { StaffCommissionTab } from './StaffCommissionTab.jsx';
import { HolidayTab } from './HolidayTab.jsx';
import { DefaultProposalTab } from './DefaultProposalTab.jsx';

const TABS = [
  { id: 'users',         label: 'Users + invites',  icon: Users,    perm: 'users.manage' },
  { id: 'roles',         label: 'Roles',            icon: Shield,   perm: 'roles.manage' },
  { id: 'notifications', label: 'Notifications',    icon: Bell,     perm: 'users.manage' },
  { id: 'storage',       label: 'Storage & CRM costs', icon: Wallet, perm: 'finance.manage' },
  { id: 'commission',    label: 'Staff Commission', icon: Percent,  perm: ['commission.manage', 'commission.view_own'] },
  { id: 'holiday',       label: 'Holiday',          icon: Plane,    perm: ['schedule.manage_allowance', 'schedule.manage'] },
  { id: 'intro-calls',   label: 'Intro call rules', icon: CalendarClock, perm: 'settings.manage' },
  { id: 'proposals', label: 'Proposals', icon: FileText, perm: 'settings.manage' },
];

// A tab is visible if the caller holds its permission — `perm` may be a single
// slug or an array (any of).
const tabVisible = (perms, perm) =>
  Array.isArray(perm) ? perm.some((p) => permissionsInclude(perms, p)) : permissionsInclude(perms, perm);

export function AdminView({ tab = 'users', onBack, onChangeTab, onEditDefault, onCreateTemplate, onEditTemplate }) {
  const { state } = useStore();
  const session = state.session;
  const permissions = session?.permissions || [];
  const visibleTabs = TABS.filter(t => tabVisible(permissions, t.perm));

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

      <div
        className="hide-scrollbar"
        style={{
          background: 'white',
          borderBottom: '1px solid ' + BRAND.border,
          padding: '0 16px',
          display: 'flex',
          gap: 4,
          // Scroll the tab strip itself instead of the whole page: without this
          // the five buttons lay out wider than a phone and drag the entire page
          // sideways. flexShrink:0 + nowrap on the buttons keep them full-size.
          overflowX: 'auto',
          flexWrap: 'nowrap',
          WebkitOverflowScrolling: 'touch',
        }}
      >
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
                flexShrink: 0,
                whiteSpace: 'nowrap',
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
        {active?.id === 'storage' && <StorageTab />}
        {active?.id === 'commission' && <StaffCommissionTab />}
        {active?.id === 'holiday' && <HolidayTab />}
        {active?.id === 'intro-calls' && <IntroCallRulesTab />}
        {active?.id === 'proposals' && <DefaultProposalTab onEditDefault={onEditDefault} onCreateTemplate={onCreateTemplate} onEditTemplate={onEditTemplate} />}
      </div>
    </div>
  );
}
