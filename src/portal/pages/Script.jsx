// "Script & visual direction" — one client-facing stage covering both halves.
// Clients upload their script and any visual direction (references, look & feel,
// brand cues), see everything we've already got, and can send an updated version
// at any point — each upload alerts the project team. If they'd rather we wrote
// it, one button says so; if they sent the script by email before the deal even
// closed, the team ticks "we already have it" and this page reflects that.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, FileRow, SectionHeading } from '../components.jsx';
import { ArrowLeft, FileText, Palette, Check, PenLine } from 'lucide-react';

const KINDS = [
  {
    id: 'script',
    Icon: FileText,
    label: 'Script',
    hint: 'Your words — a full script, a rough draft, or bullet points to work from.',
    cta: 'Upload your script',
  },
  {
    id: 'visual_direction',
    Icon: Palette,
    label: 'Visual direction',
    hint: 'The look and feel — mood boards, screenshots, style notes, or a doc of reference links.',
    cta: 'Upload visual direction',
  },
];

function DropZone({ kind, onFiles, uploading }) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);
  const { Icon } = kind;
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(Array.from(e.dataTransfer.files || [])); }}
      onClick={() => inputRef.current?.click()}
      style={{
        flex: '1 1 240px',
        border: `2px dashed ${drag ? BRAND.blue : BRAND.border}`,
        background: drag ? BRAND.blue + '0d' : '#FAFBFC',
        borderRadius: 12, padding: '20px 16px', textAlign: 'center', cursor: 'pointer',
        transition: 'all 0.15s ease',
      }}
    >
      <Icon size={20} color={drag ? BRAND.blue : BRAND.muted} />
      <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink, marginTop: 8 }}>
        {uploading ? 'Uploading…' : kind.cta}
      </div>
      <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 4, lineHeight: 1.45 }}>{kind.hint}</div>
      <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 6, opacity: 0.8 }}>
        Drag &amp; drop or click — docs, PDFs or images, max 20 MB each
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

// The one-line answer to "where does this project's script stand?".
function StatusBanner({ data }) {
  const sent = (data.files || []).length;
  const wroteByUs = data.status === 'squideo' && sent === 0;
  const tone = sent > 0 || data.status
    ? { bg: '#F0FDF4', border: '#BBF7D0', color: '#15803D' }
    : { bg: '#FFFBEB', border: '#FDE68A', color: '#B45309' };
  const text = data.status === 'refining'
    ? 'We’re refining your draft script — we’ll share it back for your approval. Send another version any time.'
    : sent > 0
      ? `We’ve got ${sent} file${sent === 1 ? '' : 's'} from you. Send an updated version any time — your producer is notified straight away.`
      : wroteByUs
        ? 'You’ve asked us to write the script — we’ll share a draft for your approval. Changed your mind? Upload yours below.'
        : data.receivedElsewhere
          ? 'We already have your script on file — thank you. If anything changes, upload the new version below.'
          : 'Nothing here yet. Send us your script and any visual direction, or ask us to write it for you.';
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 12,
      padding: '12px 14px',
    }}>
      {sent > 0 || data.status
        ? <Check size={17} color={tone.color} style={{ flexShrink: 0, marginTop: 1 }} />
        : <PenLine size={17} color={tone.color} style={{ flexShrink: 0, marginTop: 1 }} />}
      <div style={{ fontSize: 13, color: BRAND.ink, lineHeight: 1.5 }}>{text}</div>
    </div>
  );
}

