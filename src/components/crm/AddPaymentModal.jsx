import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { formatGBP } from '../../utils.js';
import { Modal } from '../ui.jsx';
import { AddInvoiceModal } from './AddInvoiceModal.jsx';

const PAYMENT_METHODS = [
  { value: 'bacs', label: 'BACS / bank transfer' },
];
const PAYMENT_TYPES = [
  { value: 'deposit', label: '50% deposit' },
  { value: 'full',    label: 'Full payment' },
  { value: 'partial', label: 'Partial' },
];

export function AddPaymentModal({ dealId, proposals = [], onClose, onCreated }) {
  const { showMsg } = useStore();
  const [proposalId, setProposalId] = useState(proposals[0]?.id || '');
  const [method, setMethod] = useState('bacs');
  const [amount, setAmount] = useState('');
  const [type, setType] = useState('full');
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [manualInvoiceId, setManualInvoiceId] = useState('');
  const [uploadingInvoice, setUploadingInvoice] = useState(false);
  const [saving, setSaving] = useState(false);
  // What the deal committed to vs what's already recorded, plus the invoices a
  // payment can be attached to. Drives the over-payment warning below.
  const [balance, setBalance] = useState(null);

  const loadBalance = useCallback(async () => {
    if (!dealId) return;
    try {
      setBalance(await api.get(`/api/crm/payments/balance?dealId=${encodeURIComponent(dealId)}`));
    } catch { setBalance(null); }
  }, [dealId]);
  useEffect(() => { loadBalance(); }, [loadBalance]);

  const invoices = balance?.invoices || [];
  const amt = Number(amount);
  const remaining = balance?.known ? balance.remaining : null;
  // Live warning while typing — the same rule the server enforces on submit.
  const overpays = balance?.known && Number.isFinite(amt) && amt > 0
    && balance.paid + amt > balance.committed + 0.005;

  // Attaching the payment to an invoice is what stops the same money being
  // counted twice (once here, once when that invoice is marked paid).
  const pickInvoice = (invId) => {
    setManualInvoiceId(invId);
    const inv = invoices.find((i) => i.id === invId);
    if (inv?.amount != null && !amount) setAmount(String(inv.amount));
  };

  async function submit(confirmOverpay) {
    if (!proposalId) { showMsg?.('Pick a proposal', 'error'); return; }
    if (!Number.isFinite(amt) || amt <= 0) { showMsg?.('Amount must be a positive number', 'error'); return; }
    setSaving(true);
    try {
      await api.post('/api/crm/payments', {
        proposalId,
        amount: amt,
        paymentMethod: method,
        paymentType: type,
        paidAt: new Date(paidAt).toISOString(),
        notes: notes.trim() || null,
        manualInvoiceId: manualInvoiceId || null,
        ...(confirmOverpay ? { confirmOverpay: true } : {}),
      });
      showMsg?.('Payment recorded', 'success');
      onCreated?.();
    } catch (err) {
      // The server refuses an over-payment once; confirming records it anyway
      // (extras and genuine overpayments are real, so this can't be a hard block).
      if (err.code === 'exceeds_committed' || /past its signed total/i.test(err.message || '')) {
        const d = err.data || {};
        const lines = [
          'This payment would take the deal past its signed total.',
          '',
          d.committed != null ? `Signed total:   ${formatGBP(d.committed)}` : null,
          d.alreadyPaid != null ? `Already recorded: ${formatGBP(d.alreadyPaid)}` : null,
          `This payment:   ${formatGBP(amt)}`,
          '',
          'Check the amount is what actually landed, and that you’re not also',
          'marking the matching invoice as paid — that would count it twice.',
          '',
          'Record it anyway?',
        ].filter((l) => l !== null);
        if (window.confirm(lines.join('\n'))) { await submit(true); return; }
      } else {
        showMsg?.(err.message || 'Failed to save', 'error');
      }
    } finally {
      setSaving(false);
    }
  }

  const handleSubmit = (e) => { e.preventDefault(); submit(false); };

  return (
    <Modal onClose={onClose} showClose={false}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Record a payment</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Proposal">
          <select value={proposalId} onChange={(e) => setProposalId(e.target.value)} className="input" required>
            <option value="">— Pick a proposal —</option>
            {proposals.map(p => (
              <option key={p.id} value={p.id}>{p.clientName || p.contactBusinessName || p.id}</option>
            ))}
          </select>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Payment method">
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="input">
              {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value)} className="input">
              {PAYMENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Amount (£)">
            <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="input" required />
          </Field>
          <Field label="Paid at">
            <input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="input" required />
          </Field>
        </div>
        <Field label="Notes (optional)">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="input" rows={2} placeholder="BACS reference, cheque number, etc." />
        </Field>
        <Field label="Settles which invoice? (recommended)">
          <div style={{ display: 'flex', gap: 8 }}>
            <select
              value={manualInvoiceId}
              onChange={(e) => pickInvoice(e.target.value)}
              className="input"
              style={{ flex: 1 }}
            >
              <option value="">— Not against an invoice —</option>
              {invoices.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {(inv.invoiceNumber || inv.id.slice(0, 12))}
                  {inv.amount != null ? ` · ${formatGBP(inv.amount)}` : ''}
                  {inv.status === 'paid' ? ' · already marked paid' : ''}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setUploadingInvoice(true)} className="btn-ghost">Upload new…</button>
          </div>
          <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 5, lineHeight: 1.45 }}>
            Linking it keeps the money counted once. Leave it unlinked and, if that
            invoice is also marked paid, the deal books the amount twice.
          </div>
        </Field>

        {balance?.known && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: BRAND.muted, background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 8, padding: '8px 11px' }}>
            <span>Signed total <strong style={{ color: BRAND.ink }}>{formatGBP(balance.committed)}</strong></span>
            <span>Already recorded <strong style={{ color: BRAND.ink }}>{formatGBP(balance.paid)}</strong></span>
            {remaining != null && (
              <span style={{ marginLeft: 'auto' }}>
                Outstanding <strong style={{ color: remaining > 0.005 ? '#B45309' : '#16A34A' }}>{formatGBP(remaining)}</strong>
                {remaining > 0.005 && !amount && (
                  <button type="button" className="btn-link" style={{ marginLeft: 6, fontSize: 12 }} onClick={() => setAmount(String(remaining))}>use</button>
                )}
              </span>
            )}
          </div>
        )}

        {overpays && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '10px 12px' }}>
            <AlertTriangle size={16} color="#B45309" style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12.5, color: '#92400E', lineHeight: 1.5 }}>
              <strong>That takes this deal past its signed total.</strong>{' '}
              {formatGBP(balance.paid)} is already recorded against {formatGBP(balance.committed)}.
              Check the amount is what actually landed — and that you aren’t also marking
              the matching invoice as paid, which would count it twice. You can still
              record it (extras and genuine overpayments happen).
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={saving}>{saving ? 'Saving…' : 'Record payment'}</button>
        </div>
      </form>

      {uploadingInvoice && (
        <AddInvoiceModal
          dealId={dealId}
          proposals={proposals}
          defaultProposalId={proposalId}
          onClose={() => setUploadingInvoice(false)}
          onCreated={(created) => {
            setUploadingInvoice(false);
            if (created?.id) setManualInvoiceId(created.id.slice('manual:'.length));
            // Reload so the new invoice appears in the picker (and its amount
            // counts toward the balance shown above).
            loadBalance();
          }}
        />
      )}
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}
