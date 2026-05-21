import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Mail, Inbox, Send, FileText, Star, ShieldAlert, Trash2, Archive,
  Search, X, RefreshCw, MailOpen, Reply, ReplyAll, Forward, Paperclip, Download,
  Briefcase, PenSquare, ExternalLink, ChevronDown, CircleDot,
} from 'lucide-react';
import DOMPurify from 'dompurify';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatRelativeTime, useIsMobile } from '../../utils.js';
import { DealContextPanel } from './DealContextPanel.jsx';
import { EmailComposerModal } from './DealDetailView.jsx';
import { STAGE_COLOURS, STAGE_LABEL } from '../../lib/stages.js';

// 'deals' + 'triage' are DB-backed (CRM-aware); the rest proxy live to Gmail
// via /api/crm/gmail/folder. kind drives which store action loads each folder.
const FOLDERS = [
  { id: 'deals',   label: 'Deals',    icon: Briefcase,   kind: 'deals'  },
  { id: 'triage',  label: 'Triage',   icon: Inbox,       kind: 'triage' },
  { id: 'inbox',   label: 'Inbox',    icon: Mail,        kind: 'gmail'  },
  { id: 'unread',  label: 'Unread',   icon: CircleDot,   kind: 'gmail'  },
  { id: 'sent',    label: 'Sent',     icon: Send,        kind: 'gmail'  },
  { id: 'drafts',  label: 'Drafts',   icon: FileText,    kind: 'gmail'  },
  { id: 'starred', label: 'Starred',  icon: Star,        kind: 'gmail'  },
  { id: 'spam',    label: 'Spam',     icon: ShieldAlert, kind: 'gmail'  },
  { id: 'trash',   label: 'Trash',    icon: Trash2,      kind: 'gmail'  },
  { id: 'all',     label: 'All Mail', icon: Archive,     kind: 'gmail'  },
];
const FOLDER_BY_ID = Object.fromEntries(FOLDERS.map(f => [f.id, f]));

// DOMPurify config mirrors the deal-detail email viewer: permissive enough to
// render real mail (images, links, tables) but strips scripts/inline handlers.
const VIEW_SANITIZE = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
};
const sanitizeBody = (html) => (html ? DOMPurify.sanitize(html, VIEW_SANITIZE) : null);

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

