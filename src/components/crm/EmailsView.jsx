import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Mail, Inbox, Send, FileText, Star, ShieldAlert, Trash2, Archive,
  Search, X, RefreshCw, MailOpen, Reply, ReplyAll, Forward, Paperclip, Download,
  Briefcase, PenSquare, ExternalLink, ChevronDown, CircleDot,
  Users, Info, MessagesSquare, Tag, Settings,
} from 'lucide-react';
import DOMPurify from 'dompurify';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatMailDate, formatRelativeTime, useIsMobile } from '../../utils.js';
import { DealContextPanel } from './DealContextPanel.jsx';
import { EmailComposerModal } from './DealDetailView.jsx';
import { TrackingEye, TrackingBanner } from './EmailTracking.jsx';
import { STAGE_COLOURS, STAGE_LABEL } from '../../lib/stages.js';

// 'deals' + 'triage' are DB-backed (CRM-aware); the rest proxy live to Gmail
// via /api/crm/gmail/folder. kind drives which store action loads each folder.
const FOLDERS = [
  { id: 'deals',   label: 'Deals',    icon: Briefcase,   kind: 'deals'  },
  { id: 'inbox',   label: 'Inbox',    icon: Mail,        kind: 'gmail'  },
  { id: 'unread',  label: 'Unread',   icon: CircleDot,   kind: 'gmail'  },
  { id: 'sent',    label: 'Sent',     icon: Send,        kind: 'gmail'  },
  { id: 'drafts',  label: 'Drafts',   icon: FileText,    kind: 'gmail'  },
  { id: 'starred', label: 'Starred',  icon: Star,        kind: 'gmail'  },
  { id: 'spam',    label: 'Spam',     icon: ShieldAlert, kind: 'gmail'  },
  { id: 'trash',   label: 'Trash',    icon: Trash2,      kind: 'gmail'  },
  { id: 'all',     label: 'All Mail', icon: Archive,     kind: 'gmail'  },
];
// Gmail's smart categories. Shown only when the connected account actually uses
// them (inferred from label counts) — otherwise the mailbox is unchanged, just
// like Gmail hides the tabs when they're off.
const CATEGORY_FOLDERS = [
  { id: 'social',     label: 'Social',     icon: Users,          kind: 'gmail', categoryLabel: 'CATEGORY_SOCIAL' },
  { id: 'updates',    label: 'Updates',    icon: Info,           kind: 'gmail', categoryLabel: 'CATEGORY_UPDATES' },
  { id: 'forums',     label: 'Forums',     icon: MessagesSquare, kind: 'gmail', categoryLabel: 'CATEGORY_FORUMS' },
  { id: 'promotions', label: 'Promotions', icon: Tag,            kind: 'gmail', categoryLabel: 'CATEGORY_PROMOTIONS' },
];
const FOLDER_BY_ID = Object.fromEntries([...FOLDERS, ...CATEGORY_FOLDERS].map(f => [f.id, f]));

// List row density (Gmail-style). Drives the vertical padding of list rows.
const DENSITY_KEY = 'squideo.emails.density';
const UNREAD_ONLY_KEY = 'squideo.emails.unreadOnly';
const DENSITY_OPTIONS = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'default',     label: 'Default'     },
  { id: 'compact',     label: 'Compact'     },
];
const ROW_VPAD = { comfortable: '14px', default: '7px', compact: '2px' };
const vpad = (d) => ROW_VPAD[d] || ROW_VPAD.default;

// Slim version of .btn-icon used for the per-row quick actions, so the action
// icons don't set the row height and rows stay tight (Gmail-style).
const SLIM_ROW_BTN = { padding: 4 };

// DOMPurify config mirrors the deal-detail email viewer: permissive enough to
// render real mail (images, links, tables) but strips scripts/inline handlers.
const VIEW_SANITIZE = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
};
const sanitizeBody = (html) => (html ? DOMPurify.sanitize(html, VIEW_SANITIZE) : null);

// Build the quoted source for a reply/forward. The composer renders the quote
// without the original email's CSS, so anything the sender hid with CSS
// (preheaders, tracking/metadata blocks like emailMetaData={…}) would otherwise
// resurface as visible text. Gmail keeps it hidden; we strip those nodes out
// entirely before quoting so they never appear.
const quoteSourceHtml = (html) => {
  if (!html) return '';
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return sanitizeBody(html) || '';
  }
  doc.querySelectorAll('style, script, link, meta, title').forEach(el => el.remove());
  doc.querySelectorAll('[hidden], [aria-hidden="true"]').forEach(el => el.remove());
  doc.querySelectorAll('[style]').forEach(el => {
    const s = (el.getAttribute('style') || '').toLowerCase().replace(/\s+/g, '');
    if (s.includes('display:none')
      || s.includes('visibility:hidden')
      || s.includes('opacity:0')
      || /(^|;)max-height:0(px)?(;|$)/.test(s)
      || /(^|;)font-size:0(px)?(;|$)/.test(s)) {
      el.remove();
    }
  });
  return sanitizeBody(doc.body ? doc.body.innerHTML : html) || '';
};

