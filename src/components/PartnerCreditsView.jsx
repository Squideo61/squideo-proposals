import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Coins, Plus, FolderOpen, CalendarClock, Building2, Check, Search, Trash2 } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { permissionsInclude } from '../lib/permissions.js';
import { formatGBP, useIsMobile } from '../utils.js';
import { api } from '../api.js';
import { Modal } from './ui.jsx';
import { XeroContactPicker } from './crm/XeroContactPicker.jsx';
import { PartnerMeetingsButton } from './PartnerMeetingsButton.jsx';
import { thisMonthStr, shiftMonth } from './crm/dateRange.jsx';

// Recent past months (excluding the current one), newest first, as 'YYYY-MM'.
function recentPastMonths(n = 6) {
  const out = [];
  const cur = thisMonthStr();
  for (let i = 1; i <= n; i++) out.push(shiftMonth(cur, -i));
  return out;
}
const monthPickLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
};

function fmtCredits(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function PartnerCreditsView({ onBack, onOpen, onOpenDeal }) {
  const { state, actions, showMsg } = useStore();
  const [loading, setLoading] = useState(state.partnerCreditsList === null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [filter, setFilter] = useState('all'); // 'all' | 'active' | 'credits_only'
  const [projectCredits, setProjectCredits] = useState(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const isMobile = useIsMobile();
  const isAdmin = permissionsInclude(state.session?.permissions, 'users.manage');

  const loadProjectCredits = useCallback(() => (
    api.get('/api/partner/project-credits')
      .then((rows) => setProjectCredits(rows || []))
      .catch(() => setProjectCredits([]))
  ), []);

  // Delete a manual partner client straight from the list. Admin-only, warns
  // first, and is undoable (the server archives the sub + its credit entries).
  const deleteClient = (row) => {
    if (!row.manualSubId) return;
    const name = row.clientName || row.clientKey;
    if (!window.confirm(`Delete "${name}"?\n\nThis removes the partner client and all its logged credit entries. You can undo it from the top bar (or Ctrl+Z).`)) return;
    actions.deleteManualSubscription(row.manualSubId)
      .then(() => showMsg('Partner client deleted — undo from the top bar'))
      .catch((err) => showMsg(err?.message || 'Could not delete'));
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    actions.fetchPartnerCreditsList().finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actions]);

  // Deal "credit based projects" (credits-type) mirrored from across all deals,
  // shown as a separate section below the partner clients.
  useEffect(() => { loadProjectCredits(); }, [loadProjectCredits]);

  const list = state.partnerCreditsList || [];
  const counts = {
    all: list.length,
    active: list.filter(r => r.status === 'active').length,
    credits_only: list.filter(r => r.status === 'credits_only').length,
  };
  const filtered = filter === 'all' ? list : list.filter(r => r.status === filter);

  return (
    <div style={{ padding: isMobile ? '20px 16px' : '40px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Coins size={22} color={BRAND.blue} />
            <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Partners &amp; Credits</h1>
          </div>
        </div>
        <button onClick={() => setShowAddModal(true)} className="btn">
          <Plus size={14} /> Add manual client
        </button>
      </header>

      {showAddModal && (
        <AddManualClientModal
          onClose={() => setShowAddModal(false)}
          onCreated={async (clientKey) => {
            setShowAddModal(false);
            await actions.fetchPartnerCreditsList();
            showMsg('Client added');
            if (clientKey) onOpen(clientKey);
          }}
          showMsg={showMsg}
          createManualSubscription={actions.createManualSubscription}
        />
      )}

      {list.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { id: 'all', label: 'All' },
            { id: 'active', label: 'Subscription' },
            { id: 'credits_only', label: 'Credits Only' },
          ].map(tab => {
            const selected = filter === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                className={selected ? 'btn' : 'btn-ghost'}
                style={{ fontSize: 13 }}
              >
                {tab.label} ({counts[tab.id]})
              </button>
            );
          })}
        </div>
      )}

      {loading && list.length === 0 ? (
        <Card><div style={{ padding: 60, textAlign: 'center', color: BRAND.muted }}>Loading clients…</div></Card>
      ) : list.length === 0 ? (
        <Card>
          <div style={{ padding: 60, textAlign: 'center' }}>
            <Coins size={40} color={BRAND.muted} style={{ marginBottom: 12 }} />
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>No partner subscribers yet</h3>
            <p style={{ color: BRAND.muted, fontSize: 14, margin: 0 }}>
              Once a client signs up to the Partner Programme they'll appear here with their credit balance.
            </p>
          </div>
        </Card>
      ) : (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid ' + BRAND.border, color: BRAND.muted, textAlign: 'left' }}>
                  <Th>Client</Th>
                  <Th align="center">Status</Th>
                  <Th align="right">Issued</Th>
                  <Th align="right">Used</Th>
                  <Th align="right">Remaining</Th>
                  <Th align="right">Monthly £</Th>
                  <Th align="right">VAT</Th>
                  <Th align="center">This month</Th>
                  {!isMobile && <Th>Usage</Th>}
                  {!isMobile && <Th>Last payment</Th>}
                  <Th align="center">Meeting</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={isMobile ? 9 : 11} style={{ padding: 40, textAlign: 'center', color: BRAND.muted }}>
                      No clients in this view.
                    </td>
                  </tr>
                ) : filtered.map(row => {
                  const issued = Number(row.creditsIssued) || 0;
                  const used = Number(row.creditsUsed) || 0;
                  const pct = issued > 0 ? Math.min(100, Math.round((used / issued) * 100)) : 0;
                  return (
                    <tr
                      key={row.clientKey}
                      onClick={() => onOpen(row.clientKey)}
                      style={{ borderBottom: '1px solid ' + BRAND.border, cursor: 'pointer' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFC'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '12px 8px' }}>
                        <div style={{ fontWeight: 600 }}>{row.clientName || row.clientKey}</div>
                        <div style={{ fontSize: 11, color: BRAND.muted }}>
                          {row.status === 'active'
                            ? `${row.subscriptions.active} active / ${row.subscriptions.count} subscription${row.subscriptions.count === 1 ? '' : 's'}`
                            : (row.paused
                                ? 'Paused — using up credits'
                                : row.status === 'credits_only'
                                  ? 'Credits only'
                                  : 'No active subscription')}
                        </div>
                      </td>
                      <td style={{ padding: '12px 8px', textAlign: 'center' }}>
                        <StatusPill status={row.status} paused={row.paused} />
                      </td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCredits(issued)}</td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCredits(used)}</td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtCredits(row.creditsRemaining)}</td>
                      <td style={{ padding: '12px 8px', textAlign: 'right' }}>
                        <MonthlyFeeCell row={row} />
                      </td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', color: BRAND.muted, fontVariantNumeric: 'tabular-nums' }} title="VAT rate — edit it on the client page">
                        {(row.vatRate != null ? Math.round(Number(row.vatRate) * 100) : 20)}%
                      </td>
                      <td style={{ padding: '12px 8px', textAlign: 'center' }}>
                        <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
                          <PaidToggle
                            row={row}
                            onToggle={(paid) => actions.markPartnerFeePaid(row.clientKey, paid)
                              .then(() => actions.fetchPartnerCreditsList())
                              .then(() => showMsg(paid ? 'Marked paid — added to income + VAT' : 'Marked unpaid'))
                              .catch((err) => showMsg(err?.message || 'Could not update'))}
                          />
                          <LogPastMonth
                            row={row}
                            onPay={(month) => actions.markPartnerFeePaid(row.clientKey, true, month)
                              .then(() => actions.fetchPartnerCreditsList())
                              .then(() => showMsg(`Logged ${monthPickLabel(month)} paid — added to income + VAT`))
                              .catch((err) => showMsg(err?.message || 'Could not update'))}
                          />
                        </div>
                      </td>
                      {!isMobile && (
                        <td style={{ padding: '12px 8px', minWidth: 160 }}>
                          <div style={{ background: BRAND.border, borderRadius: 999, height: 8, overflow: 'hidden' }}>
                            <div style={{ width: pct + '%', background: pct >= 90 ? '#EF4444' : pct >= 70 ? '#F59E0B' : BRAND.blue, height: '100%' }} />
                          </div>
                          <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>{pct}%</div>
                        </td>
                      )}
                      {!isMobile && <td style={{ padding: '12px 8px', color: BRAND.muted }}>{fmtDate(row.lastPaymentAt)}</td>}
                      <td style={{ padding: '12px 8px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <PartnerMeetingsButton clientKey={row.clientKey} clientName={row.clientName || row.clientKey} />
                          {isAdmin && row.manualSubId && (
                            <button
                              onClick={() => deleteClient(row)}
                              title="Delete partner client"
                              aria-label="Delete partner client"
                              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, border: '1px solid ' + BRAND.border, background: 'white', color: '#B91C1C', cursor: 'pointer' }}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ProjectCreditsSection
        projects={projectCredits}
        isMobile={isMobile}
        onOpenDeal={onOpenDeal}
        onNew={() => setShowNewProject(true)}
      />

      {showNewProject && (
        <NewCreditsProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={async () => { setShowNewProject(false); await loadProjectCredits(); showMsg('Credits project created'); }}
          showMsg={showMsg}
        />
      )}
    </div>
  );
}

// Deal credit-based projects (credits-type), mirrored from the deal pages so the
// whole credit picture lives here. Click a row to open its deal; "New credits
// project" creates one against a chosen deal.
function ProjectCreditsSection({ projects, isMobile, onOpenDeal, onNew }) {
  const list = projects || [];
  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <FolderOpen size={18} color={BRAND.blue} />
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>Current Projects</h2>
        <span style={{ fontSize: 12, color: BRAND.muted }}>({list.length})</span>
        <div style={{ flex: 1 }} />
        <button onClick={onNew} className="btn-ghost" style={{ fontSize: 13 }}>
          <Plus size={14} /> New credits project
        </button>
      </div>
      {list.length === 0 ? (
        <Card>
          <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
            No credit-based projects yet. Create one against a deal to start tracking credits.
          </div>
        </Card>
      ) : (
      <Card>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid ' + BRAND.border, color: BRAND.muted, textAlign: 'left' }}>
                <Th>Project</Th>
                <Th align="right">Issued</Th>
                <Th align="right">Used</Th>
                <Th align="right">Remaining</Th>
                {!isMobile && <Th>Usage</Th>}
              </tr>
            </thead>
            <tbody>
              {list.map(p => {
                const issued = Number(p.creditsIssued) || 0;
                const used = Number(p.creditsUsed) || 0;
                const pct = issued > 0 ? Math.min(100, Math.round((used / issued) * 100)) : 0;
                const remaining = Number(p.creditsRemaining) || 0;
                const clickable = !!(onOpenDeal && p.dealId);
                return (
                  <tr
                    key={p.id}
                    onClick={clickable ? () => onOpenDeal(p.dealId) : undefined}
                    style={{ borderBottom: '1px solid ' + BRAND.border, cursor: clickable ? 'pointer' : 'default' }}
                    onMouseEnter={(e) => { if (clickable) e.currentTarget.style.background = '#F8FAFC'; }}
                    onMouseLeave={(e) => { if (clickable) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <td style={{ padding: '12px 8px' }}>
                      <div style={{ fontWeight: 600 }}>{p.title}</div>
                      <div style={{ fontSize: 11, color: BRAND.muted }}>
                        {p.companyName || p.dealTitle || '—'}
                        {p.companyName && p.dealTitle ? ` · ${p.dealTitle}` : ''}
                      </div>
                    </td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCredits(issued)}</td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCredits(used)}</td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: remaining < 0 ? '#DC2626' : undefined }}>{fmtCredits(remaining)}</td>
                    {!isMobile && (
                      <td style={{ padding: '12px 8px', minWidth: 160 }}>
                        <div style={{ background: BRAND.border, borderRadius: 999, height: 8, overflow: 'hidden' }}>
                          <div style={{ width: pct + '%', background: pct >= 90 ? '#EF4444' : pct >= 70 ? '#F59E0B' : BRAND.blue, height: '100%' }} />
                        </div>
                        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>{pct}%</div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      )}
    </div>
  );
}

// Read-only monthly spend (ex-VAT). Editing lives on the client page — this
// view just shows the figure. An "auto" hint flags figures derived from the
// signed proposal rather than set by hand.
function MonthlyFeeCell({ row }) {
  const amount = Number(row.monthlyNet) || 0;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end', fontVariantNumeric: 'tabular-nums' }}>
      {!row.manualFee && amount > 0 && (
        <span title="Derived from the signed partner proposal" style={{ fontSize: 9, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.3 }}>auto</span>
      )}
      <span title="Monthly spend, ex-VAT — edit it on the client page">
        {amount > 0 ? formatGBP(amount) : <span style={{ color: BRAND.muted }}>—</span>}
      </span>
    </span>
  );
}

// "Mark paid" toggle for THIS month — records income + VAT (or undoes it).
function PaidToggle({ row, onToggle }) {
  const [busy, setBusy] = useState(false);
  const paid = !!row.paidThisMonth;
  const noAmount = !(Number(row.monthlyNet) > 0);
  const click = (e) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    Promise.resolve(onToggle(!paid)).finally(() => setBusy(false));
  };
  return (
    <button
      onClick={click}
      disabled={busy || (noAmount && !paid)}
      title={paid ? 'Collected this month — click to undo' : (noAmount ? 'Set a monthly amount first' : 'Mark this month collected (records income + VAT to save)')}
      style={{
        fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6,
        cursor: (busy || (noAmount && !paid)) ? 'default' : 'pointer',
        border: '1px solid ' + (paid ? '#A7F3D0' : BRAND.border),
        background: paid ? '#ECFDF3' : 'white',
        color: paid ? '#15803D' : (noAmount ? BRAND.muted : BRAND.ink),
        opacity: noAmount && !paid ? 0.6 : 1,
      }}
    >
      {paid ? '✓ Paid' : 'Mark paid'}
    </button>
  );
}

// Back-log a past month's fee as paid (e.g. last month's Generis received via
// GoCardless). The main toggle only covers the current month; this drops the
// payment into the chosen past month so it lands in that month's income.
function LogPastMonth({ row, onPay }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [month, setMonth] = useState(() => recentPastMonths()[0]);
  const noAmount = !(Number(row.monthlyNet) > 0);
  if (noAmount) return null;
  const months = recentPastMonths();
  const go = (e) => {
    e.stopPropagation();
    if (busy || !month) return;
    setBusy(true);
    Promise.resolve(onPay(month)).finally(() => { setBusy(false); setOpen(false); });
  };
  if (!open) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title="Log a past month as paid (e.g. last month)"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginTop: 4, fontSize: 10, fontWeight: 600, color: BRAND.muted, background: 'transparent', border: '1px dashed ' + BRAND.border, borderRadius: 5, padding: '2px 6px', cursor: 'pointer' }}
      >
        <CalendarClock size={11} /> Past month
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
      <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ padding: '2px 5px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 11, color: BRAND.ink, background: 'white' }}>
        {months.map((m) => <option key={m} value={m}>{monthPickLabel(m)}</option>)}
      </select>
      <button onClick={go} disabled={busy} style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, border: '1px solid ' + BRAND.blue, background: BRAND.blue, color: 'white', cursor: busy ? 'default' : 'pointer' }}>{busy ? '…' : 'Log paid'}</button>
      <button onClick={(e) => { e.stopPropagation(); setOpen(false); }} disabled={busy} style={{ fontSize: 11, padding: '2px 6px', borderRadius: 6, border: '1px solid ' + BRAND.border, background: 'white', color: BRAND.muted, cursor: 'pointer' }}>✕</button>
    </span>
  );
}

function Th({ children, align }) {
  return (
    <th style={{ padding: '10px 8px', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: align || 'left' }}>
      {children}
    </th>
  );
}

function StatusPill({ status, paused }) {
  const map = {
    active:       { bg: '#DCFCE7', fg: '#15803D', label: 'Subscription' },
    credits_only: { bg: '#DBEAFE', fg: '#1E40AF', label: 'Credits Only' },
    inactive:     { bg: '#F3F4F6', fg: '#6B7280', label: 'Inactive' },
  };
  // A paused subscription shows over the credits-only/inactive rollup so the
  // pause is visible at a glance (an active sub still wins).
  const s = (paused && status !== 'active')
    ? { bg: '#FEF3C7', fg: '#B45309', label: 'Paused' }
    : (map[status] || map.inactive);
  return (
    <span style={{
      display: 'inline-block',
      padding: '3px 10px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      background: s.bg,
      color: s.fg,
    }}>{s.label}</span>
  );
}

function Card({ children }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 0 }}>
      {children}
    </div>
  );
}

