import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, BarChart3, Check, CheckSquare, Clock, Contact, Copy, Coins, Download, ExternalLink, Eye, FileText, Inbox, KanbanSquare, LayoutTemplate, Link2, Mail, MailQuestion, MoreVertical, Plus, Receipt, Search, Trash2, Trophy, Undo2, Users, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { formatDuration, formatGBP, formatProposalNumber, formatRelativeTime, useIsMobile } from '../utils.js';
import { openPrintWindow, printOptionsForSigned } from '../utils/printProposal.js';
import { Badge, Logo } from './ui.jsx';
import { ViewAnalyticsModal } from './ViewAnalyticsModal.jsx';

const TEAM_FILTER_STORAGE_KEY = 'squideo.dashboard.teamMemberFilter';

export function ListView({ onCreate, onOpen, onPreview, onDelete, onDuplicate, onManageUsers, onManageNotifications, onManageAccount, onManageTemplates, onManageLeaderboard, onManagePartnerCredits, onManagePipeline, onManageContacts, onManageTasks, onManageTriage, onManageQuoteRequests, onManageXeroDuplicates }) {
  const { state, showMsg } = useStore();
  const [search, setSearch] = useState('');
  const [memberFilter, setMemberFilter] = useState(() => {
    try {
      const stored = localStorage.getItem(TEAM_FILTER_STORAGE_KEY);
      if (stored !== null) return stored;
    } catch {}
    return state.session?.email || '';
  });
  useEffect(() => {
    try { localStorage.setItem(TEAM_FILTER_STORAGE_KEY, memberFilter); } catch {}
  }, [memberFilter]);
  const openTasksDue = (state.tasks || []).filter(t => !t.doneAt && t.dueAt && new Date(t.dueAt).getTime() <= Date.now() + 24 * 60 * 60 * 1000).length;
  const triageCount = (state.triage || []).length;
  const newQuoteRequestsCount = (state.quoteRequests || []).filter(q => q.status === 'new').length;
  const [analyticsId, setAnalyticsId] = useState(null);
  const isMobile = useIsMobile();

  const proposals = Object.entries(state.proposals)
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const memberOptions = Object.entries(state.users || {})
    .map(([email, u]) => ({ email, name: u.name || email }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const afterMember = memberFilter
    ? proposals.filter((p) => p.preparedByEmail === memberFilter)
    : proposals;

  const filtered = search.trim()
    ? afterMember.filter((p) => {
        const q = search.toLowerCase();
        const num = p._number ? formatProposalNumber(p._number).toLowerCase() : '';
        return (
          (p.clientName || '').toLowerCase().includes(q) ||
          (p.contactBusinessName || '').toLowerCase().includes(q) ||
          (p.preparedBy || '').toLowerCase().includes(q) ||
          (p.date || '').toLowerCase().includes(q) ||
          num.includes(q)
        );
      })
    : afterMember;

  const memberFilterName = memberFilter
    ? (state.users?.[memberFilter]?.name || memberFilter)
    : '';
  const filtersActive = Boolean(search.trim() || memberFilter);

  const sessionUser = state.session;
  const userRecord = state.users[sessionUser?.email];
  const user = {
    ...sessionUser,
    avatar: sessionUser?.avatar ?? userRecord?.avatar ?? null,
    name: sessionUser?.name || userRecord?.name || '',
  };
  const analyticsProposal = analyticsId ? proposals.find((p) => p.id === analyticsId) : null;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '20px 16px' : '40px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32, gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
            <Logo size={36} />
            <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Squideo CRM</h1>
          </div>
          <p style={{ fontSize: 14, color: BRAND.muted, margin: 0, marginLeft: 48 }}>
            Signed in as <strong style={{ color: BRAND.ink }}>{user.name}</strong> · Shared workspace
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {onManageQuoteRequests && (
            <button onClick={onManageQuoteRequests} className="btn-ghost">
              <MailQuestion size={14} /> Quote Requests
              {newQuoteRequestsCount > 0 && (
                <span style={{ background: '#FB923C', color: 'white', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, marginLeft: 4 }}>
                  {newQuoteRequestsCount}
                </span>
              )}
            </button>
          )}
          {onManagePipeline && <button onClick={onManagePipeline} className="btn-ghost"><KanbanSquare size={14} /> Pipeline</button>}
          {onManageContacts && <button onClick={onManageContacts} className="btn-ghost"><Contact size={14} /> Contacts</button>}
          {onManageTasks && (
            <button onClick={onManageTasks} className="btn-ghost">
              <CheckSquare size={14} /> Tasks
              {openTasksDue > 0 && (
                <span style={{ background: '#FB923C', color: 'white', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, marginLeft: 4 }}>
                  {openTasksDue}
                </span>
              )}
            </button>
          )}
          {onManageTriage && triageCount > 0 && (
            <button onClick={onManageTriage} className="btn-ghost">
              <Inbox size={14} /> Triage
              <span style={{ background: '#FB923C', color: 'white', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, marginLeft: 4 }}>
                {triageCount}
              </span>
            </button>
          )}
          <button onClick={onManageLeaderboard} className="btn-ghost"><Trophy size={14} /> Leaderboard</button>
          <button onClick={onManagePartnerCredits} className="btn-ghost"><Coins size={14} /> Partner Credits</button>
          <button onClick={onManageTemplates} className="btn-ghost"><LayoutTemplate size={14} /> Templates</button>
          {onManageXeroDuplicates && user.role === 'admin' && (
            <button onClick={onManageXeroDuplicates} className="btn-ghost"><AlertTriangle size={14} /> Xero Duplicates</button>
          )}
          <button onClick={onManageNotifications} className="btn-ghost"><Mail size={14} /> Notifications</button>
          <button onClick={onManageUsers} className="btn-ghost"><Users size={14} /> Users</button>
          <button
            onClick={onManageAccount}
            className="btn-ghost"
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px 4px 6px', borderRadius: 20 }}
          >
            {user.avatar
              ? <img src={user.avatar} alt={user.name} style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }} />
              : <div style={{ width: 24, height: 24, borderRadius: '50%', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 11 }}>{(user.name || '?')[0].toUpperCase()}</div>
            }
            Account
          </button>
          <button onClick={onCreate} className="btn"><Plus size={16} /> New Proposal</button>
        </div>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 className="section-label" style={{ margin: 0 }}>
          {!memberFilter
            ? 'All proposals'
            : memberFilter === state.session?.email
            ? 'My proposals'
            : `${memberFilterName.split(' ')[0]}'s proposals`}
          {filtersActive && <span style={{ color: BRAND.blue, textTransform: 'none', letterSpacing: 0 }}> · {filtered.length} of {proposals.length}</span>}
        </h2>
        {proposals.length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', width: isMobile ? '100%' : 'auto' }}>
            <select
              value={memberFilter}
              onChange={(e) => setMemberFilter(e.target.value)}
              className="input"
              aria-label="Filter by team member"
              style={{ width: isMobile ? '100%' : 200 }}
            >
              <option value="">All team members</option>
              {memberOptions.map((m) => (
                <option key={m.email} value={m.email}>{m.name}</option>
              ))}
            </select>
            <div style={{ position: 'relative', width: isMobile ? '100%' : 260 }}>
              <Search size={14} color={BRAND.muted} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by number, client, business..."
                className="input"
                style={{ paddingLeft: 34, paddingRight: search ? 34 : 12 }}
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', color: BRAND.muted }}
                  title="Clear search"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {proposals.length === 0 ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 60, textAlign: 'center' }}>
          <FileText size={40} color={BRAND.muted} style={{ marginBottom: 12 }} />
          <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>No proposals yet</h3>
          <p style={{ color: BRAND.muted, fontSize: 14, margin: '0 0 20px' }}>Create your first proposal.</p>
          <button onClick={onCreate} className="btn"><Plus size={16} /> Create proposal</button>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 40, textAlign: 'center' }}>
          <Search size={32} color={BRAND.muted} style={{ marginBottom: 8 }} />
          <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>No matches</h3>
          <p style={{ color: BRAND.muted, fontSize: 13, margin: 0 }}>
            {search.trim() && memberFilter
              ? <>No proposals for <strong>{memberFilterName}</strong> match "<strong>{search}</strong>".</>
              : search.trim()
              ? <>No proposals match "<strong>{search}</strong>". Try a different search term.</>
              : <>No proposals for <strong>{memberFilterName}</strong> yet.</>}
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {filtered.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              onOpen={onOpen}
              onPreview={onPreview}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onAnalytics={() => setAnalyticsId(p.id)}
              showMsg={showMsg}
            />
          ))}
        </div>
      )}

      {analyticsProposal && (
        <ViewAnalyticsModal proposal={analyticsProposal} onClose={() => setAnalyticsId(null)} />
      )}
    </div>
  );
}

