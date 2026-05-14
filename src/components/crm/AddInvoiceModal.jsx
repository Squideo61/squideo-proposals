import React, { useState } from 'react';
import { X, Upload, Link, Copy, Check } from 'lucide-react';
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
  const [vatRate, setVatRate] = useState('20');
  const [generateLink, setGenerateLink] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [createdLink, setCreatedLink] = useState(null);
  const [copied, setCopied] = useState(false);

  const amountNum = Number(amount);
  const showLinkOption = amountNum > 0 && status === 'issued';

  // Xero's default PDF filename is "Invoice INV-NNNN.pdf" — auto-detect the
  // invoice number on file pick so the user sees what we'll match in Xero.
  const detectedInvoiceNumber = file ? extractInvoiceNumber(file.name) : null;

  function handleFileChange(picked) {
    setFile(picked);
    if (picked && !invoiceNumber) {
      const inv = extractInvoiceNumber(picked.name);
      if (inv) setInvoiceNumber(inv);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file && !amountNum) {
      showMsg?.('Provide a PDF, an amount, or both', 'error');
      return;
    }
    if (file && file.size > 20 * 1024 * 1024) {
      showMsg?.('File too large (max 20 MB)', 'error');
      return;
    }

    setUploading(true);
    try {
      const meta = {
        dealId,
        proposalId: proposalId || undefined,
        invoiceNumber: invoiceNumber || undefined,
        amount: amountNum || undefined,
        issuedAt: issuedAt || undefined,
        dueAt: dueAt || undefined,
        status,
        notes: notes || undefined,
        vatRate: vatRate || '20',
        generateStripeLink: (generateLink && showLinkOption) ? 'true' : undefined,
      };
      const metaHeader = base64UrlEncode(JSON.stringify(meta));

      let res;
      if (file) {
        res = await fetch('/api/crm/invoices', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': file.type || 'application/pdf',
            'X-Filename': encodeURIComponent(file.name || 'invoice.pdf'),
            'X-Invoice-Meta': metaHeader,
          },
          body: file,
        });
      } else {
        // Metadata-only — send empty body with meta in header
        res = await fetch('/api/crm/invoices', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Invoice-Meta': metaHeader,
          },
          body: new Uint8Array(0),
        });
      }

      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to create invoice');

      showMsg?.(json.autoLinked ? 'Linked to Xero invoice' : 'Invoice created', 'success');

      if (json.stripePaymentLinkUrl) {
        setCreatedLink(json.stripePaymentLinkUrl);
      } else {
        onCreated?.(json);
      }
    } catch (err) {
      showMsg?.(err.message || 'Failed to create invoice', 'error');
    } finally {
      setUploading(false);
    }
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(createdLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showMsg?.('Copy failed — please copy the link manually', 'error');
    }
  }

  function handleDone() {
    onCreated?.();
  }

  if (createdLink) {
    return (
      <Modal onClose={onClose}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Invoice created</h2>
          <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
        </div>
        <div style={{ padding: '16px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, marginBottom: 16 }}>
          <p style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600 }}>Stripe payment link generated</p>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: BRAND.muted }}>Share this link with your client so they can pay by card online.</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, padding: '8px 10px' }}>
            <Link size={12} color={BRAND.muted} style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 12, flex: 1, wordBreak: 'break-all', color: BRAND.ink }}>{createdLink}</span>
            <button onClick={handleCopyLink} className="btn-ghost" style={{ padding: '4px 8px', flexShrink: 0 }}>
              {copied ? <Check size={12} color="#16A34A" /> : <Copy size={12} />}
              {copied ? ' Copied' : ' Copy'}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={handleDone} className="btn">Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Add invoice</h2>
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

        <Field label="PDF file (optional)">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: '1px dashed ' + BRAND.border, borderRadius: 8, cursor: 'pointer', background: BRAND.paper }}>
            <Upload size={14} color={BRAND.muted} />
            <span style={{ fontSize: 13, color: BRAND.muted }}>{file ? file.name : 'Choose a PDF…'}</span>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
              style={{ display: 'none' }}
            />
          </label>
          {!file && (
            <p style={{ margin: '4px 0 0', fontSize: 11, color: BRAND.muted }}>
              Uploading a Xero invoice PDF? We'll match it to Xero by invoice number and auto-fill the rest.
            </p>
          )}
          {file && detectedInvoiceNumber && (
            <p style={{ margin: '4px 0 0', fontSize: 11, color: '#16A34A' }}>
              Detected {detectedInvoiceNumber} — amount, dates &amp; status will be pulled from Xero.
            </p>
          )}
          {file && !detectedInvoiceNumber && !invoiceNumber && (
            <p style={{ margin: '4px 0 0', fontSize: 11, color: '#DC2626' }}>
              No invoice number (INV-NNNN) found in the filename. Only Xero invoice PDFs can be uploaded — rename the file or enter the invoice number below.
            </p>
          )}
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Invoice number">
            <input type="text" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className="input" placeholder="INV-0042" />
          </Field>
          <Field label="Amount (£)">
            <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="input" />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
          <Field label="Issued at">
            <input type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} className="input" />
          </Field>
          <Field label="Due at">
            <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className="input" />
          </Field>
          <Field label="VAT">
            <select value={vatRate} onChange={(e) => setVatRate(e.target.value)} className="input">
              <option value="20">Standard 20%</option>
              <option value="0">No VAT</option>
            </select>
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

        {showLinkOption && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', padding: '10px 12px', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8 }}>
            <input
              type="checkbox"
              checked={generateLink}
              onChange={(e) => setGenerateLink(e.target.checked)}
              style={{ width: 14, height: 14 }}
            />
            <span>Generate a Stripe payment link so the client can pay by card</span>
          </label>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={uploading}>
            {uploading ? 'Saving…' : file ? 'Upload & create' : 'Create invoice'}
          </button>
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

function extractInvoiceNumber(filename) {
  if (!filename) return null;
  const m = String(filename).match(/INV-\d{3,}/i);
  return m ? m[0].toUpperCase() : null;
}

function base64UrlEncode(s) {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
