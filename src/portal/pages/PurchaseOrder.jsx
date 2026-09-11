// "Send us your purchase order" — the PO step's own page. Before the PO is in
// it's where they submit it: the PO DOCUMENT and its number, together — a
// number on its own isn't enough, finance needs the document. After, it's where
// "View" takes them: the number we hold and every PO document on file. The
// documents are the same ones on the CRM deal's Purchase order card, so a PO
// the team filed from an email shows here too, and one uploaded here lands on
// that card.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi, mediaUrl } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, FileRow, SectionHeading } from '../components.jsx';
import { detectPoNumberFromFile } from '../../utils/poDetect.js';
import { ArrowLeft, Check, FileText, Receipt, AlertCircle, Sparkles, X } from 'lucide-react';

const MAX_BYTES = 20 * 1024 * 1024;

// First submission: the document (required) and the number (required, read off
// the document where we can). Sent as ONE upload so the PO is never recorded
// half-done.
function SubmitPoForm({ dealId, onDone }) {
  const { showToast } = usePortal();
  const [file, setFile] = useState(null);
  const [poNumber, setPoNumber] = useState('');
  const [detectedFrom, setDetectedFrom] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [sending, setSending] = useState(false);
  const [drag, setDrag] = useState(false);
  const touched = useRef(false); // they typed a number — don't overwrite it
  const inputRef = useRef(null);

  const pick = async (f) => {
    if (!f) return;
    if (f.size > MAX_BYTES) { showToast(`"${f.name}" is too large (max 20 MB)`); return; }
    setFile(f);
    if (touched.current) return;
    setDetecting(true);
    try {
      const hit = await detectPoNumberFromFile(f);
      if (hit) { setPoNumber(hit.number); setDetectedFrom(hit.source); }
    } catch { /* detection is only ever a prefill */ } finally {
      setDetecting(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!file || !poNumber.trim()) return;
    setSending(true);
    try {
      await portalApi.upload(
        `po?dealId=${encodeURIComponent(dealId)}&poNumber=${encodeURIComponent(poNumber.trim())}`,
        file,
      );
      showToast('Purchase order sent ✓ — thank you');
      await onDone();
    } catch (err) {
      showToast(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.ink, marginBottom: 6 }}>1. Your PO document</div>
        {file ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
            border: `1px solid ${BRAND.border}`, borderRadius: 10, background: '#fff',
          }}>
            <FileText size={18} color={BRAND.blue} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {file.name}
            </div>
            <button
              type="button"
              className="btn-ghost"
              title="Choose a different file"
              disabled={sending}
              onClick={() => { setFile(null); if (!touched.current) { setPoNumber(''); setDetectedFrom(null); } }}
              style={{ padding: '6px 8px' }}
            >
              <X size={15} style={{ verticalAlign: -3 }} />
            </button>
          </div>
        ) : (
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
            onClick={() => inputRef.current?.click()}
            style={{
              border: `2px dashed ${drag ? BRAND.blue : BRAND.border}`,
              background: drag ? BRAND.blue + '0d' : '#FAFBFC',
              borderRadius: 12, padding: '20px 16px', textAlign: 'center', cursor: 'pointer',
            }}
          >
            <FileText size={20} color={drag ? BRAND.blue : BRAND.muted} />
            <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink, marginTop: 8 }}>Upload your PO document</div>
            <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 6, opacity: 0.8 }}>
              Drag &amp; drop or click — PDF or image, max 20 MB
            </div>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          hidden
          accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx"
          onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }}
        />
      </div>

      <div>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.ink, marginBottom: 6 }}>2. The PO number</div>
        <input
          className="input"
          required
          maxLength={60}
          placeholder={detecting ? 'Reading your document…' : 'e.g. PO-2026-0042'}
          value={poNumber}
          onChange={(e) => { touched.current = true; setPoNumber(e.target.value); setDetectedFrom(null); }}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
        {detectedFrom && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: BRAND.muted, marginTop: 5 }}>
            <Sparkles size={12} /> Read from your {detectedFrom === 'document' ? 'document' : 'file name'} — check it’s right.
          </div>
        )}
      </div>

      <div>
        <button className="btn" type="submit" disabled={sending || !file || !poNumber.trim()}>
          {sending ? 'Sending…' : 'Send purchase order'}
        </button>
      </div>
    </form>
  );
}