// Sanitizer for the full message viewer, which renders inside a sandboxed
// iframe (see EmailFrame). Unlike VIEW_SANITIZE we KEEP <style> blocks and
// inline style attributes so the email looks the way the sender intended —
// the iframe isolates that CSS from the rest of the app. Scripts, handlers
// and other active content are still stripped (and the sandbox blocks JS too).
const FRAME_SANITIZE = {
  USE_PROFILES: { html: true },
  ADD_TAGS: ['style'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick'],
};

export function EmailsView({ folder = 'inbox', openThreadId = null, onBack, onOpenDeal, onOpenProposal, onSelectFolder, onOpenThread, onCloseThread }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const active = FOLDER_BY_ID[folder] ? folder : 'inbox';
  const def = FOLDER_BY_ID[active];

  // Gmail's smart categories appear only when the account actually uses them
  // (any category label carries mail). Otherwise the mailbox is unchanged.
  const categoriesEnabled = CATEGORY_FOLDERS.some(
    f => (state.mailboxLabels?.[f.categoryLabel]?.threadsTotal || 0) > 0
  );
  const folders = categoriesEnabled ? [...FOLDERS, ...CATEGORY_FOLDERS] : FOLDERS;

  const connected = !!(state.gmailAccount && state.gmailAccount.connected);
  const [search, setSearch] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(() => {
    try { return localStorage.getItem(UNREAD_ONLY_KEY) === '1'; } catch { return false; }
  });
  const [openRef, setOpenRef] = useState(null);     // { kind, threadId, unread } for the conversation modal
  const [density, setDensity] = useState(() => {
    try { return localStorage.getItem(DENSITY_KEY) || 'default'; } catch { return 'default'; }
  });
  const changeDensity = (d) => {
    setDensity(d);
    try { localStorage.setItem(DENSITY_KEY, d); } catch { /* ignore */ }
  };

  useEffect(() => { setSearch(''); setAppliedQuery(''); }, [active]);

  // The open conversation is driven entirely by the URL (openThreadId), so the
  // browser Back button returns to the folder list instead of leaving Emails.
  // The thread's kind is implied by its folder: Gmail folders carry live thread
  // ids; the Deals/Triage folders carry DB-backed gmailThreadIds. unread comes
  // from the loaded row (so opening marks it read) — unknown for a cold deep
  // link, which is fine.
  useEffect(() => {
    if (!openThreadId) { setOpenRef(null); return; }
    const kind = def.kind === 'gmail' ? 'gmail' : 'db';
    const unread = kind === 'gmail'
      ? !!(state.mailbox?.[active]?.rows || []).find((r) => r.id === openThreadId)?.unread
      : false;
    setOpenRef({ kind, threadId: openThreadId, unread });
  }, [openThreadId, active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (def.kind === 'deals') {
      if (!state.mailbox?.deals?.loaded) actions.loadDealEmails();
    } else if (def.kind === 'triage') {
      actions.refreshTriage();
    } else if (def.kind === 'gmail' && connected) {
      // Always (re)load on entering a folder so freshly sent/received mail shows
      // without a manual refresh. A cold folder shows a spinner; an already-
      // loaded one keeps its cached rows on screen and silently swaps them for
      // the live page when it arrives (Body only spins when rows is empty), so
      // revisiting Sent never shows a days-old snapshot.
      actions.loadMailboxFolder(active, { unread: unreadOnly });
    }
  }, [active, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live search: search the mailbox as the user types (Gmail folders), debounced
  // so we don't hit Gmail on every keystroke. Enter still triggers immediately.
  useEffect(() => {
    if (def.kind !== 'gmail' || !connected) return;
    const q = search.trim();
    if (q === appliedQuery) return;
    const t = setTimeout(() => {
      setAppliedQuery(q);
      actions.loadMailboxFolder(active, { q, unread: unreadOnly });
    }, 350);
    return () => clearTimeout(t);
  }, [search, active, connected, def.kind, appliedQuery, unreadOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (connected) actions.loadMailboxLabels(); }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const slice = state.mailbox?.[active] || {};
  const rawRowsForResolve = def.kind === 'triage' ? [] : (slice.rows || []);
  // Resolve which deal(s) each visible conversation belongs to (extension-style
  // chips). Skips threads already resolved; re-runs as rows load / paginate.
  useEffect(() => {
    if (def.kind === 'triage') return;
    const items = [];
    for (const r of rawRowsForResolve) {
      const tid = def.kind === 'gmail' ? r.id : r.gmailThreadId;
      if (!tid || state.threadDeals?.[tid] !== undefined) continue;
      const sender = def.kind === 'gmail' ? r.fromEmail : r.lastFrom;
      items.push({ threadId: tid, senderEmails: sender ? [sender] : [] });
    }
    if (items.length) actions.resolveThreadDeals(items);
  }, [rawRowsForResolve, active]); // eslint-disable-line react-hooks/exhaustive-deps
  const rawRows = def.kind === 'triage' ? (state.triage || []) : (slice.rows || []);

  // deals/triage search filters in memory; Gmail folders search server-side.
  const rows = useMemo(() => {
    if (def.kind === 'gmail') return rawRows;
    const q = search.trim().toLowerCase();
    if (!q) return rawRows;
    return rawRows.filter((r) => {
      const hay = [r.subject, r.snippet, r.lastSnippet, r.lastFrom, r.fromEmail, ...(r.toEmails || [])].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [rawRows, search, def.kind]);

  // The search box also finds CRM deals (by deal title, company, contact), not
  // just emails — matched client-side from the store and shown above the email
  // results. Newest activity first.
  const dealResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    const matches = [];
    for (const d of Object.values(state.deals || {})) {
      if (!d) continue;
      const company = d.companyId ? state.companies?.[d.companyId] : null;
      const contact = d.primaryContactId ? state.contacts?.[d.primaryContactId] : null;
      const hay = [d.title, company?.name, company?.website, contact?.name, contact?.email]
        .filter(Boolean).join(' ').toLowerCase();
      if (hay.includes(q)) matches.push(d);
    }
    return matches
      .sort((a, b) => new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0))
      .slice(0, 6);
  }, [search, state.deals, state.companies, state.contacts]);

  const runGmailSearch = () => {
    if (def.kind !== 'gmail' || !connected) return;
    const q = search.trim();
    setAppliedQuery(q);
    actions.loadMailboxFolder(active, { q, unread: unreadOnly });
  };

  const toggleUnreadOnly = () => {
    if (def.kind !== 'gmail' || !connected) return;
    const next = !unreadOnly;
    setUnreadOnly(next);
    try { localStorage.setItem(UNREAD_ONLY_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    actions.loadMailboxFolder(active, { q: appliedQuery, unread: next });
  };

  const refresh = () => {
    if (def.kind === 'deals') actions.loadDealEmails();
    else if (def.kind === 'triage') actions.refreshTriage();
    else if (connected) actions.loadMailboxFolder(active, { q: appliedQuery, unread: unreadOnly });
    if (connected) actions.loadMailboxLabels();
  };

  // Returns the load promise so the list can await it and re-arm auto-loading.
  const loadMore = () => {
    if (slice.loading || slice.next == null) return undefined;
    if (def.kind === 'deals') return actions.loadDealEmails(slice.next);
    if (def.kind === 'gmail') return actions.loadMailboxFolder(active, { pageToken: slice.next, q: appliedQuery, unread: unreadOnly });
    return undefined;
  };

  const compose = () => actions.openComposer({});

  const triageBadge = (state.triage || []).length;
  const badgeFor = (f) => {
    if (f.id === 'triage') return triageBadge || null;
    if (f.id === 'inbox') return state.mailboxLabels?.INBOX?.threadsUnread || null;
    if (f.id === 'unread') return state.mailboxLabels?.UNREAD?.threadsTotal || null;
    if (f.id === 'spam') return state.mailboxLabels?.SPAM?.threadsUnread || null;
    if (f.categoryLabel) return state.mailboxLabels?.[f.categoryLabel]?.threadsUnread || null;
    return null;
  };

  // Back + title row. On desktop it lives at the top of the main column (so the
  // folder sidebar can start at the very top and keep Settings pinned in view);
  // on mobile it sits above everything and also carries Compose + settings,
  // since the sidebar there is a horizontal strip.
  const headerEl = (
    <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
      <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Mail size={22} color={BRAND.blue} /> Emails
      </h1>
      {isMobile && <div style={{ flex: 1 }} />}
      {isMobile && <DensitySettings density={density} onChange={changeDensity} variant="icon" />}
      {isMobile && (
        <button onClick={compose} className="btn"><PenSquare size={14} /> Compose</button>
      )}
    </header>
  );

  return (
    <div style={{ padding: isMobile ? '10px 10px' : '12px 24px' }}>
      {isMobile && headerEl}

      <div style={{ display: 'flex', gap: isMobile ? 0 : 18, alignItems: 'flex-start', flexDirection: isMobile ? 'column' : 'row' }}>
        {/* Folder sidebar — Gmail-style: Compose pinned at the top, folder list,
            then display settings pinned to the bottom of the panel. */}
        <nav style={{
          width: isMobile ? '100%' : 200, flexShrink: 0,
          display: 'flex', flexDirection: isMobile ? 'row' : 'column',
          gap: 2, overflowX: isMobile ? 'auto' : 'visible',
          marginBottom: isMobile ? 12 : 0,
          ...(isMobile ? {} : { position: 'sticky', top: 68, alignSelf: 'flex-start', height: 'calc(100vh - 80px)', overflowY: 'auto' }),
        }}>
          {!isMobile && (
            <button
              onClick={compose}
              className="btn"
              style={{ alignSelf: 'flex-start', padding: '9px 20px', borderRadius: 16, marginBottom: 10, boxShadow: '0 1px 3px rgba(15,42,61,0.18)', flexShrink: 0 }}
            >
              <PenSquare size={16} /> Compose
            </button>
          )}
          {folders.map((f) => {
            const isActive = f.id === active;
            const badge = badgeFor(f);
            const Icon = f.icon;
            return (
              <button
                key={f.id}
                onClick={() => onSelectFolder?.(f.id)}
                title={f.label}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                  border: 'none', borderLeft: isMobile ? 'none' : '3px solid ' + (isActive ? BRAND.blue : 'transparent'),
                  background: isActive ? BRAND.blue + '14' : 'transparent',
                  color: isActive ? BRAND.ink : BRAND.muted,
                  fontWeight: isActive ? 700 : 500, fontSize: 13,
                  fontFamily: 'inherit', whiteSpace: 'nowrap', textAlign: 'left',
                  width: isMobile ? 'auto' : '100%',
                }}
              >
                <Icon size={15} color={isActive ? BRAND.blue : BRAND.muted} />
                <span style={{ flex: 1 }}>{f.label}</span>
                {badge ? (
                  <span style={{ background: '#FB923C', color: 'white', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999 }}>
                    {badge}
                  </span>
                ) : null}
              </button>
            );
          })}
          {!isMobile && (
            <>
              <div style={{ flex: 1, minHeight: 12 }} />
              <DensitySettings density={density} onChange={changeDensity} variant="bar" dropUp />
            </>
          )}
        </nav>

        {/* Main pane */}
        <div style={{ flex: 1, minWidth: 0, width: '100%' }}>
          {!isMobile && headerEl}
          {openRef ? (
            // Open the conversation full-width in the main area (like Gmail),
            // not a pop-up. The folder sidebar stays put; Back returns to list.
            <ConversationView
              openRef={openRef}
              folder={active}
              connected={connected}
              onBack={() => { if (active === 'triage') actions.refreshTriage(); onCloseThread?.(); }}
              onOpenDeal={onOpenDeal}
            />
          ) : (
          <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7 }}>
              <def.icon size={16} color={BRAND.blue} /> {def.label}
            </h2>
            <button onClick={refresh} className="btn-icon" title="Refresh" aria-label="Refresh"><RefreshCw size={15} /></button>
            {def.kind === 'gmail' && active !== 'unread' && active !== 'sent' && active !== 'drafts' && (
              <button
                onClick={toggleUnreadOnly}
                title="Show only unread"
                aria-pressed={unreadOnly}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '5px 10px', borderRadius: 999, cursor: 'pointer', fontSize: 12,
                  fontFamily: 'inherit', fontWeight: 600,
                  border: '1px solid ' + (unreadOnly ? BRAND.blue : BRAND.border),
                  background: unreadOnly ? BRAND.blue + '14' : 'white',
                  color: unreadOnly ? BRAND.blue : BRAND.muted,
                }}
              >
                <CircleDot size={13} /> Unread only
              </button>
            )}
            <div style={{ flex: 1 }} />
            <div style={{ position: 'relative', width: isMobile ? '100%' : 280 }}>
              <Search size={14} color={BRAND.muted} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
              <input
                className="input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runGmailSearch(); }}
                placeholder={def.kind === 'gmail' ? 'Search Gmail…' : 'Filter ' + def.label.toLowerCase() + '…'}
                style={{ paddingLeft: 34, paddingRight: search ? 34 : 12 }}
              />
              {search && (
                <button
                  onClick={() => { setSearch(''); if (def.kind === 'gmail' && appliedQuery) { setAppliedQuery(''); actions.loadMailboxFolder(active, { unread: unreadOnly }); } }}
                  aria-label="Clear search"
                  style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', color: BRAND.muted }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {def.kind === 'deals' && (
            <p style={{ fontSize: 12.5, color: BRAND.muted, margin: '0 0 12px' }}>
              Conversations linked to an active deal, newest first. Emails on Lost deals stay in the Gmail folders.
            </p>
          )}
          {def.kind === 'triage' && (
            <p style={{ fontSize: 12.5, color: BRAND.muted, margin: '0 0 12px' }}>
              Emails that didn't match any deal automatically. Open one to read it and attach it to a deal, or dismiss if it's personal/spam.
            </p>
          )}

          {dealResults.length > 0 && (
            <DealResults deals={dealResults} onOpenDeal={onOpenDeal} />
          )}

          {def.kind === 'gmail' && !connected ? (
            <NotConnected onConnect={() => actions.connectGmail().then((url) => { if (url) window.location.href = url; })} />
          ) : (
            <Body
              def={def}
              rows={rows}
              density={density}
              loading={!!slice.loading}
              error={slice.error}
              onRetry={refresh}
              hasMore={slice.next != null}
              onLoadMore={loadMore}
              onOpen={(row) => onOpenThread?.(active, def.kind === 'gmail' ? row.id : row.gmailThreadId)}
              onDismiss={(row) => { if (window.confirm('Dismiss this conversation? It stays archived but leaves Triage.')) { actions.triageDismiss(row.gmailThreadId); showMsg('Dismissed'); } }}
              onAction={(action, id) => doAction(actions, active, action, id, showMsg)}
            />
          )}
          </>
          )}
        </div>
      </div>
    </div>
  );
}