export default function Script({ dealId }) {
  const { showToast } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(null); // the kind id being uploaded
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await portalApi.get(`script?dealId=${encodeURIComponent(dealId)}`));
    } catch (err) {
      setError(err.message);
    }
  }, [dealId]);

  useEffect(() => { load(); }, [load]);

  const upload = async (kindId, list) => {
    if (!list.length) return;
    setUploading(kindId);
    try {
      for (const file of list.slice(0, 10)) {
        // eslint-disable-next-line no-await-in-loop
        await portalApi.upload(
          `files?scope=deal&dealId=${encodeURIComponent(dealId)}&category=${kindId}`,
          file,
        );
      }
      showToast('Sent ✓ — your producer has been notified');
      await load();
    } catch (err) {
      showToast(err.message);
    } finally {
      setUploading(null);
    }
  };

  const setWriteForUs = async (writeForUs) => {
    setBusy(true);
    try {
      await portalApi.post(`script?dealId=${encodeURIComponent(dealId)}`, { writeForUs });
      showToast(writeForUs ? 'Noted — we’ll write it ✓' : 'Updated ✓');
      await load();
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div>
        <a href="#/" className="btn-link" style={{ fontSize: 13 }}><ArrowLeft size={14} style={{ verticalAlign: -2 }} /> Back</a>
        <Card style={{ marginTop: 14 }}><EmptyState title="Couldn’t load this step" body={error} /></Card>
      </div>
    );
  }
  if (!data) return <div style={{ color: BRAND.muted, fontSize: 13, padding: 30, textAlign: 'center' }}>Loading…</div>;

  const files = data.files || [];
  const askedUsToWrite = data.status === 'squideo';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <a href={`#/project/${dealId}`} className="btn-link" style={{ fontSize: 13 }}>
          <ArrowLeft size={14} style={{ verticalAlign: -2 }} /> {data.dealTitle || 'Project'}
        </a>
        <h1 style={{ margin: '8px 0 4px', fontSize: 22, fontWeight: 800, color: BRAND.ink }}>Script &amp; visual direction ✍️</h1>
        <p style={{ margin: 0, fontSize: 13.5, color: BRAND.muted, maxWidth: 620, lineHeight: 1.55 }}>
          The words and the look. Send whatever you have — a finished script, a rough outline, reference
          videos, brand cues — and we’ll take it from there. You can send updated versions at any point.
        </p>
      </div>

      <Card style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <StatusBanner data={data} />

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {KINDS.map((kind) => (
            <DropZone
              key={kind.id}
              kind={kind}
              uploading={uploading === kind.id}
              onFiles={(list) => upload(kind.id, list)}
            />
          ))}
        </div>

        {/* Not every project starts with a client script — this keeps the step
            answerable (and off their to-do list) when we're the ones writing. */}
        {files.length === 0 && (
          askedUsToWrite ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: BRAND.muted }}>
              <Check size={14} color="#16A34A" />
              <span>You’ve asked us to write the script.</span>
              <button className="btn-link" style={{ fontSize: 12.5, fontWeight: 700 }} disabled={busy} onClick={() => setWriteForUs(false)}>
                Undo
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: BRAND.muted }}>
              <span>Haven’t got a script?</span>
              <button className="btn-ghost" style={{ fontSize: 12.5, fontWeight: 700 }} disabled={busy} onClick={() => setWriteForUs(true)}>
                <PenLine size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
                Ask us to write it
              </button>
            </div>
          )
        )}
      </Card>

      <Card>
        <SectionHeading>What we’ve got{files.length ? ` · ${files.length}` : ''}</SectionHeading>
        {files.length === 0 ? (
          <div style={{ fontSize: 13, color: BRAND.muted }}>
            Nothing uploaded here yet. Anything you send appears in this list, newest first.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {files.map((f) => (
              <FileRow
                key={f.id}
                filename={f.filename}
                sizeBytes={f.sizeBytes}
                createdAt={f.createdAt}
                meta={[
                  f.category === 'visual_direction' ? 'Visual direction' : 'Script',
                  f.uploadedByName ? `by ${f.uploadedByName}` : null,
                ].filter(Boolean).join(' · ')}
                onDownload={() => { window.location.href = `/api/portal/download?scope=deal&id=${encodeURIComponent(f.id)}`; }}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
