import React, { useState } from 'react';
import { X, Upload } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Modal } from '../ui.jsx';

const STATUSES = [
  { value: 'issued', label: 'Issued (unpaid)' },
  { value: 'paid',   label: 'Paid' },
  { value: 'void',   label: 'Void' },
];

export function AddInvoiceModal({ dealId, proposals = [], defaultProposalId, onClose, onCreated }) {
  const { showMsg } = useStore();
  const [proposalId, setProposalId] = useState(defaultProposalId || '');
  const [file, setFile] = useState(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [issuedAt, setIssuedAt] = useState(new Date().toISOString().slice(0, 10));
  const [dueAt, setDueAt] = useState('');
  const [status, setStatus] = useState('issued');
  const [notes, setNotes] = useState('');
  const [uploading, setUploading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) { showMsg?.('Pick a PDF to upload', 'error'); return; }
    if (file.size > 20 * 1024 * 1024) { showMsg?.('File too large (max 20 MB)', 'error'); return; }

    setUploading(true);
    try {
      const meta = {
        dealId,
        proposalId: proposalId || undefined,
        invoiceNumber: invoiceNumber || undefined,
        amount: amount ? Number(amount) : undefined,
        issuedAt: issuedAt || undefined,
        dueAt: dueAt || undefined,
        status,
        notes: notes || undefined,
      };
      const metaHeader = base64UrlEncode(JSON.stringify(meta));
      const res = await fetch('/api/crm/invoices', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': file.type || 'application/pdf',
          'X-Filename': encodeURIComponent(file.name || 'invoice.pdf'),
          'X-Invoice-Meta': metaHeader,
        },
        body: file,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      showMsg?.('Invoice uploaded', 'success');
      onCreated?.(json);
    } catch (err) {
      showMsg?.(err.message || 'Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Upload invoice</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Proposal (optional)">
          <select value={proposalId} onChange={(e) => setProposalId(e.target.value)} className="input">
            <option value="">— Deal-level only —</option>
            {proposals.map(p => (
              <option key={p.id} value={p.id}>{p.clientName || p.contactBusinessName || p.id}</option>
            ))}
          </select>
        </Field>
        <Field label="PDF file">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: '1px dashed ' + BRAND.border, borderRadius: 8, cursor: 'pointer', background: BRAND.paper }}>
            <Upload size={14} color={BRAND.muted} />
            <span style={{ fontSize: 13, color: BRAND.muted }}>{file ? file.name : 'Choose a PDF…'}</span>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              style={{ display: 'none' }}
              required
            />
          </label>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Invoice number">
            <input type="text" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className="input" placeholder="INV-0042" />
          </Field>
          <Field label="Amount (£)">
            <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="input" />
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <Field label="Issued at">
            <input type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} className="input" />
          </Field>
          <Field label="Due at">
            <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className="input" />
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="input">
              {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Notes (optional)">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="input" rows={2} />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={uploading}>{uploading ? 'Uploading…' : 'Upload'}</button>
        </div>
      </form>
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

function base64UrlEncode(s) {
  // btoa returns standard base64; rewrite to base64url (no padding, +→-, /→_)
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