function doAction(actions, folder, action, threadId, showMsg) {
  actions.mailboxAction(folder, action, threadId)
    .then(() => { if (showMsg) showMsg(ACTION_TOAST[action] || 'Done'); })
    .catch(() => { if (showMsg) showMsg('Action failed'); });
}
const ACTION_TOAST = {
  archive: 'Archived', trash: 'Moved to Trash', untrash: 'Restored',
  spam: 'Marked as spam', unspam: 'Not spam', markRead: 'Marked read',
  markUnread: 'Marked unread', star: 'Starred', unstar: 'Unstarred',
};

function NotConnected({ onConnect }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center' }}>
      <Mail size={36} color={BRAND.muted} style={{ marginBottom: 10 }} />
      <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>Connect Gmail to view this folder</h3>
      <p style={{ color: BRAND.muted, fontSize: 13, margin: '0 0 16px' }}>
        The Deals and Triage folders work from your CRM data, but the live mailbox folders need your Gmail connected.
      </p>
      <button onClick={onConnect} className="btn"><Mail size={14} /> Connect Gmail</button>
    </div>
  );
}

// Display-density picker. Rendered as a bottom-of-sidebar "Settings" bar on
// desktop (opens upward) and as a header icon on mobile.
function DensitySettings({ density, onChange, variant = 'icon', dropUp = false }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      {variant === 'bar' ? (
        <button
          onClick={() => setOpen(o => !o)}
          title="Display settings"
          aria-label="Display settings"
          aria-expanded={open}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            padding: '8px 12px', borderRadius: 8, cursor: 'pointer', border: 'none',
            background: open ? BRAND.blue + '14' : 'transparent', color: BRAND.muted,
            fontWeight: 500, fontSize: 13, fontFamily: 'inherit', textAlign: 'left',
          }}
        >
          <Settings size={15} color={BRAND.muted} />
          <span style={{ flex: 1 }}>Settings</span>
        </button>
      ) : (
        <button
          onClick={() => setOpen(o => !o)}
          className="btn-icon"
          title="Display settings"
          aria-label="Display settings"
          aria-expanded={open}
        ><Settings size={16} /></button>
      )}
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
          <div style={{
            position: 'absolute', left: 0, zIndex: 31, width: 220,
            ...(dropUp ? { bottom: '100%', marginBottom: 6 } : { top: '100%', marginTop: 6 }),
            background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10,
            boxShadow: '0 10px 30px rgba(0,0,0,0.14)', padding: 12,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: BRAND.muted, marginBottom: 8 }}>Density</div>
            {DENSITY_OPTIONS.map(opt => (
              <label key={opt.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', fontSize: 13, cursor: 'pointer' }}>
                <input type="radio" name="email-density" checked={density === opt.id} onChange={() => { onChange(opt.id); setOpen(false); }} />
                {opt.label}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Body({ def, rows, density = 'default', loading, error, onRetry, hasMore, onLoadMore, onOpen, onDismiss, onAction }) {
  // Infinite scroll: auto-load the next page as the bottom of the list nears the
  // viewport. We use BOTH a window scroll/resize listener and an
  // IntersectionObserver on a sentinel — the listener is the dependable path
  // (the observer alone proved unreliable in this layout). A busy ref + the
  // returned load promise prevent duplicate page fetches mid-flight.
  const sentinelRef = useRef(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;
  const busyRef = useRef(false);

  // Gmail-style multi-select (Gmail folders only). Selection is by thread id and
  // resets when the folder changes. mailboxAction already takes an array of ids,
  // so a bulk action is a single call that toasts once.
  const selectable = def.kind === 'gmail';
  const [selected, setSelected] = useState(() => new Set());
  useEffect(() => { setSelected(new Set()); }, [def.id]);
  const selectedIds = useMemo(() => rows.filter(r => selected.has(r.id)).map(r => r.id), [rows, selected]);
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const toggleOne = (id) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map(r => r.id)));
  const bulk = (action) => { if (!selectedIds.length) return; onAction(action, selectedIds); setSelected(new Set()); };

  useEffect(() => {
    if (!hasMore) return undefined;
    const triggerLoad = () => {
      if (busyRef.current || loading) return;
      const scrollEl = document.scrollingElement || document.documentElement;
      const nearBottom = scrollEl
        && (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) < 700;
      const s = sentinelRef.current;
      const sentinelNear = s && (s.getBoundingClientRect().top - window.innerHeight) < 700;
      if (!nearBottom && !sentinelNear) return;
      const p = loadMoreRef.current?.();
      if (p && typeof p.then === 'function') {
        busyRef.current = true;
        Promise.resolve(p).catch(() => {}).then(() => { busyRef.current = false; });
      }
    };
    window.addEventListener('scroll', triggerLoad, { passive: true });
    window.addEventListener('resize', triggerLoad);
    let obs;
    if (sentinelRef.current && typeof IntersectionObserver !== 'undefined') {
      obs = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting)) triggerLoad();
      }, { rootMargin: '600px' });
      obs.observe(sentinelRef.current);
    }
    // The freshly loaded page may still be short enough to need another.
    triggerLoad();
    return () => {
      window.removeEventListener('scroll', triggerLoad);
      window.removeEventListener('resize', triggerLoad);
      if (obs) obs.disconnect();
    };
  }, [hasMore, loading, rows.length]);

  if (loading && rows.length === 0) {
    return <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>Loading…</div>;
  }
  if (rows.length === 0 && error) {
    return (
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>
        <div style={{ marginBottom: 12 }}>Couldn't load this folder. {error}</div>
        {onRetry && <button onClick={onRetry} className="btn-ghost"><RefreshCw size={14} /> Try again</button>}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>
        {def.kind === 'triage' ? 'Nothing to triage.' : def.kind === 'deals' ? 'No conversations linked to active deals yet.' : 'This folder is empty.'}
      </div>
    );
  }
  return (
    <>
      {selectable && (
        <BulkBar
          folder={def.id}
          count={selectedIds.length}
          allSelected={allSelected}
          onToggleAll={toggleAll}
          onClear={() => setSelected(new Set())}
          onBulk={bulk}
        />
      )}
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
        {def.kind === 'triage'
          ? rows.map((m, i) => (
              <TriageRow key={m.gmailMessageId} message={m} first={i === 0} density={density} onOpen={() => onOpen(m)} onDismiss={() => onDismiss(m)} />
            ))
          : def.kind === 'gmail'
            ? rows.map((m, i) => <GmailThreadRow key={m.id} row={m} folder={def.id} first={i === 0} density={density} onOpen={() => onOpen(m)} onAction={onAction} selected={selected.has(m.id)} onToggleSelect={() => toggleOne(m.id)} />)
            : rows.map((m, i) => <DealThreadRow key={m.gmailThreadId} row={m} first={i === 0} density={density} onOpen={() => onOpen(m)} />)}
      </div>
      {hasMore && (
        <>
          <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button onClick={onLoadMore} className="btn-ghost" disabled={loading}>{loading ? 'Loading…' : 'Load older emails'}</button>
          </div>
        </>
      )}
    </>
  );
}