function CreatorAvatar({ proposal, size = 24, showName = true }) {
  const { state } = useStore();
  const creator = state.users[proposal.preparedByEmail];
  const name = creator?.name || proposal.preparedBy || '?';
  const initial = name[0].toUpperCase();
  const avatar = creator?.avatar;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} title={name}>
      <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: Math.round(size * 0.5), flexShrink: 0 }}>
        {avatar
          ? <img src={avatar} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : initial}
      </div>
      {showName && <span>{name}</span>}
    </div>
  );
}

function ProposalCard({ proposal, onOpen, onPreview, onDelete, onDuplicate, onAnalytics, showMsg }) {
  const { state, actions } = useStore();
  const signed = state.signatures[proposal.id];
  const payment = state.payments[proposal.id];
  const views = proposal._views || { opens: 0, duration: 0 };
  const opened = views.opens > 0;
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);

  const number = proposal._number ? formatProposalNumber(proposal._number) : '';

  const copyLink = () => {
    const url = 'https://app.squideo.com/?proposal=' + proposal.id;
    navigator.clipboard.writeText(url)
      .then(() => showMsg('Link copied to clipboard'))
      .catch(() => showMsg('Copy failed — link: ' + url));
  };

  const handleMarkPaid = () => {
    const totalNum = Number(proposal.basePrice) * (1 + Number(proposal.vatRate || 0));
    const defaultStr = (Number.isFinite(totalNum) ? totalNum : 0).toFixed(2);
    const input = window.prompt('Mark as paid — enter the amount received (£):', defaultStr);
    if (input === null) return;
    const amount = parseFloat(input);
    if (!Number.isFinite(amount) || amount < 0) {
      showMsg('Invalid amount');
      return;
    }
    actions.markAsPaid(proposal.id, amount);
    showMsg('Marked as paid: ' + formatGBP(amount));
  };

  const handleUnmarkAccepted = () => {
    // If a Xero invoice was issued for this proposal (email-invoice route),
    // the server-side DELETE /api/signatures voids it and clears the
    // billing ref. Surface that in the confirm so the team knows the
    // invoice in Xero is about to change state, not just our dashboard.
    const message = proposal._hasXeroInvoice
      ? 'Remove the signature for this proposal? It will be marked as not yet accepted, and the linked Xero invoice will be voided.'
      : 'Remove the signature for this proposal? It will be marked as not yet accepted.';
    if (!window.confirm(message)) return;
    actions.removeSignature(proposal.id);
    showMsg('Signature removed');
  };

  const accentColour = payment ? '#10B981'
    : signed ? BRAND.blue
    : opened ? '#F59E0B'
    : '#CBD5E1';

  const hasVat = Number(proposal.vatRate) > 0;
  const figure = formatGBP(proposal.basePrice);

  const handleCardClick = () => onPreview(proposal.id);
  const handleCardKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPreview(proposal.id);
    }
  };
  const stop = (e) => e.stopPropagation();

  return (
    <div
      className="proposal-card"
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleCardKey}
      aria-label={`Preview proposal for ${proposal.clientName || 'untitled'}`}
      style={{
        position: 'relative',
        zIndex: menuOpen ? 50 : 'auto',
        background: 'white',
        border: '1px solid ' + BRAND.border,
        borderLeft: '4px solid ' + accentColour,
        borderRadius: 10,
        padding: isMobile ? 12 : 20,
        paddingLeft: isMobile ? 8 : 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: isMobile ? 10 : 16,
        flexWrap: 'wrap',
        cursor: 'pointer',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
          {number && (
            <span style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, background: '#F1F5F9', padding: '2px 7px', borderRadius: 6, letterSpacing: 0.4 }}>
              {number}
            </span>
          )}
          <h3 style={{ margin: 0, fontSize: isMobile ? 14 : 16, fontWeight: 600 }}>{proposal.clientName || 'Untitled Proposal'}</h3>
          {signed && <Badge color="green">ACCEPTED</Badge>}
          {!signed && opened && <Badge color="yellow">OPENED</Badge>}
          {payment && <Badge color="blue">PAID {formatGBP(payment.amount)}</Badge>}
          {signed && !payment && <Badge color="orange">AWAITING PAYMENT</Badge>}
        </div>
        <div style={{ fontSize: isMobile ? 11 : 13, color: BRAND.muted, display: 'flex', gap: isMobile ? 10 : 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>{proposal.contactBusinessName || '—'}</span>
          <span>{proposal.date}</span>
          {opened && (
            <button
              onClick={(e) => { stop(e); onAnalytics(); }}
              title="View analytics"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', border: '1px solid ' + BRAND.border, borderRadius: 999, background: '#FFFBEB', color: '#92400E', fontWeight: 600, fontSize: isMobile ? 11 : 12, cursor: 'pointer' }}
            >
              <Eye size={11} />
              <span>{views.opens} {views.opens === 1 ? 'view' : 'views'}</span>
              <span style={{ opacity: 0.6 }}>·</span>
              <Clock size={11} />
              <span>{formatDuration(views.duration)}</span>
              {views.lastActiveAt && (
                <>
                  <span style={{ opacity: 0.6 }}>·</span>
                  <span>{formatRelativeTime(views.lastActiveAt)}</span>
                </>
              )}
            </button>
          )}
        </div>
        {isMobile && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: BRAND.ink, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
              {figure}
            </div>
            {hasVat && <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 1 }}>+VAT</div>}
          </div>
        )}
      </div>
      {!isMobile && (
        <div style={{ textAlign: 'right', minWidth: 90, fontVariantNumeric: 'tabular-nums' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: BRAND.ink, lineHeight: 1.1 }}>
            {figure}
          </div>
          {hasVat && <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>+VAT</div>}
        </div>
      )}
      <div onClick={stop} style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 4 : 8, flexWrap: 'wrap' }}>
        <div style={{ minWidth: isMobile ? 24 : 150, flexShrink: 0 }}>
          <CreatorAvatar proposal={proposal} size={isMobile ? 20 : 24} showName={!isMobile} />
        </div>
        {!isMobile && <div style={{ width: 1, height: 24, background: BRAND.border, flexShrink: 0 }} />}
        <button onClick={(e) => { stop(e); copyLink(); }} className="btn-icon" title="Share link" aria-label="Copy share link"><Link2 size={16} /></button>
        <button onClick={(e) => { stop(e); onOpen(proposal.id); }} className="btn-icon" title="Edit" aria-label="Edit proposal">Edit</button>
        <ActionMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          items={[
            { label: 'View analytics', icon: BarChart3, onClick: onAnalytics },
            { label: 'Preview', icon: Eye, onClick: () => onPreview(proposal.id) },
            {
              label: signed ? 'Download signed proposal' : 'Download PDF',
              icon: Download,
              onClick: () => openPrintWindow(proposal, signed ? printOptionsForSigned(signed, payment) : {}),
            },
            ...(onDuplicate ? [{ label: 'Duplicate proposal', icon: Copy, onClick: () => onDuplicate(proposal.id) }] : []),
            ...(signed && proposal._xeroInvoiceId
              ? [{ label: 'View invoice', icon: Receipt, onClick: () => window.open('/api/xero/invoice-pdf?invoiceId=' + encodeURIComponent(proposal._xeroInvoiceId), '_blank', 'noopener') }]
              : []),
            ...(signed && !payment ? [{ label: 'Mark as paid', icon: Check, onClick: handleMarkPaid }] : []),
            ...(signed && !payment ? [{ label: 'Unmark as accepted', icon: Undo2, onClick: handleUnmarkAccepted }] : []),
            { label: 'Delete', icon: Trash2, onClick: () => onDelete(proposal.id), danger: true },
          ]}
        />
      </div>
    </div>
  );
}

function ActionMenu({ items, open, onOpenChange }) {
  const setOpen = onOpenChange;
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const closeOnEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEsc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEsc);
    };
  }, [open, setOpen]);

  return (
    <div ref={ref} style={{ position: 'relative', zIndex: open ? 50 : 'auto' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="btn-icon"
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreVertical size={16} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            background: 'white',
            border: '1px solid ' + BRAND.border,
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(15, 42, 61, 0.12)',
            minWidth: 180,
            padding: 4,
            zIndex: 50,
          }}
        >
          {items.map((item, i) => (
            <button
              key={i}
              role="menuitem"
              onClick={() => { setOpen(false); item.onClick(); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '8px 10px',
                background: 'transparent',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 500,
                color: item.danger ? '#D32F2F' : BRAND.ink,
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = item.danger ? '#FFEBEE' : '#F1F5F9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <item.icon size={14} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
