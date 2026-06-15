import React, { useEffect, useRef, useState } from 'react';
import { BarChart3, ChevronDown, Clapperboard, CheckSquare, Coins, FileText, Images, KanbanSquare, LayoutDashboard, LayoutGrid, Mail, MailQuestion, Megaphone, PoundSterling, Settings, Trophy, Undo2, Redo2, UserCog } from 'lucide-react';
import { BRAND, APP_MAX_WIDTH } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { permissionsInclude } from '../../lib/permissions.js';
import { Logo } from '../ui.jsx';
import { NotificationBell } from '../NotificationBell.jsx';

const BADGE = '#FB923C';

// Persistent Xero-style top bar shown across every CRM view. Navigation is
// grouped into three section dropdowns (Business / Sales / Projects); Admin,
// Account and "New Proposal" sit as standalone utilities on the right.
// `producer` renders a stripped bar for the producer/copywriter shell: logo +
// Tasks + notification bells + Account, with no Sales/Business/Projects nav or
// Emails (those views don't exist in that shell). Gives producers the header and
// notification bells they'd otherwise be missing entirely.
export function CrmTopBar({ view, fullWidth, navigate, onManageAccount, onOpenLink, producer = false, marketing = false }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const undoStack = state.undoStack || [];
  const redoStack = state.redoStack || [];
  const nextUndo = undoStack[undoStack.length - 1];
  const nextRedo = redoStack[redoStack.length - 1];
  const [openMenu, setOpenMenu] = useState(null);
  const navRef = useRef(null);
  const accountRef = useRef(null);

  const sessionUser = state.session || {};
  const userRecord = state.users?.[sessionUser?.email];
  const user = {
    ...sessionUser,
    avatar: sessionUser?.avatar ?? userRecord?.avatar ?? null,
    name: sessionUser?.name || userRecord?.name || '',
  };
  const perms = user.permissions;

  // Notification counts — lifted verbatim from the old ListView header.
  // Badge counts the user's own open tasks that are due today OR overdue — i.e.
  // anything whose due time is at/before the end of today, so it both reflects
  // today's workload and nags about a stale backlog. Future tasks don't count.
  // Scoped to the signed-in user's own tasks: Admins load the whole workspace's
  // tasks into state.tasks, but the pill should only reflect their own.
  const myEmail = (sessionUser?.email || '').toLowerCase();
  const isMyTask = (t) => {
    const emails = Array.isArray(t.assigneeEmails) && t.assigneeEmails.length
      ? t.assigneeEmails
      : (t.assigneeEmail ? [t.assigneeEmail] : []);
    return emails.some(e => String(e).toLowerCase() === myEmail);
  };
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  const openTasksDue = (state.tasks || []).filter((t) => (
    isMyTask(t) && !t.doneAt && t.dueAt && new Date(t.dueAt).getTime() <= endOfToday.getTime()
  )).length;
  // The Emails badge mirrors Gmail's inbox unread count (matches the Inbox
  // folder badge inside the Emails view). Needs the mailbox labels loaded, so we
  // fetch them once the account is connected (the Emails view also refreshes
  // them on open).
  const gmailConnected = !!state.gmailAccount?.connected;
  const inboxUnread = state.mailboxLabels?.INBOX?.threadsUnread || 0;
  useEffect(() => { if (gmailConnected) actions.loadMailboxLabels(); }, [gmailConnected]); // eslint-disable-line react-hooks/exhaustive-deps
  const newQuoteRequestsCount = (state.quoteRequests || []).filter(q => q.status === 'new').length;

  const canRevisions = permissionsInclude(perms, 'revisions.access');
  const canProduction = permissionsInclude(perms, 'production.access');
  // Quote Requests page is API-gated by quote_requests.manage; hide the nav item
  // for roles without it (e.g. producers, copywriters) so they don't land on a
  // page that 403s and looks empty/broken.
  const canQuoteRequests = permissionsInclude(perms, 'quote_requests.manage');
  const canAdmin = permissionsInclude(perms, 'users.manage')
    || permissionsInclude(perms, 'roles.manage')
    || permissionsInclude(perms, 'settings.manage');
  // Whole-business finances — anyone with finance.manage (owner/admin + Director).
  const canBusiness = permissionsInclude(perms, 'finance.manage');
  // Marketing (lead attribution + ad ROAS) — Admin / whoever's granted it.
  const canMarketing = permissionsInclude(perms, 'marketing.access');
  // The £ (sales & finance) notifications bell — Admin, Directors, Project Managers.
  const canFinanceBell = permissionsInclude(perms, 'finance.notifications');

  const sections = [
    {
      key: 'business',
      label: 'Business',
      views: ['overview', 'finance', 'performance'],
      items: [
        { label: 'Overview', icon: LayoutDashboard, go: () => navigate('overview') },
        ...(canBusiness ? [
          { label: 'Finance', icon: PoundSterling, go: () => navigate('finance') },
        ] : []),
      ],
    },
    {
      key: 'marketing',
      label: 'Marketing',
      views: ['marketing'],
      items: canMarketing ? [
        { label: 'Dashboard', icon: LayoutDashboard, go: () => navigate('marketing', 'overview') },
        { label: 'Reports', icon: BarChart3, go: () => navigate('marketing', 'reports') },
        { label: 'Leads', icon: MailQuestion, go: () => navigate('marketing', 'leads') },
        { label: 'Settings', icon: Megaphone, go: () => navigate('marketing', 'settings') },
      ] : [],
    },
    {
      key: 'sales',
      label: 'Sales',
      views: ['list', 'pipeline', 'deal', 'quote-requests', 'templates', 'leaderboard'],
      items: [
        ...(canQuoteRequests ? [{ label: 'Quote Requests', icon: MailQuestion, go: () => navigate('quote-requests'), count: newQuoteRequestsCount }] : []),
        { label: 'Proposals', icon: FileText, go: () => navigate('list') },
        { label: 'Sales Pipeline', icon: KanbanSquare, go: () => navigate('pipeline') },
        { label: 'Leaderboard', icon: Trophy, go: () => navigate('leaderboard') },
      ],
    },
    {
      key: 'projects',
      label: 'Projects',
      views: ['production', 'projects', 'project', 'video', 'storyboards', 'revisions', 'partner-credits', 'partner-credit-detail'],
      items: [
        ...(canProduction ? [{ label: 'Projects', icon: LayoutGrid, go: () => navigate('projects') }] : []),
        ...(canProduction ? [{ label: 'Production board', icon: KanbanSquare, go: () => navigate('production') }] : []),
        ...(canRevisions ? [{ label: 'Storyboard Revisions', icon: Images, go: () => navigate('storyboards') }] : []),
        ...(canRevisions ? [{ label: 'Video Revisions', icon: Clapperboard, go: () => navigate('revisions') }] : []),
        { label: 'Partners & Credits', icon: Coins, go: () => navigate('partner-credits') },
      ],
    },
  ].filter(s => s.items.length > 0);

  const activeSection = sections.find(s => s.views.includes(view))?.key;
  const contactsActive = ['contacts', 'contact', 'company', 'xero-duplicates'].includes(view);

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e) => {
      const inNav = navRef.current && navRef.current.contains(e.target);
      const inAccount = accountRef.current && accountRef.current.contains(e.target);
      if (!inNav && !inAccount) setOpenMenu(null);
    };
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: isMobile ? '0 12px' : '0 24px', height: 56, maxWidth: fullWidth ? 'none' : APP_MAX_WIDTH, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <button
          onClick={() => navigate(producer ? 'production' : marketing ? 'marketing' : 'list')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginRight: 6, color: BRAND.ink }}
        >
          <Logo size={28} />
          {!isMobile && <span style={{ fontSize: 17, fontWeight: 700 }}>Squideo</span>}
        </button>

        {!producer && (
        <nav ref={navRef} style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          {(marketing ? sections.filter((s) => s.key === 'marketing') : sections).map((s) => {
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
                          {item.soon && (
                            <span style={{ background: '#EEF1F4', color: BRAND.muted, fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                              Soon
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
          {!marketing && (
          <button
            type="button"
            onClick={() => navigate('contacts')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 12px', border: 'none', borderRadius: 8, cursor: 'pointer',
              fontSize: 14, fontWeight: contactsActive ? 600 : 500, color: BRAND.ink,
              background: contactsActive ? '#EEF3F6' : 'transparent',
            }}
          >
            Contacts
          </button>
          )}
        </nav>
        )}

        <div style={{ flex: 1 }} />

        {/* CRM-wide undo / redo. Tooltips name the next reversible action. */}
        {!marketing && (
        <div style={{ display: 'inline-flex', alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => actions.undo()}
            disabled={!nextUndo || state.undoBusy}
            className="btn-ghost"
            title={nextUndo ? `Undo: ${nextUndo.label} (Ctrl+Z)` : 'Nothing to undo'}
            style={{ padding: '6px 8px', opacity: nextUndo ? 1 : 0.4, cursor: nextUndo ? 'pointer' : 'default' }}
          >
            <Undo2 size={16} />
          </button>
          <button
            type="button"
            onClick={() => actions.redo()}
            disabled={!nextRedo || state.undoBusy}
            className="btn-ghost"
            title={nextRedo ? `Redo: ${nextRedo.label} (Ctrl+Shift+Z)` : 'Nothing to redo'}
            style={{ padding: '6px 8px', opacity: nextRedo ? 1 : 0.4, cursor: nextRedo ? 'pointer' : 'default' }}
          >
            <Redo2 size={16} />
          </button>
        </div>
        )}

        {!marketing && [
          { label: 'Tasks', icon: CheckSquare, views: ['tasks'], go: () => navigate('tasks'), count: openTasksDue },
          // Emails inbox view doesn't exist in the producer shell.
          ...(producer ? [] : [{ label: 'Emails', icon: Mail, views: ['emails', 'triage', 'email'], go: () => navigate('emails'), count: inboxUnread }]),
        ].map((item) => {
          const Icon = item.icon;
          const active = item.views.includes(view);
          return (
            <button
              key={item.label}
              type="button"
              onClick={item.go}
              className="btn-ghost"
              title={item.label}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: active ? '#EEF3F6' : undefined }}
            >
              <Icon size={16} />
              {!isMobile && <span>{item.label}</span>}
              {item.count > 0 && (
                <span style={{ background: BADGE, color: 'white', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999 }}>{item.count}</span>
              )}
            </button>
          );
        })}

        {/* Eye bell (engagement tracking) sits left of the £ bell. Its contents
            are owner-scoped, so it's shown to everyone — empty for anyone who
            hasn't sent tracked emails / owns no proposals. */}
        {!marketing && <NotificationBell onOpenLink={onOpenLink} inline channel="tracking" />}
        {!marketing && canFinanceBell && <NotificationBell onOpenLink={onOpenLink} inline channel="finance" />}
        {!marketing && <NotificationBell onOpenLink={onOpenLink} inline />}

        <div ref={accountRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setOpenMenu(openMenu === 'account' ? null : 'account')}
            className="btn-ghost"
            title="Account"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'account'}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px 4px 6px', borderRadius: 20 }}
          >
            {user.avatar
              ? <img src={user.avatar} alt={user.name} style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }} />
              : <div style={{ width: 24, height: 24, borderRadius: '50%', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 11 }}>{(user.name || '?')[0].toUpperCase()}</div>}
            {!isMobile && 'Account'}
            <ChevronDown size={14} style={{ opacity: 0.6 }} />
          </button>
          {openMenu === 'account' && (
            <div
              role="menu"
              style={{
                position: 'absolute', top: 'calc(100% + 6px)', right: 0,
                background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10,
                boxShadow: '0 8px 24px rgba(15, 42, 61, 0.12)', minWidth: 200, padding: 6,
                zIndex: 50, display: 'flex', flexDirection: 'column', gap: 2,
              }}
            >
              {[
                { label: 'Account settings', icon: UserCog, go: () => onManageAccount(), show: true },
                { label: 'Admin', icon: Settings, go: () => navigate('admin', 'users'), show: canAdmin },
              ].filter(i => i.show).map((item) => {
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
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