// Deal-stage pill shown on conversation rows — the in-app twin of the Gmail
// extension's inbox-row chip. Same stage palette so the two mirror each other.
function StagePill({ stage }) {
  const c = STAGE_COLOURS[stage] || STAGE_COLOURS.lead;
  return (
    <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, background: c.bg, color: c.fg, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {STAGE_LABEL[stage] || stage}
    </span>
  );
}

// Matching CRM deals for the current search query, shown above the email
// results so the search box finds deals as well as mail. Clicking opens the deal.
function DealResults({ deals, onOpenDeal }) {
  const { state } = useStore();
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden', marginBottom: 12 }}>
      <div style={{ padding: '7px 14px', fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: BRAND.muted, background: BRAND.paper, borderBottom: '1px solid ' + BRAND.border, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Briefcase size={13} color={BRAND.muted} /> Deals
      </div>
      {deals.map((d, i) => {
        const company = d.companyId ? state.companies?.[d.companyId] : null;
        const contact = d.primaryContactId ? state.contacts?.[d.primaryContactId] : null;
        const name = company?.name || d.title || 'Untitled deal';
        const sub = contact?.name || (company && d.title && d.title !== company.name ? d.title : '');
        return (
          <button
            key={d.id}
            onClick={() => onOpenDeal?.(d.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 14px', border: 'none', borderTop: i === 0 ? 'none' : '1px solid ' + BRAND.border, background: 'white', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
          >
            <Briefcase size={15} color={BRAND.blue} style={{ flexShrink: 0 }} />
            <span style={{ fontWeight: 600, fontSize: 14, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0, maxWidth: '45%' }}>{name}</span>
            {sub && <span style={{ fontSize: 12.5, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>}
            <span style={{ flex: 1 }} />
            {d.stage && <StagePill stage={d.stage} />}
          </button>
        );
      })}
    </div>
  );
}

// Small "3" pill shown next to multi-message conversations (Gmail-style).
function CountPill({ n }) {
  if (!n || n < 2) return null;
  return (
    <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: BRAND.muted, background: '#EEF3F6', borderRadius: 999, padding: '0 6px', minWidth: 18, textAlign: 'center' }}>
      {n}
    </span>
  );
}

// A Triage row — an inbound conversation not yet on any deal. Click to read it
// and attach via the deal panel; Dismiss drops it from Triage without filing.
function TriageRow({ message, first, density, onOpen, onDismiss }) {
  const inbound = message.direction === 'inbound';
  const counterparty = inbound ? message.fromEmail : (message.toEmails?.[0] || '');
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: vpad(density) + ' 16px', borderTop: first ? 'none' : '1px solid ' + BRAND.border, background: 'white' }}>
      <span style={{ flexShrink: 0, marginTop: 2, padding: '1px 5px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: (inbound ? '#16A34A' : '#2BB8E6') + '22', color: inbound ? '#16A34A' : '#2BB8E6' }}>{inbound ? 'IN' : 'OUT'}</span>
      <button onClick={onOpen} style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', padding: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {message.subject || <span style={{ color: BRAND.muted, fontStyle: 'italic' }}>(no subject)</span>}
        </div>
        {message.snippet && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{message.snippet}</div>}
        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>
          <span style={{ fontWeight: 700 }}>{formatMailDate(message.sentAt)}</span>{counterparty ? ` · ${inbound ? 'from' : 'to'} ${counterparty}` : ''}
        </div>
      </button>
      <button onClick={onDismiss} className="btn-ghost" title="Dismiss — not on a deal" aria-label="Dismiss" style={{ flexShrink: 0 }}><X size={14} /></button>
    </div>
  );
}

// A conversation row in the DB-backed Deals folder.
function DealThreadRow({ row, first, density, onOpen }) {
  const inbound = row.lastDirection === 'inbound';
  return (
    <button
      onClick={onOpen}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12, width: '100%',
        padding: vpad(density) + ' 16px', borderTop: first ? 'none' : '1px solid ' + BRAND.border,
        background: 'white', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
      }}
    >
      <span style={{
        flexShrink: 0, marginTop: 2, padding: '1px 5px', borderRadius: 3, fontSize: 10, fontWeight: 700,
        background: (inbound ? '#16A34A' : '#2BB8E6') + '22', color: inbound ? '#16A34A' : '#2BB8E6',
      }}>{inbound ? 'IN' : 'OUT'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.subject || <span style={{ color: BRAND.muted, fontStyle: 'italic' }}>(no subject)</span>}
          </span>
          <CountPill n={row.messageCount} />
        </div>
        {row.lastSnippet && (
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.lastSnippet}</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
          {(row.dealStages || []).slice(0, 3).map((s, i) => (
            <StagePill key={i} stage={s} />
          ))}
        </div>
      </div>
      <div style={{ flexShrink: 0, textAlign: 'right', fontSize: 11, color: BRAND.muted }}>
        <div style={{ fontWeight: 700 }}>{formatMailDate(row.sentAt)}</div>
        <div style={{ marginTop: 2 }}>{inbound ? 'from' : 'to'} {row.lastFrom || '—'}</div>
      </div>
    </button>
  );
}

// A conversation row in a live Gmail folder, with inline star + quick actions.
// Gmail-style bulk action bar: a select-all checkbox and, once anything is
// selected, the actions that apply to the current folder. Hidden actions
// mirror the per-row buttons (no Archive in trash/spam/sent/drafts; Restore
// instead of Delete in trash).
function BulkBar({ folder, count, allSelected, onToggleAll, onClear, onBulk }) {
  const checkRef = useRef(null);
  const some = count > 0;
  useEffect(() => { if (checkRef.current) checkRef.current.indeterminate = some && !allSelected; }, [some, allSelected]);
  const canArchive = !['trash', 'spam', 'sent', 'drafts'].includes(folder);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', marginBottom: 8, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10 }}>
      <input
        ref={checkRef}
        type="checkbox"
        checked={allSelected}
        onChange={onToggleAll}
        title="Select all"
        aria-label="Select all conversations"
        style={{ width: 16, height: 16, cursor: 'pointer' }}
      />
      {some ? (
        <>
          <span style={{ fontSize: 13, color: BRAND.muted, minWidth: 76 }}>{count} selected</span>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <button onClick={() => onBulk('markRead')} className="btn-ghost" style={{ fontSize: 12 }}><MailOpen size={14} /> Mark read</button>
            <button onClick={() => onBulk('markUnread')} className="btn-ghost" style={{ fontSize: 12 }}><Mail size={14} /> Mark unread</button>
            {canArchive && (
              <button onClick={() => onBulk('archive')} className="btn-ghost" style={{ fontSize: 12 }}><Archive size={14} /> Archive</button>
            )}
            {folder === 'trash'
              ? <button onClick={() => onBulk('untrash')} className="btn-ghost" style={{ fontSize: 12 }}><RefreshCw size={14} /> Restore</button>
              : <button onClick={() => onBulk('trash')} className="btn-ghost" style={{ fontSize: 12, color: '#B91C1C' }}><Trash2 size={14} /> Delete</button>}
          </div>
          <button onClick={onClear} className="btn-ghost" style={{ fontSize: 12, marginLeft: 'auto' }}>Clear</button>
        </>
      ) : (
        <span style={{ fontSize: 13, color: BRAND.muted }}>Select to mark read, archive or delete in bulk</span>
      )}
    </div>
  );
}

