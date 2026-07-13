import React, { useRef, useState } from 'react';
import { Sparkles, Trash2, Upload, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Modal } from '../ui.jsx';
import { detectPoNumberFromFile } from '../../utils/poDetect.js';

const MAX_BYTES = 20 * 1024 * 1024;

// Upload the client's purchase order against a deal. Saving stores the documents
// and marks the PO received (deals.po_number + po_received_at), which is what
// turns the deal's "Pending PO" state green here, on the pipeline card, and in
// Pending Payments — and seeds the reference on its Xero invoice.
export function UploadPoModal({ dealId, currentNumber, onClose, onSaved }) {
  const { actions, showMsg } = useStore();
  const [files, setFiles] = useState([]);
  const [poNumber, setPoNumber] = useState(currentNumber || '');
  const [detecting, setDetecting] = useState(false);
  // 'document' | 'filename' — where the prefilled number came from, so the user
  // knows whether to trust it. Cleared as soon as they type over it.
  const [detectedFrom, setDetectedFrom] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  // Don't overwrite a number the user typed themselves with a detected one.
  const touched = useRef(!!currentNumber);

  const addFiles = async (fileList) => {
    const list = Array.from(fileList || []);
    if (!list.length) return;
    const tooBig = list.find((f) => f.size > MAX_BYTES);
    if (tooBig) { showMsg?.(`"${tooBig.name}" is too large (max 20 MB)`, 'error'); return; }
    setFiles((cur) => [...cur, ...list]);
    if (inputRef.current) inputRef.current.value = '';

    if (touched.current) return;
    setDetecting(true);
    try {
      for (const f of list) {
        const hit = await detectPoNumberFromFile(f);
        if (hit) { setPoNumber(hit.number); setDetectedFrom(hit.source); break; }
      }
    } finally {
      setDetecting(false);
    }
  };

  const removeFile = (idx) => setFiles((cur) => cur.filter((_, i) => i !== idx));

  const save = async (e) => {
    e.preventDefault();
    const num = poNumber.trim();
    if (!files.length) { showMsg?.('Choose the purchase order document to upload', 'error'); return; }
    if (!num) { showMsg?.('Enter the PO number', 'error'); return; }
    setSaving(true);
    try {
      for (const f of files) await actions.uploadDealPoFile(dealId, f);
      await actions.markDealPoReceived(dealId, num);
      showMsg?.(`PO ${num} received`, 'success');
      onSaved?.(num);
      onClose?.();
    } catch (err) {
      showMsg?.(err.message || 'Could not save the purchase order', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} showClose={false}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Upload purchase order</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>

      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 12, color: BRAND.muted }}>
          Uploading marks the PO as received: the deal shows <strong>PO {'<number>'}</strong> in Pending Payments and on its pipeline card, and the number becomes the reference on its invoice.
        </p>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,image/*"
          style={{ display: 'none' }}
          onChange={(e) => addFiles(e.target.files)}
        />
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '18px 14px', border: '1px dashed ' + (dragOver ? BRAND.blue : BRAND.border),
            borderRadius: 8, cursor: 'pointer', background: dragOver ? '#F0F9FF' : BRAND.paper,
            fontSize: 13, color: BRAND.muted, textAlign: 'center',
          }}
        >
          <Upload size={14} />
          <span>Drop the PO here or click to choose (PDF or image, max 20 MB)</span>
        </div>

        {files.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {files.map((f, i) => (
              <div key={f.name + i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: '1px solid ' + BRAND.border, borderRadius: 6, background: 'white' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                <button type="button" onClick={() => removeFile(i)} className="btn-icon" aria-label={`Remove ${f.name}`} title="Remove">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.ink }}>PO number</span>
          <input
            type="text"
            value={poNumber}
            onChange={(e) => { touched.current = true; setDetectedFrom(null); setPoNumber(e.target.value); }}
            className="input"
            placeholder={detecting ? 'Reading the document…' : 'e.g. 4500012345'}
            autoFocus
          />
        </label>

        {detecting && (
          <p style={{ margin: 0, fontSize: 12, color: BRAND.muted }}>Looking for a PO number in the document…</p>
        )}
        {!detecting && detectedFrom && (
          <p style={{ margin: 0, fontSize: 12, color: '#15803D', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Sparkles size={12} />
            Found <strong>{poNumber}</strong> in the {detectedFrom === 'document' ? 'document' : 'filename'} — check it's right before saving.
          </p>
        )}
        {!detecting && !detectedFrom && files.length > 0 && !poNumber.trim() && (
          <p style={{ margin: 0, fontSize: 12, color: '#B45309' }}>
            Couldn&rsquo;t read a PO number from this file (scans and photos have no text to search) — type it in above.
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={saving || detecting || !files.length || !poNumber.trim()}>
            {saving ? 'Saving…' : 'Upload & mark PO received'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