export function EmailsView({ folder = 'deals', onBack, onOpenDeal, onSelectFolder }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const active = FOLDER_BY_ID[folder] ? folder : 'deals';
  const def = FOLDER_BY_ID[active];

  const connected = !!(state.gmailAccount && state.gmailAccount.connected);
  const [search, setSearch] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [openRef, setOpenRef] = useState(null);     // { kind, threadId, unread } for the conversation modal

  useEffect(() => { setSearch(''); setAppliedQuery(''); setOpenRef(null); }, [active]);

  useEffect(() => {
    if (def.kind === 'deals') {
      if (!state.mailbox?.deals?.loaded) actions.loadDealEmails();
    } else if (def.kind === 'triage') {
      actions.refreshTriage();
    } else if (def.kind === 'gmail' && connected) {
      if (!state.mailbox?.[active]?.loaded) actions.loadMailboxFolder(active);
    }
  }, [active, connected]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const runGmailSearch = () => {
    if (def.kind !== 'gmail' || !connected) return;
    const q = search.trim();
    setAppliedQuery(q);
    actions.loadMailboxFolder(active, { q });
  };

  const refresh = () => {
    if (def.kind === 'deals') actions.loadDealEmails();
    else if (def.kind === 'triage') actions.refreshTriage();
    else if (connected) actions.loadMailboxFolder(active, { q: appliedQuery });
    if (connected) actions.loadMailboxLabels();
  };

  const loadMore = () => {
    if (slice.loading || slice.next == null) return;
    if (def.kind === 'deals') actions.loadDealEmails(slice.next);
    else if (def.kind === 'gmail') actions.loadMailboxFolder(active, { pageToken: slice.next, q: appliedQuery });
  };

  const compose = () => actions.openComposer({});

  const triageBadge = (state.triage || []).length;
  const badgeFor = (f) => {
    if (f.id === 'triage') return triageBadge || null;
    if (f.id === 'inbox') return state.mailboxLabels?.INBOX?.threadsUnread || null;
    if (f.id === 'unread') return state.mailboxLabels?.UNREAD?.threadsTotal || null;
    if (f.id === 'spam') return state.mailboxLabels?.SPAM?.threadsUnread || null;
    return null;
  };

  return (
    <div style={{ padding: isMobile ? '14px 10px' : '28px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Mail size={22} color={BRAND.blue} /> Emails
        </h1>
        <div style={{ flex: 1 }} />
        <button onClick={compose} className="btn"><PenSquare size={14} /> Compose</button>
      </header>

      <div style={{ display: 'flex', gap: isMobile ? 0 : 18, alignItems: 'flex-start', flexDirection: isMobile ? 'column' : 'row' }}>
        {/* Folder sidebar */}
        <nav style={{
          width: isMobile ? '100%' : 200, flexShrink: 0,
          display: 'flex', flexDirection: isMobile ? 'row' : 'column',
          gap: 2, overflowX: isMobile ? 'auto' : 'visible',
          marginBottom: isMobile ? 12 : 0,
        }}>
          {FOLDERS.map((f) => {
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
        </nav>

        {/* Main pane */}
        <div style={{ flex: 1, minWidth: 0, width: '100%' }}>
          {openRef ? (
            // Open the conversation full-width in the main area (like Gmail),
            // not a pop-up. The folder sidebar stays put; Back returns to list.
            <ConversationView
              openRef={openRef}
              folder={active}
              connected={connected}
              onBack={() => { setOpenRef(null); if (active === 'triage') actions.refreshTriage(); }}
              onOpenDeal={onOpenDeal}
            />
          ) : (
          <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7 }}>
              <def.icon size={16} color={BRAND.blue} /> {def.label}
            </h2>
            <button onClick={refresh} className="btn-icon" title="Refresh" aria-label="Refresh"><RefreshCw size={15} /></button>
            <div style={{ flex: 1 }} />
            <div style={{ position: 'relative', width: isMobile ? '100%' : 280 }}>
              <Search size={14} color={BRAND.muted} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
              <input
                className="input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runGmailSearch(); }}
                placeholder={def.kind === 'gmail' ? 'Search Gmail… (Enter)' : 'Filter ' + def.label.toLowerCase() + '…'}
                style={{ paddingLeft: 34, paddingRight: search ? 34 : 12 }}
              />
              {search && (
                <button
                  onClick={() => { setSearch(''); if (def.kind === 'gmail' && appliedQuery) { setAppliedQuery(''); actions.loadMailboxFolder(active); } }}
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

          {def.kind === 'gmail' && !connected ? (
            <NotConnected onConnect={() => actions.connectGmail().then((url) => { if (url) window.location.href = url; })} />
          ) : (
            <Body
              def={def}
              rows={rows}
              loading={!!slice.loading}
              hasMore={slice.next != null}
              onLoadMore={loadMore}
              onOpen={(row) => setOpenRef(toOpenRef(def, row))}
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

// Normalise a list row into the reference the conversation modal loads from.
function toOpenRef(def, row) {
  if (def.kind === 'gmail') return { kind: 'gmail', threadId: row.id, unread: row.unread };
  return { kind: 'db', threadId: row.gmailThreadId, unread: false };
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

function Body({ def, rows, loading, hasMore, onLoadMore, onOpen, onDismiss, onAction }) {
  // Infinite scroll: a sentinel near the list's end auto-loads the next page
  // when it scrolls into view. The "Load more" button stays as a fallback.
  const sentinelRef = useRef(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  useEffect(() => {
    if (!hasMore || loading) return undefined;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) loadMoreRef.current?.();
    }, { rootMargin: '400px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loading, rows.length]);

  if (loading && rows.length === 0) {
    return <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>Loading…</div>;
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
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
        {def.kind === 'triage'
          ? rows.map((m, i) => (
              <TriageRow key={m.gmailMessageId} message={m} first={i === 0} onOpen={() => onOpen(m)} onDismiss={() => onDismiss(m)} />
            ))
          : def.kind === 'gmail'
            ? rows.map((m, i) => <GmailThreadRow key={m.id} row={m} folder={def.id} first={i === 0} onOpen={() => onOpen(m)} onAction={onAction} />)
            : rows.map((m, i) => <DealThreadRow key={m.gmailThreadId} row={m} first={i === 0} onOpen={() => onOpen(m)} />)}
      </div>
      {hasMore && (
        <>
          <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button onClick={onLoadMore} className="btn-ghost" disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>
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
function TriageRow({ message, first, onOpen, onDismiss }) {
  const inbound = message.direction === 'inbound';
  const counterparty = inbound ? message.fromEmail : (message.toEmails?.[0] || '');
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px', borderTop: first ? 'none' : '1px solid ' + BRAND.border, background: 'white' }}>
      <span style={{ flexShrink: 0, marginTop: 2, padding: '1px 5px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: (inbound ? '#16A34A' : '#2BB8E6') + '22', color: inbound ? '#16A34A' : '#2BB8E6' }}>{inbound ? 'IN' : 'OUT'}</span>
      <button onClick={onOpen} style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', padding: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {message.subject || <span style={{ color: BRAND.muted, fontStyle: 'italic' }}>(no subject)</span>}
        </div>
        {message.snippet && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{message.snippet}</div>}
        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>
          {formatRelativeTime(message.sentAt)}{counterparty ? ` · ${inbound ? 'from' : 'to'} ${counterparty}` : ''}
        </div>
      </button>
      <button onClick={onDismiss} className="btn-ghost" title="Dismiss — not on a deal" aria-label="Dismiss" style={{ flexShrink: 0 }}><X size={14} /></button>
    </div>
  );
}

// A conversation row in the DB-backed Deals folder.
function DealThreadRow({ row, first, onOpen }) {
  const inbound = row.lastDirection === 'inbound';
  return (
    <button
      onClick={onOpen}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12, width: '100%',
        padding: '12px 16px', borderTop: first ? 'none' : '1px solid ' + BRAND.border,
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
        <div>{formatRelativeTime(row.sentAt)}</div>
        <div style={{ marginTop: 2 }}>{inbound ? 'from' : 'to'} {row.lastFrom || '—'}</div>
      </div>
    </button>
  );
}

// A conversation row in a live Gmail folder, with inline star + quick actions.
function GmailThreadRow({ row, folder, first, onOpen, onAction }) {
  const { state } = useStore();
  const chips = state.threadDeals?.[row.id] || [];
  const who = (row.participants && row.participants.length ? row.participants.join(', ') : null)
    || displayName(row.from) || row.fromEmail || '(unknown)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 14px', borderTop: first ? 'none' : '1px solid ' + BRAND.border,
      background: row.unread ? '#F4FAFE' : 'white',
    }}>
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
        <span style={{ width: 170, flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: 5, fontSize: 13, fontWeight: row.unread ? 700 : 500, color: BRAND.ink, overflow: 'hidden' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{who}</span>
          <CountPill n={row.messageCount} />
        </span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: row.unread ? 700 : 500 }}>{row.subject || '(no subject)'}</span>
          {row.snippet && <span style={{ color: BRAND.muted, fontWeight: 400 }}> — {row.snippet}</span>}
        </span>
      </button>
      {chips.length > 0 && (
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, maxWidth: 190, overflow: 'hidden' }}>
          <StagePill stage={chips[0].stage} />
          {chips.length > 1 && <span style={{ fontSize: 10.5, fontWeight: 700, color: BRAND.muted }}>+{chips.length - 1}</span>}
        </div>
      )}
      <span style={{ flexShrink: 0, fontSize: 11, color: BRAND.muted, width: 64, textAlign: 'right' }}>{formatRelativeTime(row.date)}</span>
      <div style={{ flexShrink: 0, display: 'flex', gap: 2 }}>
        {row.unread && (
          <button onClick={() => onAction('markRead', row.id)} className="btn-icon" title="Mark read" aria-label="Mark read"><MailOpen size={14} /></button>
        )}
        {folder !== 'trash' && folder !== 'spam' && folder !== 'sent' && folder !== 'drafts' && (
          <button onClick={() => onAction('archive', row.id)} className="btn-icon" title="Archive" aria-label="Archive"><Archive size={14} /></button>
        )}
        {folder === 'trash'
          ? <button onClick={() => onAction('untrash', row.id)} className="btn-icon" title="Restore" aria-label="Restore"><RefreshCw size={14} /></button>
          : <button onClick={() => onAction('trash', row.id)} className="btn-icon" title="Delete" aria-label="Delete"><Trash2 size={14} /></button>}
      </div>
    </div>
  );
}

// Full conversation modal: loads the thread (live Gmail or DB) and renders
// every message stacked, newest expanded and older ones collapsible.
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

  const quotedReply = () =>
    `<br><br><div style="border-left:2px solid #ccc;padding-left:12px;color:#555;">`
    + `On ${formatDateLabel(latest.date)}, ${escapeText(latest.from || latest.fromEmail || '')} wrote:<br>`
    + (sanitizeBody(latest.html) || (latest.text ? escapeText(latest.text).replace(/\n/g, '<br>') : '')) + '</div>';

  // Build the seed draft for the inline composer for each mode.
  const draftFor = (mode) => {
    if (!latest) return null;
    if (mode === 'forward') {
      return {
        to: '',
        subject: /^fwd:/i.test(subject) ? subject : 'Fwd: ' + subject,
        body: `<br><br>---------- Forwarded message ----------<br>`
          + `From: ${escapeText(latest.from || latest.fromEmail || '')}<br>Subject: ${escapeText(subject)}<br><br>`
          + (sanitizeBody(latest.html) || (latest.text ? escapeText(latest.text).replace(/\n/g, '<br>') : '')),
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
    return {
      to: primary,
      cc: ccList.join(', '),
      subject: /^re:/i.test(subject) ? subject : 'Re: ' + subject,
      body: quotedReply(),
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
            onOpenDeal={(id) => { onBack(); onOpenDeal?.(id); }}
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