function GmailThreadRow({ row, folder, first, density, onOpen, onAction, selected, onToggleSelect }) {
  const { state } = useStore();
  const [hover, setHover] = useState(false);
  const chips = state.threadDeals?.[row.id] || [];
  const who = (row.participants && row.participants.length ? row.participants.join(', ') : null)
    || displayName(row.from) || row.fromEmail || '(unknown)';
  // Sent rows read like Gmail's Sent: "To: <recipient>" rather than the sender.
  const whoLabel = folder === 'sent' ? 'To: ' + who : who;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: vpad(density) + ' 14px',
      borderTop: first ? 'none' : '1px solid ' + (hover ? 'transparent' : BRAND.border),
      background: selected ? '#FEF9E7' : hover ? 'white' : row.unread ? '#F4FAFE' : 'white',
      // Gmail-style hover "pop": the row lifts on a soft shadow above its
      // neighbours. position+zIndex keep the shadow over the next row's border.
      position: 'relative',
      zIndex: hover ? 1 : 0,
      boxShadow: hover ? '0 1px 6px rgba(15,42,61,0.16), 0 0 0 1px rgba(15,42,61,0.06)' : 'none',
      borderRadius: hover ? 6 : 0,
      cursor: 'pointer',
      transition: 'box-shadow 120ms ease, background 120ms ease',
    }}>
      <input
        type="checkbox"
        checked={!!selected}
        onChange={onToggleSelect}
        onClick={(e) => e.stopPropagation()}
        title="Select"
        aria-label="Select conversation"
        style={{ width: 16, height: 16, flexShrink: 0, cursor: 'pointer' }}
      />
      <button
        onClick={(e) => { e.stopPropagation(); onAction(row.starred ? 'unstar' : 'star', row.id); }}
        title={row.starred ? 'Unstar' : 'Star'}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', color: row.starred ? '#F59E0B' : BRAND.muted }}
      >
        <Star size={15} fill={row.starred ? '#F59E0B' : 'none'} />
      </button>
      <button
        onClick={onOpen}
        style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 10, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', padding: 0 }}
      >
        <span style={{ width: 170, flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: 5, fontSize: 14, fontWeight: row.unread ? 700 : 400, color: BRAND.ink, overflow: 'hidden' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{whoLabel}</span>
          <CountPill n={row.messageCount} />
        </span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: row.unread ? 700 : 400 }}>{row.subject || '(no subject)'}</span>
          {row.snippet && <span style={{ color: BRAND.muted, fontWeight: 400 }}> — {row.snippet}</span>}
        </span>
      </button>
      {chips.length > 0 && (
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, maxWidth: 190, overflow: 'hidden' }}>
          <StagePill stage={chips[0].stage} />
          {chips.length > 1 && <span style={{ fontSize: 10.5, fontWeight: 700, color: BRAND.muted }}>+{chips.length - 1}</span>}
        </div>
      )}
      <TrackingEye tracking={row.tracking} />
      {row.hasAttachments && <Paperclip size={13} color={BRAND.muted} style={{ flexShrink: 0 }} title="Has attachment" />}
      <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: BRAND.muted, width: 78, textAlign: 'right' }}>{formatMailDate(row.date)}</span>
      <div style={{ flexShrink: 0, display: 'flex', gap: 2 }}>
        {row.unread && (
          <button onClick={() => onAction('markRead', row.id)} className="btn-icon" style={SLIM_ROW_BTN} title="Mark read" aria-label="Mark read"><MailOpen size={14} /></button>
        )}
        {folder !== 'trash' && folder !== 'spam' && folder !== 'sent' && folder !== 'drafts' && (
          <button onClick={() => onAction('archive', row.id)} className="btn-icon" style={SLIM_ROW_BTN} title="Archive" aria-label="Archive"><Archive size={14} /></button>
        )}
        {folder === 'trash'
          ? <button onClick={() => onAction('untrash', row.id)} className="btn-icon" style={SLIM_ROW_BTN} title="Restore" aria-label="Restore"><RefreshCw size={14} /></button>
          : <button onClick={() => onAction('trash', row.id)} className="btn-icon" style={SLIM_ROW_BTN} title="Delete" aria-label="Delete"><Trash2 size={14} /></button>}
      </div>
    </div>
  );
}

