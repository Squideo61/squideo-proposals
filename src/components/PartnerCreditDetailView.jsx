import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Coins, Pencil, Plus, Trash2 } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { formatGBP, useIsMobile } from '../utils.js';
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

function fmtDateTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function PartnerCreditDetailView({ clientKey, onBack }) {
  const { state, actions, showMsg } = useStore();
  const cached = state.partnerCreditDetail?.[clientKey];
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState(null);
  const [editingSub, setEditingSub] = useState(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    let active = true;
    setLoading(true);
    actions.fetchPartnerCreditDetail(clientKey)
      .catch(err => { if (active) setError(err?.message || 'Failed to load'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actions, clientKey]);

  const detail = state.partnerCreditDetail?.[clientKey];

  if (loading && !detail) {
    return <Shell onBack={onBack}><div style={{ padding: 60, textAlign: 'center', color: BRAND.muted }}>Loading…</div></Shell>;
  }
  if (error || !detail) {
    return (
      <Shell onBack={onBack}>
        <div style={{ padding: 60, textAlign: 'center' }}>
          <p style={{ margin: 0, color: BRAND.muted }}>{error || 'Client not found.'}</p>
        </div>
      </Shell>
    );
  }

  const { clientName, subscriptions, payments, allocations, totals } = detail;
  const anyActive = subscriptions.some(s => s.status === 'active');
  const proposalOptions = subscriptions
    .filter(s => s.proposalId)
    .map(s => ({ id: s.proposalId, label: s.proposalTitle || s.proposalNumber || s.proposalId }));

  return (
    <Shell onBack={onBack}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Coins size={22} color={BRAND.blue} />
            <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>{clientName || clientKey}</h1>
          </div>
          <div style={{ fontSize: 13, color: BRAND.muted }}>
            <StatusPill status={anyActive ? 'active' : 'inactive'} />
            <span style={{ marginLeft: 10 }}>
              {subscriptions.length} subscription{subscriptions.length === 1 ? '' : 's'} on file
            </span>
          </div>
        </div>
      </div>

      {/* Summary tiles + donut */}
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 220px', gap: 24, alignItems: 'center', padding: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 16 }}>
            <Tile label="Issued"     value={fmtCredits(totals.issued)}    color="#0F2A3D" />
            <Tile label="Used"       value={fmtCredits(totals.used)}      color="#2BB8E6" />
            <Tile label="Remaining"  value={fmtCredits(totals.remaining)} color={totals.remaining < 0 ? '#EF4444' : '#10B981'} />
            <Tile label="Usage"      value={totals.usagePct + '%'}        color={totals.usagePct >= 90 ? '#EF4444' : totals.usagePct >= 70 ? '#F59E0B' : '#0F2A3D'} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Donut used={totals.used} remaining={Math.max(0, totals.remaining)} />
          </div>
        </div>
      </Card>

      {/* Subscriptions */}
      <Section title="Subscriptions">
        {subscriptions.length === 0 ? (
          <Empty>No subscriptions linked to this client.</Empty>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: BRAND.muted, textAlign: 'left', borderBottom: '1px solid ' + BRAND.border }}>
                <Th>Proposal / Type</Th>
                <Th align="right">Credits / month</Th>
                <Th align="center">Auto-credit</Th>
                <Th align="center">Status</Th>
                <Th>Start / period</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {subscriptions.map(s => (
                <tr key={s.stripeSubscriptionId} style={{ borderBottom: '1px solid ' + BRAND.border }}>
                  <td style={{ padding: '10px 8px' }}>
                    <div style={{ fontWeight: 600 }}>{s.proposalTitle || (s.isManual ? 'Manual subscription' : '—')}</div>
                    <div style={{ fontSize: 11, color: BRAND.muted }}>
                      {s.isManual ? 'Manual' : (s.proposalNumber ? '#' + s.proposalNumber : 'Stripe-tracked')}
                    </div>
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCredits(s.creditsPerMonth)}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'center', color: BRAND.muted, fontSize: 12 }}>
                    {s.isManual ? (s.autoCredit ? 'On' : 'Off') : 'Stripe'}
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                    <StatusPill status={s.status} />
                  </td>
                  <td style={{ padding: '10px 8px', color: BRAND.muted, fontSize: 12 }}>
                    {s.isManual
                      ? (s.startDate ? 'Started ' + fmtDate(s.startDate) : 'Started ' + fmtDate(s.createdAt))
                      : (s.currentPeriodEnd ? 'Renews ' + fmtDate(s.currentPeriodEnd) : '—')}
                    {s.canceledAt && <div>Cancelled {fmtDate(s.canceledAt)}</div>}
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                    {s.isManual && (
                      <button
                        onClick={() => setEditingSub(s)}
                        className="btn-icon"
                        aria-label="Edit subscription"
                        title="Edit subscription"
                      ><Pencil size={14} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Payments ledger */}
      <Section title="Payments — credits added">
        {payments.length === 0 ? (
          <Empty>No payments recorded yet.</Empty>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: BRAND.muted, textAlign: 'left', borderBottom: '1px solid ' + BRAND.border }}>
                <Th>Date</Th>
                <Th>Source</Th>
                <Th align="right">Amount</Th>
                <Th align="right">Credits added</Th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p, i) => (
                <tr key={i} style={{ borderBottom: '1px solid ' + BRAND.border }}>
                  <td style={{ padding: '10px 8px' }}>{fmtDate(p.paidAt)}</td>
                  <td style={{ padding: '10px 8px' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', padding: '2px 8px', borderRadius: 999, background: p.source === 'initial' ? '#DBEAFE' : '#F3F4F6', color: p.source === 'initial' ? '#1E40AF' : '#374151' }}>
                      {p.source === 'initial' ? 'First month' : 'Recurring'}
                    </span>
                  </td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{p.amount ? formatGBP(p.amount) : '—'}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>+{fmtCredits(p.creditsAdded)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Log work form */}
      <Section title="Log work against credits">
        <AllocationForm
          proposalOptions={proposalOptions}
          onSubmit={async (input) => {
            try {
              await actions.logAllocation({ clientKey, kind: 'work', ...input });
              showMsg('Allocation logged');
            } catch (err) {
              showMsg(err?.message || 'Failed to log allocation');
              throw err;
            }
          }}
        />
      </Section>

      {/* Manual adjustment form */}
      <Section title="Adjust credits manually">
        <AdjustmentForm
          onSubmit={async (input) => {
            try {
              await actions.logAllocation({ clientKey, kind: 'adjustment', ...input });
              showMsg('Adjustment recorded');
            } catch (err) {
              showMsg(err?.message || 'Failed to record adjustment');
              throw err;
            }
          }}
        />
      </Section>

      {/* Allocation + adjustment ledger */}
      <Section title="Credit movements">
        {allocations.length === 0 ? (
          <Empty>No movements recorded yet.</Empty>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: BRAND.muted, textAlign: 'left', borderBottom: '1px solid ' + BRAND.border }}>
                <Th>Date</Th>
                <Th>Type</Th>
                <Th>Description</Th>
                {!isMobile && <Th>Logged by</Th>}
                <Th align="right">Credits</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {allocations.map(a => {
                const isAdj = a.kind === 'adjustment';
                const sign = isAdj ? (a.creditCost >= 0 ? '+' : '−') : '−';
                const magnitude = Math.abs(a.creditCost);
                const color = isAdj
                  ? (a.creditCost >= 0 ? '#15803D' : '#B91C1C')
                  : '#0F2A3D';
                return (
                  <tr key={a.id} style={{ borderBottom: '1px solid ' + BRAND.border }}>
                    <td style={{ padding: '10px 8px', whiteSpace: 'nowrap' }}>{fmtDate(a.allocatedAt)}</td>
                    <td style={{ padding: '10px 8px' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', padding: '2px 8px', borderRadius: 999, background: isAdj ? '#FEF3C7' : '#DBEAFE', color: isAdj ? '#92400E' : '#1E40AF' }}>
                        {isAdj ? 'Adjustment' : 'Work'}
                      </span>
                    </td>
                    <td style={{ padding: '10px 8px' }}>
                      <div style={{ fontWeight: 500 }}>{a.description}</div>
                      {a.notes && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{a.notes}</div>}
                    </td>
                    {!isMobile && <td style={{ padding: '10px 8px', color: BRAND.muted, fontSize: 12 }}>{a.allocatedBy || '—'}</td>}
                    <td style={{ padding: '10px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color }}>
                      {sign}{fmtCredits(magnitude)}
                    </td>
                    <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                      <button
                        onClick={async () => {
                          if (!confirm('Remove this entry?')) return;
                          try { await actions.deleteAllocation(clientKey, a.id); }
                          catch (err) { showMsg(err?.message || 'Failed to delete'); }
                        }}
                        className="btn-icon"
                        aria-label="Delete entry"
                        title="Delete entry"
                      ><Trash2 size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      {editingSub && (
        <EditSubscriptionModal
          subscription={editingSub}
          onClose={() => setEditingSub(null)}
          onSaved={async () => {
            setEditingSub(null);
            await actions.fetchPartnerCreditDetail(clientKey);
            showMsg('Subscription updated');
          }}
          onDeleted={async () => {
            setEditingSub(null);
            await actions.fetchPartnerCreditDetail(clientKey);
            showMsg('Subscription removed');
          }}
          patch={actions.patchManualSubscription}
          remove={actions.deleteManualSubscription}
          showMsg={showMsg}
        />
      )}
    </Shell>
  );
}

function AllocationForm({ proposalOptions, onSubmit }) {
  const [description, setDescription] = useState('');
  const [creditCost, setCreditCost] = useState('');
  const [notes, setNotes] = useState('');
  const [proposalId, setProposalId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const cost = parseFloat(creditCost);
    if (!description.trim()) return;
    if (!Number.isFinite(cost) || cost <= 0) return;
    setSubmitting(true);
    try {
      await onSubmit({
        description: description.trim(),
        creditCost: cost,
        notes: notes.trim() || undefined,
        proposalId: proposalId || undefined,
      });
      setDescription('');
      setCreditCost('');
      setNotes('');
      setProposalId('');
    } catch {
      // surfaced via showMsg in caller
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10 }}>
        <input
          className="input"
          placeholder="What was done? (e.g. Tipper Operations video, 2hr editing tweak)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
        <input
          className="input"
          type="number"
          step="0.01"
          min="0.01"
          placeholder="Credits"
          value={creditCost}
          onChange={(e) => setCreditCost(e.target.value)}
          required
        />
      </div>
      <textarea
        className="input"
        rows={2}
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        style={{ fontSize: 13 }}
      />
      {proposalOptions.length > 0 && (
        <select
          className="input"
          value={proposalId}
          onChange={(e) => setProposalId(e.target.value)}
        >
          <option value="">Link to proposal (optional)…</option>
          {proposalOptions.map(o => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" disabled={submitting} className="btn">
          <Plus size={14} /> {submitting ? 'Logging…' : 'Log allocation'}
        </button>
      </div>
    </form>
  );
}

function Donut({ used, remaining }) {
  const total = used + remaining;
  const SIZE = 160;
  const STROKE = 22;
  const RADIUS = (SIZE - STROKE) / 2;
  const CIRC = 2 * Math.PI * RADIUS;
  const usedFrac = total > 0 ? used / total : 0;
  const usedDash = CIRC * usedFrac;
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
      <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="#E5E9EE" strokeWidth={STROKE} />
      {total > 0 && (
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="#2BB8E6"
          strokeWidth={STROKE}
          strokeDasharray={`${usedDash} ${CIRC - usedDash}`}
          strokeDashoffset={CIRC * 0.25}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          strokeLinecap="butt"
        />
      )}
      <text x={SIZE / 2} y={SIZE / 2 - 4} textAnchor="middle" fontSize="22" fontWeight="700" fill="#0F2A3D">
        {total > 0 ? Math.round(usedFrac * 100) + '%' : '—'}
      </text>
      <text x={SIZE / 2} y={SIZE / 2 + 16} textAnchor="middle" fontSize="11" fill="#6B7785" letterSpacing="0.5">
        USED
      </text>
    </svg>
  );
}

function Shell({ onBack, children }) {
  const isMobile = useIsMobile();
  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '20px 16px' : '40px 24px' }}>
      <button onClick={onBack} className="btn-ghost" style={{ marginBottom: 16 }}>
        <ArrowLeft size={14} /> Back to credits
      </button>
      {children}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 20, marginTop: 16 }}>
      <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: BRAND.muted }}>{title}</h2>
      {children}
    </div>
  );
}

function Card({ children }) {
  return <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, marginTop: 16 }}>{children}</div>;
}

function Tile({ label, value, color }) {
  return (
    <div style={{ background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: BRAND.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || '#0F2A3D' }}>{value}</div>
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

function Empty({ children }) {
  return <div style={{ padding: 24, color: BRAND.muted, textAlign: 'center', fontSize: 13 }}>{children}</div>;
}

function AdjustmentForm({ onSubmit }) {
  const [description, setDescription] = useState('');
  const [creditCost, setCreditCost] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const cost = parseFloat(creditCost);
    if (!description.trim()) return;
    if (!Number.isFinite(cost) || cost === 0) return;
    setSubmitting(true);
    try {
      await onSubmit({
        description: description.trim(),
        creditCost: cost,
        notes: notes.trim() || undefined,
      });
      setDescription('');
      setCreditCost('');
      setNotes('');
    } catch {
      // surfaced via showMsg in caller
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
      <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.5 }}>
        Use a <strong>positive</strong> number to add credits (e.g. monthly top-up, bonus)
        or a <strong>negative</strong> number to remove them (e.g. clawback).
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10 }}>
        <input
          className="input"
          placeholder="Reason (e.g. May 2026 payment received, bonus credit, clawback)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
        <input
          className="input"
          type="number"
          step="0.01"
          placeholder="±Credits"
          value={creditCost}
          onChange={(e) => setCreditCost(e.target.value)}
          required
        />
      </div>
      <textarea
        className="input"
        rows={2}
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        style={{ fontSize: 13 }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" disabled={submitting} className="btn">
          <Plus size={14} /> {submitting ? 'Saving…' : 'Record adjustment'}
        </button>
      </div>
    </form>
  );
}

function EditSubscriptionModal({ subscription, onClose, onSaved, onDeleted, patch, remove, showMsg }) {
  const s = subscription;
  const [clientName, setClientName] = useState(s.proposalTitle || '');
  const [creditsPerMonth, setCreditsPerMonth] = useState(String(s.creditsPerMonth ?? ''));
  const [startDate, setStartDate] = useState((s.startDate || s.createdAt || '').slice(0, 10));
  const [autoCredit, setAutoCredit] = useState(!!s.autoCredit);
  const [status, setStatus] = useState(s.status || 'active');
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const cpm = parseFloat(creditsPerMonth);
    if (!Number.isFinite(cpm) || cpm < 0) return;
    setSubmitting(true);
    try {
      await patch(s.stripeSubscriptionId, {
        clientName: clientName.trim() || undefined,
        creditsPerMonth: cpm,
        startDate: startDate || null,
        autoCredit,
        status,
      });
      onSaved();
    } catch (err) {
      showMsg(err?.message || 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Permanently remove this manual subscription? Credit movements will stay on file.')) return;
    setRemoving(true);
    try {
      await remove(s.stripeSubscriptionId);
      onDeleted();
    } catch (err) {
      showMsg(err?.message || 'Failed to remove');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700 }}>Edit manual subscription</h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted }}>
        Settings here only affect this subscription's auto-crediting. Past credit movements stay untouched.
      </p>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <DetailField label="Display name">
          <input className="input" value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="ASH Waste" />
        </DetailField>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <DetailField label="Credits per month">
            <input className="input" type="number" step="0.01" min="0" value={creditsPerMonth} onChange={(e) => setCreditsPerMonth(e.target.value)} />
          </DetailField>
          <DetailField label="Start date">
            <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </DetailField>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={autoCredit} onChange={(e) => setAutoCredit(e.target.checked)} />
          Auto-credit each month from the start date
        </label>
        <DetailField label="Status">
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="canceled">Cancelled</option>
            <option value="inactive">Inactive</option>
          </select>
        </DetailField>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 4 }}>
          <button type="button" onClick={handleDelete} disabled={removing} className="btn-ghost" style={{ color: '#B91C1C' }}>
            <Trash2 size={14} /> {removing ? 'Removing…' : 'Delete subscription'}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={submitting} className="btn">
              {submitting ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function DetailField({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: BRAND.muted, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function StatusPill({ status }) {
  const active = status === 'active';
  const canceled = status === 'canceled';
  const colors = active
    ? { bg: '#DCFCE7', fg: '#15803D', label: 'Active' }
    : canceled
      ? { bg: '#FEE2E2', fg: '#B91C1C', label: 'Cancelled' }
      : { bg: '#F3F4F6', fg: '#6B7280', label: status || 'Inactive' };
  return (
    <span style={{
      display: 'inline-block',
      padding: '3px 10px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      background: colors.bg,
      color: colors.fg,
    }}>{colors.label}</span>
  );
}
