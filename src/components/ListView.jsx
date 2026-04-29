import React, { useState } from 'react';
import { BarChart3, Clock, Download, Eye, FileText, LayoutTemplate, Link2, Mail, Plus, Search, Trash2, Trophy, Users, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { formatDuration, formatGBP, formatProposalNumber, formatRelativeTime, useIsMobile } from '../utils.js';
import { openPrintWindow } from '../utils/printProposal.js';
import { Badge, Logo } from './ui.jsx';
import { ViewAnalyticsModal } from './ViewAnalyticsModal.jsx';

export function ListView({ onCreate, onOpen, onPreview, onDelete, onLogout, onManageUsers, onManageNotifications, onManageAccount, onManageTemplates, onManageLeaderboard }) {
  const { state, showMsg } = useStore();
  const [search, setSearch] = useState('');
  const [analyticsId, setAnalyticsId] = useState(null);
  const isMobile = useIsMobile();

  const proposals = Object.entries(state.proposals)
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const filtered = search.trim()
    ? proposals.filter((p) => {
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
    : proposals;

  const user = state.session;
  const analyticsProposal = analyticsId ? proposals.find((p) => p.id === analyticsId) : null;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '20px 16px' : '40px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32, gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
            <Logo size={36} />
            <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Squideo Proposals</h1>
          </div>
          <p style={{ fontSize: 14, color: BRAND.muted, margin: 0, marginLeft: 48 }}>
            Signed in as <strong style={{ color: BRAND.ink }}>{user.name}</strong> · Shared workspace
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={onManageLeaderboard} className="btn-ghost"><Trophy size={14} /> Leaderboard</button>
          <button onClick={onManageTemplates} className="btn-ghost"><LayoutTemplate size={14} /> Templates</button>
          <button onClick={onManageNotifications} className="btn-ghost"><Mail size={14} /> Notifications</button>
          <button onClick={onManageUsers} className="btn-ghost"><Users size={14} /> Users</button>
          <button onClick={onLogout} className="btn-ghost">Sign out</button>
          <button
            onClick={onManageAccount}
            aria-label="My account"
            style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', padding: 0, cursor: 'pointer', overflow: 'hidden', flexShrink: 0 }}
          >
            {user.avatar
              ? <img src={user.avatar} alt={user.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <div style={{ width: '100%', height: '100%', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15 }}>{(user.name || '?')[0].toUpperCase()}</div>
            }
          </button>
          <button onClick={onCreate} className="btn"><Plus size={16} /> New Proposal</button>
        </div>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 className="section-label" style={{ margin: 0 }}>
          Proposals {search && <span style={{ color: BRAND.blue, textTransform: 'none', letterSpacing: 0 }}>· {filtered.length} of {proposals.length}</span>}
        </h2>
        {proposals.length > 0 && (
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
            No proposals match "<strong>{search}</strong>". Try a different search term.
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

function CreatorAvatar({ proposal }) {
  const { state } = useStore();
  const creator = state.users[proposal.preparedByEmail];
  const name = creator?.name || proposal.preparedBy || '?';
  const initial = name[0].toUpperCase();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 24, height: 24, borderRadius: '50%', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12, flexShrink: 0 }}>
        {initial}
      </div>
      <span>{name}</span>
    </div>
  );
}

function ProposalCard({ proposal, onOpen, onPreview, onDelete, onAnalytics, showMsg }) {
  const { state } = useStore();
  const signed = state.signatures[proposal.id];
  const payment = state.payments[proposal.id];
  const views = proposal._views || { opens: 0, duration: 0 };
  const opened = views.opens > 0;
  const isMobile = useIsMobile();

  const number = proposal._number ? formatProposalNumber(proposal._number) : '';

  const copyLink = () => {
    const url = 'https://squideo-proposals-tu96.vercel.app/?proposal=' + proposal.id;
    navigator.clipboard.writeText(url)
      .then(() => showMsg('Link copied to clipboard'))
      .catch(() => showMsg('Copy failed — link: ' + url));
  };

  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: isMobile ? 12 : 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: isMobile ? 10 : 16, flexWrap: 'wrap' }}>
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
        <div style={{ fontSize: isMobile ? 11 : 13, color: BRAND.muted, display: 'flex', gap: isMobile ? 10 : 16, flexWrap: 'wrap' }}>
          <span>{proposal.contactBusinessName || '—'}</span>
          <span>{proposal.date}</span>
          <span>{formatGBP(proposal.basePrice * (1 + proposal.vatRate))}</span>
          {opened && (
            <button
              onClick={onAnalytics}
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
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 4 : 8, flexWrap: 'wrap' }}>
        {!isMobile && <CreatorAvatar proposal={proposal} />}
        {!isMobile && <div style={{ width: 1, height: 24, background: BRAND.border, flexShrink: 0 }} />}
        <button onClick={onAnalytics} className="btn-icon" title="View analytics" aria-label="View analytics"><BarChart3 size={16} /></button>
        <button onClick={copyLink} className="btn-icon" title="Share link" aria-label="Copy share link"><Link2 size={16} /></button>
        <button onClick={() => openPrintWindow(proposal)} className="btn-icon" title="Download PDF" aria-label="Download PDF"><Download size={16} /></button>
        <button onClick={() => onPreview(proposal.id)} className="btn-icon" title="Preview" aria-label="Preview proposal"><Eye size={16} /></button>
        <button onClick={() => onOpen(proposal.id)} className="btn-icon" title="Edit" aria-label="Edit proposal">Edit</button>
        <button onClick={() => onDelete(proposal.id)} className="btn-icon is-danger" title="Delete" aria-label="Delete proposal"><Trash2 size={16} /></button>
      </div>
    </div>
  );
}