function DropZone({ onFiles, uploading, label = 'Upload your PO document' }) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (!uploading) onFiles(Array.from(e.dataTransfer.files || [])); }}
      onClick={() => { if (!uploading) inputRef.current?.click(); }}
      style={{
        border: `2px dashed ${drag ? BRAND.blue : BRAND.border}`,
        background: drag ? BRAND.blue + '0d' : '#FAFBFC',
        borderRadius: 12, padding: '20px 16px', textAlign: 'center',
        cursor: uploading ? 'wait' : 'pointer', transition: 'all 0.15s ease',
      }}
    >
      <FileText size={20} color={drag ? BRAND.blue : BRAND.muted} />
      <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink, marginTop: 8 }}>
        {uploading ? 'Uploading…' : label}
      </div>
      <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 6, opacity: 0.8 }}>
        Drag &amp; drop or click — PDF or image, max 20 MB each
      </div>
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        disabled={uploading}
        onChange={(e) => { onFiles(Array.from(e.target.files || [])); e.target.value = ''; }}
      />
    </div>
  );
}

export default function PurchaseOrder({ dealId }) {
  const { showToast } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await portalApi.get(`po?dealId=${encodeURIComponent(dealId)}`));
    } catch (err) {
      setError(err.message);
    }
  }, [dealId]);

  useEffect(() => { load(); }, [load]);

  // A document for a PO whose number we already hold — completing it, or
  // adding a revised / second PO once it's in.
  const upload = async (list) => {
    if (!list.length) return;
    setUploading(true);
    try {
      for (const file of list.slice(0, 10)) {
        // eslint-disable-next-line no-await-in-loop
        await portalApi.upload(`po?dealId=${encodeURIComponent(dealId)}`, file);
      }
      showToast('Sent ✓ — our team has been notified');
      await load();
    } catch (err) {
      showToast(err.message);
    } finally {
      setUploading(false);
    }
  };

  if (error) {
    return (
      <div>
        <a href={`#/project/${dealId}`} className="btn-link" style={{ fontSize: 13 }}><ArrowLeft size={14} style={{ verticalAlign: -2 }} /> Back</a>
        <Card style={{ marginTop: 14 }}><EmptyState title="Couldn’t load your purchase order" body={error} /></Card>
      </div>
    );
  }
  if (!data) return <div style={{ color: BRAND.muted, fontSize: 13, padding: 30, textAlign: 'center' }}>Loading…</div>;

  const files = data.files || [];
  const received = !!data.received;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <a href={`#/project/${dealId}`} className="btn-link" style={{ fontSize: 13 }}>
          <ArrowLeft size={14} style={{ verticalAlign: -2 }} /> {data.dealTitle || 'Project'}
        </a>
        <h1 style={{ margin: '8px 0 4px', fontSize: 22, fontWeight: 800, color: BRAND.ink }}>Purchase order 📋</h1>
        <p style={{ margin: 0, fontSize: 13.5, color: BRAND.muted, maxWidth: 620, lineHeight: 1.55 }}>
          Please upload the purchase order itself, not just the number — we need its full details
          to raise your invoice, and we quote the PO number on it so it goes straight through with your finance team.
        </p>
      </div>

      <Card style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {received ? (
          <>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 12, padding: '12px 14px',
            }}>
              <Check size={17} color="#15803D" style={{ flexShrink: 0 }} />
              <div style={{ fontSize: 13, color: BRAND.ink, lineHeight: 1.5, flex: 1, minWidth: 180 }}>
                We have your purchase order — thank you. It’ll be quoted on your invoice.
              </div>
              {data.poNumber && (
                <div style={{ fontSize: 15, fontWeight: 800, color: BRAND.ink, whiteSpace: 'nowrap' }}>PO {data.poNumber}</div>
              )}
            </div>
            <DropZone onFiles={upload} uploading={uploading} label="Upload another PO document" />
            <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.5 }}>
              Need to change the PO number? Reply to your producer and we’ll update it.
            </div>
          </>
        ) : data.poNumber ? (
          // The number came in without its document (before the document was
          // required). Ask for the document against the number we hold.
          <>
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 12, padding: '12px 14px',
            }}>
              <AlertCircle size={17} color="#B45309" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 13, color: BRAND.ink, lineHeight: 1.5 }}>
                We have <strong>PO {data.poNumber}</strong>, but not the purchase order document itself.
                Please upload it — we need the full details from it to raise your invoice.
              </div>
            </div>
            <DropZone onFiles={upload} uploading={uploading} />
          </>
        ) : (
          <SubmitPoForm dealId={dealId} onDone={load} />
        )}
      </Card>

      <Card>
        <SectionHeading>PO documents{files.length ? ` · ${files.length}` : ''}</SectionHeading>
        {files.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: BRAND.muted }}>
            <Receipt size={15} style={{ flexShrink: 0 }} />
            No PO document on file yet. Anything you upload appears here, newest first.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {files.map((f) => (
              <FileRow
                key={f.id}
                filename={f.filename}
                sizeBytes={f.sizeBytes}
                createdAt={f.createdAt}
                onDownload={() => { window.location.href = mediaUrl(`download?scope=po&id=${encodeURIComponent(f.id)}&dealId=${encodeURIComponent(dealId)}`); }}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