function AddManualClientModal({ onClose, onCreated, showMsg, createManualSubscription }) {
  const { state, actions } = useStore();
  const today = new Date().toISOString().slice(0, 10);
  const [type, setType] = useState('subscription'); // 'subscription' | 'credits_only'
  const [org, setOrg] = useState(null);              // selected CRM company, or null (free-text)
  const [clientName, setClientName] = useState('');
  const [xeroContactId, setXeroContactId] = useState(null); // resolved link to send
  const [linking, setLinking] = useState(false);            // saving a new Xero link to the org
  const [creditsPerMonth, setCreditsPerMonth] = useState('5');
  const [startDate, setStartDate] = useState(today);
  const [autoCredit, setAutoCredit] = useState(true);
  const [initialBalance, setInitialBalance] = useState('');
  const [creditsPurchased, setCreditsPurchased] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const creditsOnly = type === 'credits_only';

  // Pick / clear an existing organisation. Selecting one seeds the client name
  // and captures its Xero contact link (so the sub auto-syncs with Xero).
  const pickOrg = (c) => {
    setOrg(c);
    setClientName(c.name || '');
    setXeroContactId(c.xeroContactId || null);
  };
  const clearOrg = () => { setOrg(null); setXeroContactId(null); };

  // Link a Xero contact to an org that isn't linked yet — persist it back to the
  // company (so it's remembered everywhere) and use it for this subscription.
  const linkXero = async (contact) => {
    if (!org || !contact) { setXeroContactId(contact ? contact.id : null); return; }
    setLinking(true);
    try {
      await actions.saveCompany(org.id, { xeroContactId: contact.id });
      setOrg((o) => (o ? { ...o, xeroContactId: contact.id } : o));
      setXeroContactId(contact.id);
    } catch (err) {
      showMsg(err?.message || 'Could not link Xero contact');
    } finally {
      setLinking(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!clientName.trim()) return;
    setSubmitting(true);
    try {
      let payload;
      if (creditsOnly) {
        const purchased = parseFloat(creditsPurchased);
        if (!Number.isFinite(purchased) || purchased <= 0) {
          showMsg('Enter the number of credits purchased');
          setSubmitting(false);
          return;
        }
        payload = {
          clientName: clientName.trim(),
          creditsPerMonth: 0,
          autoCredit: false,
          startDate: null,
          initialBalance: purchased,
        };
      } else {
        const cpm = parseFloat(creditsPerMonth);
        if (!Number.isFinite(cpm) || cpm < 0) { setSubmitting(false); return; }
        const ib = parseFloat(initialBalance);
        payload = {
          clientName: clientName.trim(),
          creditsPerMonth: cpm,
          startDate: startDate || null,
          autoCredit,
          initialBalance: Number.isFinite(ib) && ib !== 0 ? ib : undefined,
        };
      }
      if (xeroContactId) payload.xeroContactId = xeroContactId;
      const row = await createManualSubscription(payload);
      onCreated(row?.clientKey);
    } catch (err) {
      showMsg(err?.message || 'Failed to add client');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700 }}>Add partner client</h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
        For clients who aren't billed via Stripe. You can still log work and adjust credits the same way.
      </p>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Field label="Client type">
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => setType('subscription')}
              className={!creditsOnly ? 'btn' : 'btn-ghost'}
              style={{ flex: 1, justifyContent: 'center' }}
            >Partner subscription</button>
            <button
              type="button"
              onClick={() => setType('credits_only')}
              className={creditsOnly ? 'btn' : 'btn-ghost'}
              style={{ flex: 1, justifyContent: 'center' }}
            >Credits only</button>
          </div>
        </Field>
        <Field label="Organisation" hint="Pick an existing organisation to link this client — a Xero-linked org syncs automatically. Or leave blank and type a one-off name below.">
          {org ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8, background: BRAND.paper }}>
              <Building2 size={15} color={BRAND.blue} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {org.name}
              </div>
              <button type="button" onClick={clearOrg} className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11, color: BRAND.muted }}>Clear</button>
            </div>
          ) : (
            <OrgPicker companies={Object.values(state.companies || {})} onPick={pickOrg} />
          )}
        </Field>

        {/* Xero sync status for the selected org. */}
        {org && (
          org.xeroContactId ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, fontSize: 12.5, color: '#15803D', fontWeight: 600 }}>
              <Check size={14} color="#16A34A" /> Syncs with Xero automatically
            </div>
          ) : (
            <Field label="Link Xero contact" hint="This organisation isn’t linked to Xero yet. Link its contact so paid recurring invoices auto-credit this client.">
              <XeroContactPicker
                value={null}
                initialQuery={org.name}
                onChange={(c) => c && linkXero(c)}
                placeholder="Search Xero contacts…"
                size="sm"
                allowClear={false}
                creatingNew={linking}
              />
            </Field>
          )
        )}

        <Field label="Client name">
          <input
            className="input"
            autoFocus
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="ASH Waste"
            required
          />
        </Field>
        {creditsOnly ? (
          <Field label="Credits purchased" hint="A one-off block of credits. No monthly crediting — top up later with a manual adjustment.">
            <input
              className="input"
              type="number"
              step="0.01"
              min="0.01"
              value={creditsPurchased}
              onChange={(e) => setCreditsPurchased(e.target.value)}
              placeholder="e.g. 20"
              required
            />
          </Field>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Credits per month">
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  min="0"
                  value={creditsPerMonth}
                  onChange={(e) => setCreditsPerMonth(e.target.value)}
                  required
                />
              </Field>
              <Field label="Start date">
                <input
                  className="input"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </Field>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={autoCredit} onChange={(e) => setAutoCredit(e.target.checked)} />
              Auto-credit each month from the start date
            </label>
            <Field label="Initial balance adjustment (optional)" hint="Use a positive number for credits already paid for; negative for a clawback. Leave blank for none.">
              <input
                className="input"
                type="number"
                step="0.01"
                value={initialBalance}
                onChange={(e) => setInitialBalance(e.target.value)}
                placeholder="e.g. 12"
              />
            </Field>
          </>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" disabled={submitting} className="btn">
            {submitting ? 'Adding…' : 'Add client'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Create a credit-based project (credits-type project_retainer) against a deal.
// Reuses the deal retainer create endpoint; the project then shows in Current
// Projects and on the deal page (videos draw credits from this pool).
function NewCreditsProjectModal({ onClose, onCreated, showMsg }) {
  const { state } = useStore();
  const deals = Object.values(state.deals || {});
  const companies = state.companies || {};
  const [deal, setDeal] = useState(null);
  const [title, setTitle] = useState('');
  const [credits, setCredits] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const pickDeal = (d) => {
    setDeal(d);
    if (!title.trim()) setTitle(d.title || companies[d.companyId]?.name || '');
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!deal) { showMsg('Pick a deal for the project'); return; }
    const amt = parseFloat(credits);
    if (!Number.isFinite(amt) || amt <= 0) { showMsg('Enter a positive number of credits'); return; }
    const finalTitle = title.trim() || deal.title || companies[deal.companyId]?.name || 'Credits';
    setSubmitting(true);
    try {
      await api.post('/api/crm/retainers', {
        dealId: deal.id,
        title: finalTitle,
        allocationType: 'credits',
        allocationAmount: amt,
        currency: 'GBP',
      });
      onCreated();
    } catch (err) {
      showMsg(err?.message || 'Failed to create project');
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700 }}>New credits project</h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
        Create a credit-based project against a deal. Videos on that deal draw credits from this pool, and the balance shows here under Current Projects.
      </p>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Field label="Deal">
          {deal ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8, background: BRAND.paper }}>
              <FolderOpen size={15} color={BRAND.blue} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{deal.title || 'Untitled deal'}</div>
                {companies[deal.companyId]?.name && <div style={{ fontSize: 11, color: BRAND.muted }}>{companies[deal.companyId].name}</div>}
              </div>
              <button type="button" onClick={() => setDeal(null)} className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11, color: BRAND.muted }}>Change</button>
            </div>
          ) : (
            <DealPicker deals={deals} companies={companies} onPick={pickDeal} />
          )}
        </Field>
        <Field label="Project name">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. WhatUni" />
        </Field>
        <Field label="Credits" hint="The starting credit balance for this project. Top it up later from the deal page.">
          <input className="input" type="number" step="1" min="1" value={credits} onChange={(e) => setCredits(e.target.value)} placeholder="e.g. 40" required />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" disabled={submitting} className="btn">{submitting ? 'Creating…' : 'Create project'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Searchable dropdown over deals (by deal title or company name).