// Full conversation modal: loads the thread (live Gmail or DB) and renders
// every message stacked, newest expanded and older ones collapsible.
// Tracking summary (TrackingBanner) shown at the top of a tracked conversation.
function ConversationView({ openRef, folder, connected, onBack, onOpenDeal }) {
  const { state, actions, showMsg } = useStore();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const isMobile = useIsMobile();

  const isGmail = openRef.kind === 'gmail';
  const thread = state.threadCache?.[openRef.threadId];
  const messages = thread?.messages || [];
  const myEmail = (state.gmailAccount?.gmailAddress || '').toLowerCase();
  const folderLabel = FOLDER_BY_ID[folder]?.label || 'list';

  useEffect(() => {
    let cancelled = false;
    setError('');
    setLoading(!thread);
    const loader = isGmail ? actions.loadMailboxThread(openRef.threadId) : actions.loadDealThread(openRef.threadId);
    loader.then(() => { if (!cancelled) setLoading(false); })
          .catch((e) => { if (!cancelled) { setError(e?.message || 'Failed to load'); setLoading(false); } });
    // Opening an unread conversation marks the whole thread read (like Gmail).
    if (isGmail && openRef.unread) actions.mailboxAction(folder, 'markRead', openRef.threadId);
    return () => { cancelled = true; };
  }, [openRef.threadId]); // eslint-disable-line react-hooks/exhaustive-deps

  const latest = messages[messages.length - 1] || null;
  const subject = thread?.subject || latest?.subject || '(no subject)';
  // The other party of the conversation — drives the deal panel's contact
  // suggestions and the attach snapshot.
  const counterparty = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const fe = messages[i]?.fromEmail;
      if (fe && fe.toLowerCase() !== myEmail) return fe;
    }
    return latest?.fromEmail || null;
  }, [messages, myEmail, latest]);

  // Inline reply composer at the foot of the thread (Gmail-style).
  // null | 'reply' | 'replyAll' | 'forward'.
  const [composeMode, setComposeMode] = useState(null);

  // Reply goes to the other party of the latest message.
  const replyRecipient = (msg) => {
    if (!msg) return '';
    if (msg.fromEmail && msg.fromEmail.toLowerCase() !== myEmail) return msg.fromEmail;
    return (msg.to || [])[0] || msg.fromEmail || '';
  };

  // Everyone on the latest message except me — drives the "Reply all" button,
  // which only appears when more than one other person is on the thread.
  const otherParticipants = useMemo(() => {
    const set = new Set();
    for (const e of [...(latest?.to || []), ...(latest?.cc || []), latest?.fromEmail].filter(Boolean)) {
      const l = String(e).toLowerCase();
      if (l && l !== myEmail) set.add(l);
    }
    return set;
  }, [latest, myEmail]);
  const canReplyAll = otherParticipants.size > 1;

  // Build the seed draft for the inline composer for each mode.
  const draftFor = (mode) => {
    if (!latest) return null;
    if (mode === 'forward') {
      return {
        to: '',
        subject: /^fwd:/i.test(subject) ? subject : 'Fwd: ' + subject,
        body: `<br><br>---------- Forwarded message ----------<br>`
          + `From: ${escapeText(latest.from || latest.fromEmail || '')}<br>Subject: ${escapeText(subject)}<br><br>`
          + (quoteSourceHtml(latest.html) || (latest.text ? escapeText(latest.text).replace(/\n/g, '<br>') : '')),
      };
    }
    const primary = replyRecipient(latest);
    let ccList = [];
    if (mode === 'replyAll') {
      const seen = new Set([myEmail, (primary || '').toLowerCase()]);
      for (const e of [...(latest.to || []), ...(latest.cc || [])]) {
        const l = String(e || '').toLowerCase();
        if (l && !seen.has(l)) { seen.add(l); ccList.push(e); }
      }
    }
    // The thread is shown above the inline composer, so don't quote it into the
    // reply body — keep the editor clean (message + signature only).
    return {
      to: primary,
      cc: ccList.join(', '),
      subject: /^re:/i.test(subject) ? subject : 'Re: ' + subject,
      body: '',
      gmailThreadId: openRef.threadId,
    };
  };

  // Re-fetch the thread after a send so the new message appears in place.
  const reloadThread = () => {
    (isGmail ? actions.loadMailboxThread(openRef.threadId) : actions.loadDealThread(openRef.threadId)).catch(() => {});
  };

  const continueDraft = () => {
    if (!latest) return;
    actions.openComposer({
      initialDraft: {
        to: (latest.to || []).join(', '),
        cc: (latest.cc || []).join(', '),
        subject: latest.subject || subject,
        body: sanitizeBody(latest.html) || (latest.text ? escapeText(latest.text).replace(/\n/g, '<br>') : ''),
        gmailThreadId: openRef.threadId,
      },
    });
  };

  const act = (action) => {
    actions.mailboxAction(folder, action, openRef.threadId)
      .then(() => { showMsg(ACTION_TOAST[action] || 'Done'); onBack(); })
      .catch(() => showMsg('Action failed'));
  };

  const gmailWeb = openRef.threadId ? `https://mail.google.com/mail/u/0/#all/${openRef.threadId}` : null;

  return (
    <div>
      <button onClick={onBack} className="btn-ghost" style={{ marginBottom: 10 }}><ArrowLeft size={14} /> {folderLabel}</button>
      <h2 style={{ margin: '0 0 14px', fontSize: 19, fontWeight: 700, wordBreak: 'break-word' }}>
        {subject}
        {messages.length > 1 && <span style={{ color: BRAND.muted, fontWeight: 500 }}> · {messages.length} messages</span>}
      </h2>
      {thread?.tracking?.tracked && <TrackingBanner tracking={thread.tracking} />}

      <div style={{ display: 'flex', gap: 18, flexDirection: isMobile ? 'column' : 'row', alignItems: 'flex-start' }}>
        {/* Conversation (left) */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Action bar — folder management (Gmail folders only). Reply /
              Forward live at the foot of the thread, Gmail-style. */}
          {latest && isGmail && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingBottom: 12, marginBottom: 12, borderBottom: '1px solid ' + BRAND.border }}>
              {folder !== 'sent' && folder !== 'drafts' && folder !== 'trash' && folder !== 'spam' && (
                <button onClick={() => act('archive')} className="btn-icon" title="Archive" aria-label="Archive"><Archive size={16} /></button>
              )}
              {folder === 'trash'
                ? <button onClick={() => act('untrash')} className="btn-icon" title="Restore" aria-label="Restore"><RefreshCw size={16} /></button>
                : <button onClick={() => act('trash')} className="btn-icon" title="Delete" aria-label="Delete"><Trash2 size={16} /></button>}
              {folder !== 'spam' && folder !== 'drafts' && <button onClick={() => act('spam')} className="btn-icon" title="Mark as spam" aria-label="Mark as spam"><ShieldAlert size={16} /></button>}
              {folder === 'spam' && <button onClick={() => act('unspam')} className="btn-icon" title="Not spam" aria-label="Not spam"><ShieldAlert size={16} /></button>}
              {folder !== 'drafts' && <button onClick={() => act('markUnread')} className="btn-icon" title="Mark unread" aria-label="Mark unread"><MailOpen size={16} /></button>}
              {gmailWeb && <a href={gmailWeb} target="_blank" rel="noreferrer" className="btn-icon" title="Open in Gmail" aria-label="Open in Gmail" style={{ textDecoration: 'none' }}><ExternalLink size={16} /></a>}
            </div>
          )}

          {loading && <div style={{ color: BRAND.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>Loading…</div>}
          {error && <div style={{ color: '#DC2626', fontSize: 13 }}>{error}</div>}
          {!loading && !error && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {messages.map((m, i) => (
                <MessageBlock
                  key={m.id || i}
                  message={m}
                  myEmail={myEmail}
                  connected={connected}
                  defaultExpanded={i === messages.length - 1 || m.unread}
                />
              ))}
              {messages.length === 0 && <div style={{ color: BRAND.muted, fontStyle: 'italic', fontSize: 13 }}>(no messages)</div>}
            </div>
          )}

          {/* Reply / forward at the foot of the thread, Gmail-style. */}
          {!loading && !error && latest && folder === 'drafts' && (
            <div style={{ marginTop: 14 }}>
              <button onClick={continueDraft} className="btn"><PenSquare size={15} /> Continue editing</button>
            </div>
          )}
          {!loading && !error && latest && folder !== 'drafts' && (
            composeMode
              ? (
                <div style={{ marginTop: 14 }}>
                  <EmailComposerModal
                    key={composeMode}
                    inline
                    deal={null}
                    contact={null}
                    initialDraft={draftFor(composeMode)}
                    onClose={() => setComposeMode(null)}
                    onSent={() => { setComposeMode(null); reloadThread(); }}
                  />
                </div>
              )
              : (
                <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                  {canReplyAll && (
                    <button onClick={() => setComposeMode('replyAll')} className="btn-ghost"><ReplyAll size={15} /> Reply all</button>
                  )}
                  <button onClick={() => setComposeMode('reply')} className="btn-ghost"><Reply size={15} /> Reply</button>
                  <button onClick={() => setComposeMode('forward')} className="btn-ghost"><Forward size={15} /> Forward</button>
                </div>
              )
          )}
        </div>

        {/* Deal context panel (right) — shown for every conversation, so emails
            already on a deal display their deal here too. Sticks in view as the
            conversation scrolls. */}
        <div style={{
          width: isMobile ? '100%' : 320, flexShrink: 0,
          borderLeft: isMobile ? 'none' : '1px solid ' + BRAND.border,
          borderTop: isMobile ? '1px solid ' + BRAND.border : 'none',
          paddingLeft: isMobile ? 0 : 18, paddingTop: isMobile ? 14 : 0,
          position: isMobile ? 'static' : 'sticky', top: isMobile ? undefined : 16,
          alignSelf: 'flex-start', maxHeight: isMobile ? 'none' : 'calc(100vh - 32px)', overflowY: 'auto',
        }}>
          <DealContextPanel
            gmailThreadId={openRef.threadId}
            counterpartyEmail={counterparty}
            // Navigate straight to the deal. (Don't call onBack first — it now
            // triggers history.back(), which races the navigate and cancels it.)
            onOpenDeal={onOpenDeal}
            onOpenProposal={onOpenProposal}
          />
        </div>
      </div>
    </div>
  );
}

