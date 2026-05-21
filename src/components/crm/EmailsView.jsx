import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Mail, Inbox, Send, FileText, Star, ShieldAlert, Trash2, Archive,
  Search, X, RefreshCw, MailOpen, Reply, Forward, Paperclip, Download,
  Briefcase, PenSquare, ExternalLink,
} from 'lucide-react';
import DOMPurify from 'dompurify';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatRelativeTime, useIsMobile } from '../../utils.js';
import { Modal } from '../ui.jsx';
import { ThreadRow, AssignModal } from './TriageView.jsx';

// 'deals' + 'triage' are DB-backed (CRM-aware); the rest proxy live to Gmail
// via /api/crm/gmail/folder. kind drives which store action loads each folder.
const FOLDERS = [
  { id: 'deals',   label: 'Deals',    icon: Briefcase,   kind: 'deals'  },
  { id: 'triage',  label: 'Triage',   icon: Inbox,       kind: 'triage' },
  { id: 'inbox',   label: 'Inbox',    icon: Mail,        kind: 'gmail'  },
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

export function EmailsView({ folder = 'deals', onBack, onOpenDeal, onSelectFolder }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const active = FOLDER_BY_ID[folder] ? folder : 'deals';
  const def = FOLDER_BY_ID[active];

  const connected = !!(state.gmailAccount && state.gmailAccount.connected);
  const [search, setSearch] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [openMsg, setOpenMsg] = useState(null);   // { kind, id, threadId, ... } for the reading modal
  const [assigning, setAssigning] = useState(null); // triage row being assigned

  // Reset the search box when switching folders.
  useEffect(() => { setSearch(''); setAppliedQuery(''); }, [active]);

  // Load the active folder. DB folders are cached after first load; Gmail
  // folders too (the Refresh button forces a reload).
  useEffect(() => {
    if (def.kind === 'deals') {
      if (!state.mailbox?.deals?.loaded) actions.loadDealEmails();
    } else if (def.kind === 'triage') {
      actions.refreshTriage();
    } else if (def.kind === 'gmail' && connected) {
      if (!state.mailbox?.[active]?.loaded) actions.loadMailboxFolder(active);
    }
  }, [active, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sidebar badge counts (Gmail unread). Cheap; refreshed on mount + reconnect.
  useEffect(() => { if (connected) actions.loadMailboxLabels(); }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const slice = state.mailbox?.[active] || {};
  const rawRows = def.kind === 'triage' ? (state.triage || []) : (slice.rows || []);

  // deals/triage search filters in memory; Gmail folders search server-side.
  const rows = useMemo(() => {
    if (def.kind === 'gmail') return rawRows;
    const q = search.trim().toLowerCase();
    if (!q) return rawRows;
    return rawRows.filter((r) => {
      const hay = [r.subject, r.snippet, r.fromEmail, ...(r.toEmails || [])].join(' ').toLowerCase();
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
  const inboxUnread = state.mailboxLabels?.INBOX?.unread || 0;
  const spamCount = state.mailboxLabels?.SPAM?.unread || 0;

  const badgeFor = (f) => {
    if (f.id === 'triage') return triageBadge || null;
    if (f.id === 'inbox') return inboxUnread || null;
    if (f.id === 'spam') return spamCount || null;
    return null;
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: isMobile ? '14px 10px' : '28px 24px' }}>
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
          {/* Toolbar */}
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

          {/* Folder description */}
          {def.kind === 'deals' && (
            <p style={{ fontSize: 12.5, color: BRAND.muted, margin: '0 0 12px' }}>
              Every email linked to an active deal, newest first. Emails on Lost deals stay in the Gmail folders.
            </p>
          )}
          {def.kind === 'triage' && (
            <p style={{ fontSize: 12.5, color: BRAND.muted, margin: '0 0 12px' }}>
              Emails that didn't match any deal automatically. Assign them to the right deal, or dismiss if they're personal/spam.
            </p>
          )}

          {/* Gmail not connected */}
          {def.kind === 'gmail' && !connected ? (
            <NotConnected onConnect={() => actions.connectGmail().then((url) => { if (url) window.location.href = url; })} />
          ) : (
            <Body
              def={def}
              rows={rows}
              loading={!!slice.loading}
              hasMore={slice.next != null}
              onLoadMore={loadMore}
              onOpen={(row) => setOpenMsg(toOpenRef(def, row))}
              onAssign={(row) => setAssigning(row)}
              onDismiss={(row) => { if (window.confirm('Dismiss this thread? It stays archived but leaves triage.')) { actions.triageDismiss(row.gmailThreadId); showMsg('Dismissed'); } }}
              onAction={(action, id) => doAction(actions, active, action, id, showMsg)}
            />
          )}
        </div>
      </div>

      {openMsg && (
        <EmailDetailModal
          openRef={openMsg}
          folder={active}
          folderKind={def.kind}
          connected={connected}
          onClose={() => setOpenMsg(null)}
          onOpenDeal={onOpenDeal}
        />
      )}
      {assigning && (
        <AssignModal
          message={assigning}
          onClose={() => setAssigning(null)}
          onAssign={async (gmailThreadId, dealId) => { await actions.triageAssign(gmailThreadId, dealId); showMsg('Assigned to deal'); setAssigning(null); }}
          onOpenDeal={onOpenDeal}
        />
      )}
    </div>
  );
}

// Normalise a list row into the reference the reading modal loads from.
function toOpenRef(def, row) {
  if (def.kind === 'gmail') {
    return { kind: 'gmail', id: row.id, threadId: row.threadId, unread: row.unread };
  }
  // deals + triage rows are DB-backed email_messages.
  return { kind: 'db', id: row.gmailMessageId, threadId: row.gmailThreadId };
}

function doAction(actions, folder, action, id, showMsg) {
  actions.mailboxAction(folder, action, id)
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

function Body({ def, rows, loading, hasMore, onLoadMore, onOpen, onAssign, onDismiss, onAction }) {
  if (loading && rows.length === 0) {
    return <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>Loading…</div>;
  }
  if (rows.length === 0) {
    return (
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>
        {def.kind === 'triage' ? 'Nothing to triage.' : def.kind === 'deals' ? 'No emails linked to active deals yet.' : 'This folder is empty.'}
      </div>
    );
  }
  return (
    <>
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
        {def.kind === 'triage'
          ? rows.map((m, i) => (
              <ThreadRow key={m.gmailMessageId} message={m} first={i === 0} onAssign={() => onAssign(m)} onDismiss={() => onDismiss(m)} />
            ))
          : def.kind === 'gmail'
            ? rows.map((m, i) => <GmailRow key={m.id} row={m} folder={def.id} first={i === 0} onOpen={() => onOpen(m)} onAction={onAction} />)
            : rows.map((m, i) => <DealEmailRow key={m.gmailMessageId} row={m} first={i === 0} onOpen={() => onOpen(m)} />)}
      </div>
      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button onClick={onLoadMore} className="btn-ghost" disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>
        </div>
      )}
    </>
  );
}

// A row in the DB-backed Deals folder. Shows direction + deal chips.
function DealEmailRow({ row, first, onOpen }) {
  const inbound = row.direction === 'inbound';
  const counterparty = inbound ? row.fromEmail : (row.toEmails?.[0] || '');
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
        <div style={{ fontWeight: 600, fontSize: 14, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {row.subject || <span style={{ color: BRAND.muted, fontStyle: 'italic' }}>(no subject)</span>}
        </div>
        {row.snippet && (
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.snippet}</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
          {(row.dealTitles || []).slice(0, 3).map((t, i) => (
            <span key={i} style={{ fontSize: 10.5, fontWeight: 600, color: '#0D47A1', background: '#E3F2FD', padding: '1px 7px', borderRadius: 10, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t}
            </span>
          ))}
        </div>
      </div>
      <div style={{ flexShrink: 0, textAlign: 'right', fontSize: 11, color: BRAND.muted }}>
        <div>{formatRelativeTime(row.sentAt)}</div>
        <div style={{ marginTop: 2 }}>{inbound ? 'from' : 'to'} {counterparty || '—'}</div>
      </div>
    </button>
  );
}

// A row in a live Gmail folder, with inline star + quick actions.
function GmailRow({ row, folder, first, onOpen, onAction }) {
  const sender = displayName(row.from) || row.fromEmail || '(unknown)';
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
        <span style={{ width: 160, flexShrink: 0, fontSize: 13, fontWeight: row.unread ? 700 : 500, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sender}
        </span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: row.unread ? 700 : 500 }}>{row.subject || '(no subject)'}</span>
          {row.snippet && <span style={{ color: BRAND.muted, fontWeight: 400 }}> — {row.snippet}</span>}
        </span>
      </button>
      <span style={{ flexShrink: 0, fontSize: 11, color: BRAND.muted, width: 64, textAlign: 'right' }}>{formatRelativeTime(row.date)}</span>
      <div style={{ flexShrink: 0, display: 'flex', gap: 2 }}>
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

// Full-message reading modal. Loads the body from the right source based on
// folderKind: live Gmail (loadMailboxMessage) vs DB email (loadEmailBody).
function EmailDetailModal({ openRef, folder, folderKind, connected, onClose, onOpenDeal }) { // eslint-disable-line no-unused-vars
  const { state, actions, showMsg } = useStore();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const isGmail = openRef.kind === 'gmail';
  const cached = isGmail ? state.mailboxMessages?.[openRef.id] : state.emailBodies?.[openRef.id];

  useEffect(() => {
    let cancelled = false;
    setError('');
    setLoading(!cached);
    const loader = isGmail ? actions.loadMailboxMessage(openRef.id) : actions.loadEmailBody(openRef.id);
    loader.then(() => { if (!cancelled) setLoading(false); })
          .catch((e) => { if (!cancelled) { setError(e?.message || 'Failed to load'); setLoading(false); } });
    // Mark a freshly-opened unread Gmail message as read (mirrors Gmail).
    if (isGmail && openRef.unread) actions.mailboxAction(folder, 'markRead', openRef.id);
    return () => { cancelled = true; };
  }, [openRef.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const msg = useMemo(() => normaliseMessage(openRef, cached), [openRef, cached]);

  const sanitized = useMemo(() => {
    if (!msg?.html) return null;
    return DOMPurify.sanitize(msg.html, VIEW_SANITIZE);
  }, [msg?.html]);

  // Already-sanitized body for quoting (never inject raw email HTML into the
  // composer's contentEditable).
  const bodyForQuote = sanitized || (msg?.text ? escapeText(msg.text).replace(/\n/g, '<br>') : '');

  const reply = (all = false) => {
    const subject = msg.subject || '';
    const quoted = `<br><br><div style="border-left:2px solid #ccc;padding-left:12px;color:#555;">`
      + `On ${msg.dateLabel}, ${escapeText(msg.from || msg.fromEmail || '')} wrote:<br>`
      + bodyForQuote + '</div>';
    actions.openComposer({
      initialDraft: {
        to: msg.fromEmail || '',
        cc: all ? (msg.cc || []).join(', ') : '',
        subject: /^re:/i.test(subject) ? subject : 'Re: ' + subject,
        body: quoted,
        gmailThreadId: msg.threadId || null,
      },
    });
    onClose();
  };

  const forward = () => {
    const subject = msg.subject || '';
    const quoted = `<br><br>---------- Forwarded message ----------<br>`
      + `From: ${escapeText(msg.from || msg.fromEmail || '')}<br>Subject: ${escapeText(subject)}<br><br>`
      + bodyForQuote;
    actions.openComposer({ initialDraft: { to: '', subject: /^fwd:/i.test(subject) ? subject : 'Fwd: ' + subject, body: quoted } });
    onClose();
  };

  const continueDraft = () => {
    actions.openComposer({
      initialDraft: {
        to: (msg.to || []).join(', '),
        cc: (msg.cc || []).join(', '),
        subject: msg.subject || '',
        body: bodyForQuote,
        gmailThreadId: msg.threadId || null,
      },
    });
    onClose();
  };

  const act = (action) => {
    actions.mailboxAction(folder, action, openRef.id)
      .then(() => { showMsg(ACTION_TOAST[action] || 'Done'); onClose(); })
      .catch(() => showMsg('Action failed'));
  };

  const gmailWeb = msg?.threadId ? `https://mail.google.com/mail/u/0/#all/${msg.threadId}` : null;

  return (
    <Modal onClose={onClose} maxWidth={760}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, wordBreak: 'break-word' }}>{msg?.subject || '(no subject)'}</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>
      {msg && (
        <div style={{ fontSize: 12.5, color: BRAND.muted, marginBottom: 12, lineHeight: 1.6 }}>
          <div><strong style={{ color: BRAND.ink }}>{msg.from || msg.fromEmail || '—'}</strong></div>
          {msg.to?.length ? <div>to {msg.to.join(', ')}</div> : null}
          {msg.cc?.length ? <div>cc {msg.cc.join(', ')}</div> : null}
          <div>{msg.dateLabel}</div>
        </div>
      )}

      {/* Action bar — only once the message has loaded (reply/forward read it). */}
      {msg && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingBottom: 12, marginBottom: 12, borderBottom: '1px solid ' + BRAND.border }}>
          {folder === 'drafts'
            ? <button onClick={continueDraft} className="btn"><PenSquare size={14} /> Continue in composer</button>
            : <button onClick={() => reply(false)} className="btn"><Reply size={14} /> Reply</button>}
          {folder !== 'drafts' && <button onClick={forward} className="btn-ghost"><Forward size={14} /> Forward</button>}
          {isGmail && folder !== 'sent' && folder !== 'drafts' && folder !== 'trash' && folder !== 'spam' && (
            <button onClick={() => act('archive')} className="btn-ghost"><Archive size={14} /> Archive</button>
          )}
          {isGmail && (folder === 'trash'
            ? <button onClick={() => act('untrash')} className="btn-ghost"><RefreshCw size={14} /> Restore</button>
            : <button onClick={() => act('trash')} className="btn-ghost"><Trash2 size={14} /> Delete</button>)}
          {isGmail && folder !== 'spam' && folder !== 'drafts' && <button onClick={() => act('spam')} className="btn-ghost"><ShieldAlert size={14} /> Spam</button>}
          {isGmail && folder === 'spam' && <button onClick={() => act('unspam')} className="btn-ghost"><ShieldAlert size={14} /> Not spam</button>}
          {isGmail && folder !== 'drafts' && <button onClick={() => act('markUnread')} className="btn-ghost"><MailOpen size={14} /> Mark unread</button>}
          {gmailWeb && <a href={gmailWeb} target="_blank" rel="noreferrer" className="btn-ghost" style={{ textDecoration: 'none' }}><ExternalLink size={14} /> Gmail</a>}
        </div>
      )}

      {loading && <div style={{ color: BRAND.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>Loading…</div>}
      {error && <div style={{ color: '#DC2626', fontSize: 13 }}>{error}</div>}
      {!loading && !error && msg && (
        <>
          <div className="email-body" style={{ fontSize: 13.5, lineHeight: 1.6, wordBreak: 'break-word', maxHeight: '52vh', overflowY: 'auto' }}>
            {sanitized
              ? <div dangerouslySetInnerHTML={{ __html: sanitized }} />
              : msg.text
                ? <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0 }}>{msg.text}</pre>
                : <div style={{ color: BRAND.muted, fontStyle: 'italic' }}>(no body)</div>}
          </div>
          {msg.attachments?.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid ' + BRAND.border }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                <Paperclip size={12} style={{ verticalAlign: -1 }} /> {msg.attachments.length} attachment{msg.attachments.length > 1 ? 's' : ''}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {msg.attachments.map((a, i) => (
                  <AttachmentChip key={i} att={a} messageId={openRef.id} connected={connected} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function AttachmentChip({ att, messageId, connected }) {
  const id = att.attachmentId;
  const href = (connected && id)
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

// Merge the list-row hint with the loaded body into one shape the modal renders.
function normaliseMessage(openRef, cached) {
  if (!cached) return null;
  if (openRef.kind === 'gmail') {
    return {
      subject: cached.subject, from: cached.from, fromEmail: cached.fromEmail,
      to: cached.to || [], cc: cached.cc || [],
      html: cached.html, text: cached.text, attachments: cached.attachments || [],
      threadId: cached.threadId, dateLabel: formatDateLabel(cached.date),
    };
  }
  // DB email body (loadEmailBody shape).
  return {
    subject: cached.subject, from: cached.fromEmail, fromEmail: cached.fromEmail,
    to: cached.toEmails || [], cc: cached.ccEmails || [],
    html: cached.bodyHtml, text: cached.bodyText, attachments: cached.attachments || [],
    threadId: cached.gmailThreadId, dateLabel: formatDateLabel(cached.sentAt),
  };
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
