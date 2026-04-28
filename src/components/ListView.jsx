import React, { useState } from 'react';
import { Download, Eye, FileText, Link2, Mail, Plus, Search, Trash2, Users, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { formatGBP, useIsMobile } from '../utils.js';
import { openPrintWindow } from '../utils/printProposal.js';
import { Badge, Logo } from './ui.jsx';

export function ListView({ onCreate, onOpen, onPreview, onDelete, onDeleteTemplate, onLogout, onManageUsers, onManageNotifications }) {
  const { state, showMsg } = useStore();
  const [search, setSearch] = useState('');
  const isMobile = useIsMobile();

  const proposals = Object.entries(state.proposals)
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const templates = Object.entries(state.templates)
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const filtered = search.trim()
    ? proposals.filter((p) => {
        const q = search.toLowerCase();
        return (
          (p.clientName || '').toLowerCase().includes(q) ||
          (p.contactBusinessName || '').toLowerCase().includes(q) ||
          (p.preparedBy || '').toLowerCase().includes(q) ||
          (p.date || '').toLowerCase().includes(q)
        );
      })
    : proposals;

  const user = state.session;

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
          <button onClick={onManageNotifications} className="btn-ghost"><Mail size={14} /> Notifications</button>
          <button onClick={onManageUsers} className="btn-ghost"><Users size={14} /> Users</button>
          <button onClick={onLogout} className="btn-ghost">Sign out</button>
          <button onClick={onCreate} className="btn"><Plus size={16} /> New Proposal</button>
        </div>
      </header>

      {templates.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 className="section-label">Templates</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {templates.map((t) => (
              <div key={t.id} style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <FileText size={13} color={BRAND.blue} />
                    <span style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                  </div>
                  <div style={{ fontSize: 11, color: BRAND.muted }}>
                    {formatGBP(t.basePrice * (1 + t.vatRate))} · {(t.optionalExtras || []).length} extras
                  </div>
                </div>
                <button onClick={() => onDeleteTemplate(t.id)} aria-label={'Delete template ' + t.name} className="btn-icon is-danger"><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

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
              placeholder="Search by client, business, date..."
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
            <ProposalCard key={p.id} proposal={p} onOpen={onOpen} onPreview={onPreview} onDelete={onDelete} showMsg={showMsg} />
          ))}
        </div>
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

function ProposalCard({ proposal, onOpen, onPreview, onDelete, showMsg }) {
  const { state } = useStore();
  const signed = state.signatures[proposal.id];
  const payment = state.payments[proposal.id];
  const viewed = state.views[proposal.id];
  const isMobile = useIsMobile();

  const copyLink = () => {
    showMsg('Share link: #view/' + proposal.id + ' (will work on real domain after deploy)');
  };

  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: isMobile ? 12 : 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: isMobile ? 10 : 16, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: isMobile ? 14 : 16, fontWeight: 600 }}>{proposal.clientName || 'Untitled Proposal'}</h3>
          {signed
            ? <Badge color="green">ACCEPTED</Badge>
            : viewed
              ? <Badge color="yellow">OPENED</Badge>
              : <Badge color="grey">SENT</Badge>}
          {payment && <Badge color="blue">PAID {formatGBP(payment.amount)}</Badge>}
          {signed && !payment && <Badge color="orange">AWAITING PAYMENT</Badge>}
        </div>
        <div style={{ fontSize: isMobile ? 11 : 13, color: BRAND.muted, display: 'flex', gap: isMobile ? 10 : 16, flexWrap: 'wrap' }}>
          <span>{proposal.contactBusinessName || '—'}</span>
          <span>{proposal.date}</span>
          <span>{formatGBP(proposal.basePrice * (1 + proposal.vatRate))}</span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 4 : 8, flexWrap: 'wrap' }}>
        {!isMobile && <CreatorAvatar proposal={proposal} />}
        {!isMobile && <div style={{ width: 1, height: 24, background: BRAND.border, flexShrink: 0 }} />}
        <button onClick={copyLink} className="btn-icon" title="Share link" aria-label="Copy share link"><Link2 size={16} /></button>
        <button onClick={() => openPrintWindow(proposal)} className="btn-icon" title="Download PDF" aria-label="Download PDF"><Download size={16} /></button>
        <button onClick={() => onPreview(proposal.id)} className="btn-icon" title="Preview" aria-label="Preview proposal"><Eye size={16} /></button>
        <button onClick={() => onOpen(proposal.id)} className="btn-icon" title="Edit" aria-label="Edit proposal">Edit</button>
        <button onClick={() => onDelete(proposal.id)} className="btn-icon is-danger" title="Delete" aria-label="Delete proposal"><Trash2 size={16} /></button>
      </div>
    </div>
  );
}
