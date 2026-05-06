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
  const isMobile = useIsMobile();

  useEffect(() => {
    let active = true;
    setLoading(true);
    actions.fetchPartnerCreditsList().finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actions]);

  const list = state.partnerCreditsList || [];

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '20px 16px' : '40px 24px' }}>
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
                  {!isMobile && <Th>Usage</Th>}
                  {!isMobile && <Th>Last payment</Th>}
                </tr>
              </thead>
              <tbody>
                {list.map(row => {
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
                          {row.subscriptions.active} active / {row.subscriptions.count} subscription{row.subscriptions.count === 1 ? '' : 's'}
                        </div>
                      </td>
                      <td style={{ padding: '12px 8px', textAlign: 'center' }}>
                        <StatusPill status={row.status} />
                      </td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCredits(issued)}</td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCredits(used)}</td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtCredits(row.creditsRemaining)}</td>
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

function Th({ children, align }) {
  return (
    <th style={{ padding: '10px 8px', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: align || 'left' }}>
      {children}
    </th>
  );
}

function StatusPill({ status }) {
  const active = status === 'active';
  return (
    <span style={{
      display: 'inline-block',
      padding: '3px 10px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      background: active ? '#DCFCE7' : '#F3F4F6',
      color: active ? '#15803D' : '#6B7280',
    }}>{active ? 'Active' : 'Inactive'}</span>
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
  const [clientName, setClientName] = useState('');
  const [creditsPerMonth, setCreditsPerMonth] = useState('5');
  const [startDate, setStartDate] = useState(today);
  const [autoCredit, setAutoCredit] = useState(true);
  const [initialBalance, setInitialBalance] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const cpm = parseFloat(creditsPerMonth);
    if (!clientName.trim()) return;
    if (!Number.isFinite(cpm) || cpm < 0) return;
    setSubmitting(true);
    try {
      const ib = parseFloat(initialBalance);
      const row = await createManualSubscription({
        clientName: clientName.trim(),
        creditsPerMonth: cpm,
        startDate: startDate || null,
        autoCredit,
        initialBalance: Number.isFinite(ib) && ib !== 0 ? ib : undefined,
      });
      onCreated(row?.clientKey);
    } catch (err) {
      showMsg(err?.message || 'Failed to add client');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700 }}>Add manual partner client</h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5 }}>
        For partner-programme clients who aren't billed via Stripe. You can still log work and adjust credits the same way.
      </p>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
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
