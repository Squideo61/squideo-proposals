import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Clapperboard, CheckSquare, Coins, Contact, FileText, KanbanSquare, Mail, MailQuestion, Settings, Trophy } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { permissionsInclude } from '../../lib/permissions.js';
import { Logo } from '../ui.jsx';
import { NotificationBell } from '../NotificationBell.jsx';

const BADGE = '#FB923C';

// Persistent Xero-style top bar shown across every CRM view. Navigation is
// grouped into three section dropdowns (Business / Sales / Projects); Admin,
// Account and "New Proposal" sit as standalone utilities on the right.
export function CrmTopBar({ view, navigate, onManageAccount, onOpenLink }) {
  const { state } = useStore();
  const isMobile = useIsMobile();
  const [openMenu, setOpenMenu] = useState(null);
  const navRef = useRef(null);

  const sessionUser = state.session || {};
  const userRecord = state.users?.[sessionUser?.email];
  const user = {
    ...sessionUser,
    avatar: sessionUser?.avatar ?? userRecord?.avatar ?? null,
    name: sessionUser?.name || userRecord?.name || '',
  };
  const perms = user.permissions;

  // Notification counts — lifted verbatim from the old ListView header.
  const openTasksDue = (state.tasks || []).filter(t => !t.doneAt && t.dueAt && new Date(t.dueAt).getTime() <= Date.now() + 24 * 60 * 60 * 1000).length;
  const triageCount = (state.triage || []).length;
  const newQuoteRequestsCount = (state.quoteRequests || []).filter(q => q.status === 'new').length;

  const canRevisions = permissionsInclude(perms, 'revisions.access');
  const canAdmin = permissionsInclude(perms, 'users.manage')
    || permissionsInclude(perms, 'roles.manage')
    || permissionsInclude(perms, 'settings.manage');

  const sections = [
    {
      key: 'business',
      label: 'Business',
      views: ['contacts', 'contact', 'company', 'xero-duplicates', 'tasks', 'emails', 'triage', 'partner-credits', 'partner-credit-detail'],
      items: [
        { label: 'Contacts', icon: Contact, go: () => navigate('contacts') },
        { label: 'Tasks', icon: CheckSquare, go: () => navigate('tasks'), count: openTasksDue },
        { label: 'Emails', icon: Mail, go: () => navigate('emails'), count: triageCount },
        { label: 'Partner Credits', icon: Coins, go: () => navigate('partner-credits') },
      ],
    },
    {
      key: 'sales',
      label: 'Sales',
      views: ['list', 'pipeline', 'deal', 'quote-requests', 'templates', 'leaderboard'],
      items: [
        { label: 'Quote Requests', icon: MailQuestion, go: () => navigate('quote-requests'), count: newQuoteRequestsCount },
        { label: 'Proposals', icon: FileText, go: () => navigate('list') },
        { label: 'Pipeline', icon: KanbanSquare, go: () => navigate('pipeline') },
        { label: 'Leaderboard', icon: Trophy, go: () => navigate('leaderboard') },
      ],
    },
    {
      key: 'projects',
      label: 'Projects',
      views: ['revisions'],
      items: [
        ...(canRevisions ? [{ label: 'Revisions', icon: Clapperboard, go: () => navigate('revisions') }] : []),
      ],
    },
  ].filter(s => s.items.length > 0);

  const activeSection = sections.find(s => s.views.includes(view))?.key;

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e) => { if (navRef.current && !navRef.current.contains(e.target)) setOpenMenu(null); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [openMenu]);

  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 100, background: 'white', borderBottom: '1px solid ' + BRAND.border }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: isMobile ? '0 12px' : '0 24px', height: 56 }}>
        <button
          onClick={() => navigate('list')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginRight: 6, color: BRAND.ink }}
        >
          <Logo size={28} />
          {!isMobile && <span style={{ fontSize: 17, fontWeight: 700 }}>Squideo</span>}
        </button>

        <nav ref={navRef} style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          {sections.map((s) => {
            const isActive = activeSection === s.key;
            const isOpen = openMenu === s.key;
            const hasBadge = s.items.some(i => i.count > 0);
            return (
              <div key={s.key} style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setOpenMenu(isOpen ? null : s.key)}
                  aria-haspopup="menu"
                  aria-expanded={isOpen}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '8px 12px', border: 'none', borderRadius: 8, cursor: 'pointer',
                    fontSize: 14, fontWeight: isActive ? 600 : 500, color: BRAND.ink,
                    background: (isActive || isOpen) ? '#EEF3F6' : 'transparent',
                  }}
                >
                  {s.label}
                  {hasBadge && <span style={{ width: 7, height: 7, borderRadius: '50%', background: BADGE }} />}
                  <ChevronDown size={14} style={{ opacity: 0.6 }} />
                </button>
                {isOpen && (
                  <div
                    role="menu"
                    style={{
                      position: 'absolute', top: 'calc(100% + 6px)', left: 0,
                      background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10,
                      boxShadow: '0 8px 24px rgba(15, 42, 61, 0.12)', minWidth: 224, padding: 6,
                      zIndex: 50, display: 'flex', flexDirection: 'column', gap: 2,
                    }}
                  >
                    {s.items.map((item) => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.label}
                          type="button"
                          role="menuitem"
                          onClick={() => { item.go(); setOpenMenu(null); }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                            padding: '8px 10px', border: 'none', background: 'transparent', borderRadius: 8,
                            cursor: 'pointer', fontSize: 14, color: BRAND.ink, textAlign: 'left',
                          }}
                        >
                          <Icon size={15} color={BRAND.muted} />
                          <span style={{ flex: 1 }}>{item.label}</span>
                          {item.count > 0 && (
                            <span style={{ background: BADGE, color: 'white', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999 }}>
                              {item.count}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div style={{ flex: 1 }} />

        <NotificationBell onOpenLink={onOpenLink} inline />
        {canAdmin && (
          <button onClick={() => navigate('admin', 'users')} className="btn-ghost" title="Admin">
            <Settings size={14} />{!isMobile && ' Admin'}
          </button>
        )}
        <button
          onClick={onManageAccount}
          className="btn-ghost"
          title="Account"
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px 4px 6px', borderRadius: 20 }}
        >
          {user.avatar
            ? <img src={user.avatar} alt={user.name} style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }} />
            : <div style={{ width: 24, height: 24, borderRadius: '50%', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 11 }}>{(user.name || '?')[0].toUpperCase()}</div>}
          {!isMobile && 'Account'}
        </button>
      </div>
    </div>
  );
}
