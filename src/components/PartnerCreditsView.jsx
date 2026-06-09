import React, { useEffect, useState } from 'react';
import { ArrowLeft, Coins, Plus } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { useIsMobile } from '../utils.js';
import { Modal } from './ui.jsx';

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

export function PartnerCreditsView({ onBack, onOpen }) {
  const { state, actions, showMsg } = useStore();
  const [loading, setLoading] = useState(state.partnerCreditsList === null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [filter, setFilter] = useState('all'); // 'all' | 'active' | 'credits_only'
  const isMobile = useIsMobile();

  useEffect(() => {
    let active = true;
    setLoading(true);
    actions.fetchPartnerCreditsList().finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actions]);

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
            <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Partner Programme Credits</h1>
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
                  {!isMobile && <Th>Usage</Th>}
                  {!isMobile && <Th>Last payment</Th>}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={isMobile ? 6 : 8} style={{ padding: 40, textAlign: 'center', color: BRAND.muted }}>
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
                            : row.status === 'credits_only'
                              ? 'Credits only'
                              : 'No active subscription'}
                        </div>
                      </td>
                      <td style={{ padding: '12px 8px', textAlign: 'center' }}>
                        <StatusPill status={row.status} />
                      </td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCredits(issued)}</td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCredits(used)}</td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtCredits(row.creditsRemaining)}</td>
                      <td style={{ padding: '12px 8px', textAlign: 'right' }}>
                        <MonthlyFeeCell
                          row={row}
                          onSave={(v) => actions.setPartnerManualFee(row.clientKey, v)
                            .then(() => actions.fetchPartnerCreditsList())
                            .then(() => showMsg('Monthly spend saved'))
                            .catch((err) => showMsg(err?.message || 'Could not save'))}
                        />
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

// Inline editable monthly spend (ex-VAT). Click stops the row opening; saves on
// blur / Enter only when the value actually changed. Shows an "auto" hint when
// the figure is derived from the signed proposal rather than set by hand.
function MonthlyFeeCell({ row, onSave }) {
  const initial = row.monthlyNet != null && row.monthlyNet !== 0 ? String(row.monthlyNet) : '';
  const [val, setVal] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setVal(row.monthlyNet != null && row.monthlyNet !== 0 ? String(row.monthlyNet) : '');
  }, [row.monthlyNet]);
  const commit = () => {
    const current = Number(row.monthlyNet) || 0;
    const next = parseFloat(val) || 0;
    if (next === current) return;
    setSaving(true);
    Promise.resolve(onSave(next)).finally(() => setSaving(false));
  };
  return (
    <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
      {!row.manualFee && (Number(row.monthlyNet) || 0) > 0 && (
        <span title="Derived from the signed partner proposal — type to override" style={{ fontSize: 9, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.3 }}>auto</span>
      )}
      <span style={{ color: BRAND.muted, fontSize: 12 }}>£</span>
      <input
        type="number"
        step="0.01"
        min="0"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
        placeholder="0.00"
        disabled={saving}
        title="Monthly spend, ex-VAT — feeds the Finance Pending Payments total"
        style={{ width: 84, padding: '4px 6px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
      />
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

function StatusPill({ status }) {
  const map = {
    active:       { bg: '#DCFCE7', fg: '#15803D', label: 'Subscription' },
    credits_only: { bg: '#DBEAFE', fg: '#1E40AF', label: 'Credits Only' },
    inactive:     { bg: '#F3F4F6', fg: '#6B7280', label: 'Inactive' },
  };
  const s = map[status] || map.inactive;
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
  const today = new Date().toISOString().slice(0, 10);
  const [type, setType] = useState('subscription'); // 'subscription' | 'credits_only'
  const [clientName, setClientName] = useState('');
  const [creditsPerMonth, setCreditsPerMonth] = useState('5');
  const [startDate, setStartDate] = useState(today);
  const [autoCredit, setAutoCredit] = useState(true);
  const [initialBalance, setInitialBalance] = useState('');
  const [creditsPurchased, setCreditsPurchased] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const creditsOnly = type === 'credits_only';

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

function Field({ label, hint, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: BRAND.muted, marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}