// One message inside a conversation. Collapsed shows a one-line header; click
// to expand the full sanitised body + attachments.
function MessageBlock({ message, myEmail, connected, defaultExpanded }) {
  const [open, setOpen] = useState(!!defaultExpanded);
  const outbound = message.outbound || (message.fromEmail && message.fromEmail.toLowerCase() === myEmail);
  const hasHtml = !!(message.html && message.html.trim());
  const who = displayName(message.from) || message.fromEmail || (outbound ? 'me' : '—');

  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden', background: 'white' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
          background: open ? '#FAFBFC' : 'white', border: 'none', borderBottom: open ? '1px solid ' + BRAND.border : 'none',
          cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
        }}
      >
        <span style={{
          flexShrink: 0, padding: '1px 5px', borderRadius: 3, fontSize: 10, fontWeight: 700,
          background: (outbound ? '#2BB8E6' : '#16A34A') + '22', color: outbound ? '#2BB8E6' : '#16A34A',
        }}>{outbound ? 'OUT' : 'IN'}</span>
        <span style={{ fontWeight: 600, fontSize: 13, color: BRAND.ink, flexShrink: 0, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{who}</span>
        {!open && <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{message.snippet}</span>}
        <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 11, color: BRAND.muted }}>{formatDateLabel(message.date)}</span>
        <ChevronDown size={14} color={BRAND.muted} style={{ flexShrink: 0, transition: 'transform 150ms', transform: open ? 'none' : 'rotate(-90deg)' }} />
      </button>
      {open && (
        <div style={{ padding: 12 }}>
          <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 10, lineHeight: 1.5 }}>
            {message.to?.length ? <div>to {message.to.join(', ')}</div> : null}
            {message.cc?.length ? <div>cc {message.cc.join(', ')}</div> : null}
          </div>
          <div className="email-body" style={{ fontSize: 13.5, lineHeight: 1.6, wordBreak: 'break-word' }}>
            {hasHtml
              ? <EmailFrame html={message.html} />
              : message.text
                ? <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0 }}>{message.text}</pre>
                : <div style={{ color: BRAND.muted, fontStyle: 'italic' }}>(no body)</div>}
          </div>
          {message.attachments?.length > 0 && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid ' + BRAND.border, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {message.attachments.map((a, i) => (
                <AttachmentChip key={i} att={a} messageId={message.id} connected={connected} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Renders an HTML email inside a sandboxed iframe so the sender's own CSS
// (style blocks + inline styles) applies and renders faithfully — just like
// Gmail — without leaking into or breaking the surrounding app. No
// allow-scripts in the sandbox, so nothing in the email can execute JS; the
// HTML is sanitised first as defence-in-depth. Height auto-fits the content.
function EmailFrame({ html }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(360);

  const srcDoc = useMemo(() => {
    const clean = DOMPurify.sanitize(html || '', FRAME_SANITIZE);
    return '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<base target="_blank">'
      + '<style>'
      + 'html,body{margin:0;padding:0;}'
      + "body{font-family:-apple-system,system-ui,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13.5px;line-height:1.6;color:#0F2A3D;word-break:break-word;overflow-x:auto;}"
      + 'img{max-width:100%;height:auto;}'
      + 'a{color:#2BB8E6;}'
      + '</style></head><body>' + clean + '</body></html>';
  }, [html]);

  const resize = () => {
    const f = ref.current;
    if (!f || !f.contentWindow) return;
    try {
      const doc = f.contentWindow.document;
      const h = Math.max(doc.body?.scrollHeight || 0, doc.documentElement?.scrollHeight || 0);
      if (h) setHeight(h + 4);
    } catch { /* cross-origin guard — shouldn't happen with srcDoc */ }
  };

  const onLoad = () => {
    resize();
    // Images usually finish loading after the document, changing the height.
    try {
      const doc = ref.current.contentWindow.document;
      doc.querySelectorAll('img').forEach((img) => {
        if (!img.complete) img.addEventListener('load', resize, { once: true });
      });
    } catch { /* ignore */ }
    // A couple of delayed re-measures catch late reflow (web fonts, slow images).
    setTimeout(resize, 250);
    setTimeout(resize, 1000);
  };

  return (
    <iframe
      ref={ref}
      title="Email message"
      onLoad={onLoad}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      style={{ width: '100%', border: 'none', height: height + 'px', display: 'block' }}
    />
  );
}

function AttachmentChip({ att, messageId, connected }) {
  const id = att.attachmentId;
  const href = (connected && id && messageId)
    ? '/api/crm/gmail/attachment?' + new URLSearchParams({
        messageId, attachmentId: id, filename: att.filename || 'attachment', mimeType: att.mimeType || 'application/octet-stream',
      }).toString()
    : null;
  const inner = (
    <>
      <Paperclip size={13} color={BRAND.muted} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{att.filename || 'attachment'}</span>
      {href && <Download size={13} color={BRAND.blue} />}
    </>
  );
  const style = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8, fontSize: 12.5, color: BRAND.ink, textDecoration: 'none', background: 'white' };
  return href
    ? <a href={href} target="_blank" rel="noreferrer" style={{ ...style, cursor: 'pointer' }}>{inner}</a>
    : <span style={{ ...style, color: BRAND.muted }} title="Connect Gmail to download">{inner}</span>;
}

function displayName(fromHeader) {
  if (!fromHeader) return null;
  const m = String(fromHeader).match(/^\s*"?([^"<]+?)"?\s*<.+>/);
  return m ? m[1].trim() : null;
}
function escapeText(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function formatDateLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
