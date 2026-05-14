import React, { useState } from 'react';
import { X, Upload } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Modal } from '../ui.jsx';

export function AddInvoiceModal({ dealId, onClose, onCreated }) {
  const { showMsg } = useStore();
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);

  const detectedInvoiceNumber = file ? extractInvoiceNumber(file.name) : null;
  const canSubmit = !!file && !!detectedInvoiceNumber && !uploading;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) {
      showMsg?.('Choose a Xero invoice PDF to upload', 'error');
      return;
    }
    if (!detectedInvoiceNumber) {
      showMsg?.('Only Xero invoice PDFs (with INV-NNNN in the filename) can be uploaded', 'error');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      showMsg?.('File too large (max 20 MB)', 'error');
      return;
    }

    setUploading(true);
    try {
      const metaHeader = base64UrlEncode(JSON.stringify({ dealId }));
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
      if (!res.ok) throw new Error(json.error || 'Failed to upload invoice');
      showMsg?.('Invoice synced from Xero', 'success');
      onCreated?.(json);
    } catch (err) {
      showMsg?.(err.message || 'Failed to upload invoice', 'error');
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Upload & sync invoice</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 12, color: BRAND.muted }}>
          Upload a Xero invoice PDF. We'll match it to Xero by invoice number and pull the amount, dates, currency, and status automatically.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', border: '1px dashed ' + BRAND.border, borderRadius: 8, cursor: 'pointer', background: BRAND.paper }}>
          <Upload size={14} color={BRAND.muted} />
          <span style={{ fontSize: 13, color: file ? BRAND.ink : BRAND.muted }}>
            {file ? file.name : 'Choose a Xero invoice PDF…'}
          </span>
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            style={{ display: 'none' }}
          />
        </label>

        {file && detectedInvoiceNumber && (
          <p style={{ margin: 0, fontSize: 12, color: '#16A34A' }}>
            Detected {detectedInvoiceNumber} — will sync from Xero on upload.
          </p>
        )}
        {file && !detectedInvoiceNumber && (
          <p style={{ margin: 0, fontSize: 12, color: '#DC2626' }}>
            No invoice number found in the filename. Only Xero invoice PDFs (e.g. "Invoice INV-6049.pdf") can be uploaded.
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={!canSubmit}>
            {uploading ? 'Syncing…' : 'Upload & sync'}
          </button>
        </div>
      </form>
    </Modal>
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