function DealPicker({ deals, companies, onPick }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = deals.map(d => ({ d, company: companies[d.companyId]?.name || '' }));
    rows.sort((a, b) => (a.d.title || '').localeCompare(b.d.title || ''));
    const list = q
      ? rows.filter(r => (r.d.title || '').toLowerCase().includes(q) || r.company.toLowerCase().includes(q))
      : rows;
    return list.slice(0, 30);
  }, [deals, companies, query]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <Search size={14} color={BRAND.muted} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }} />
        <input
          className="input"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Search deals…"
          style={{ paddingLeft: 30 }}
        />
      </div>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.08)', zIndex: 50, maxHeight: 260, overflow: 'auto' }}>
          {results.length === 0 ? (
            <div style={{ padding: 12, fontSize: 12, color: BRAND.muted, textAlign: 'center' }}>No deals match.</div>
          ) : results.map(({ d, company }) => (
            <button
              key={d.id}
              type="button"
              onClick={() => { onPick(d); setOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px', background: 'white', border: 'none', borderBottom: '1px solid ' + BRAND.border, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#F1F5F9'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
            >
              <FolderOpen size={14} color={BRAND.muted} style={{ flexShrink: 0 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title || 'Untitled deal'}</div>
                {company && <div style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{company}</div>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Searchable dropdown over the CRM organisations already loaded in state.
// Flags which orgs are Xero-linked so it's obvious which will auto-sync.
function OrgPicker({ companies, onPick }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...companies].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const list = q ? sorted.filter(c => (c.name || '').toLowerCase().includes(q)) : sorted;
    return list.slice(0, 30);
  }, [companies, query]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <Search size={14} color={BRAND.muted} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }} />
        <input
          className="input"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Search organisations…"
          style={{ paddingLeft: 30 }}
        />
      </div>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.08)', zIndex: 50, maxHeight: 260, overflow: 'auto' }}>
          {results.length === 0 ? (
            <div style={{ padding: 12, fontSize: 12, color: BRAND.muted, textAlign: 'center' }}>No organisations match.</div>
          ) : results.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => { onPick(c); setOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px', background: 'white', border: 'none', borderBottom: '1px solid ' + BRAND.border, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#F1F5F9'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
            >
              <Building2 size={14} color={BRAND.muted} style={{ flexShrink: 0 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
                {c.xeroContactId && <div style={{ fontSize: 10.5, color: '#15803D', fontWeight: 600 }}>Xero linked</div>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: BRAND.muted, marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}
