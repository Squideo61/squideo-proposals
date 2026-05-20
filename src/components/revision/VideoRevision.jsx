import React, { useMemo, useRef, useState } from 'react';
import { MessageSquare, Send, Clapperboard, Paperclip, X, FileDown, CheckCircle2, CalendarClock } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';

const NAME_KEY = 'squideo.revision.name';

// Renders a comment's supporting asset: an inline thumbnail for images, or a
// download chip for anything else (PDFs, design files, etc.).
function CommentAttachment({ url, name, type }) {
  const isImage = (type || '').startsWith('image/');
  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 6 }}>
        <img src={url} alt={name || 'attachment'}
          style={{ maxWidth: '100%', maxHeight: 160, borderRadius: 8, border: `1px solid ${BRAND.border}`, display: 'block' }} />
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" download
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, padding: '6px 10px',
        borderRadius: 8, border: `1px solid ${BRAND.border}`, background: '#F8FAFC', color: BRAND.ink,
        fontSize: 12, textDecoration: 'none', maxWidth: '100%' }}>
      <FileDown size={14} color={BRAND.blue} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name || 'Download file'}</span>
    </a>
  );
}

// Diagonal, tiled "DRAFT" watermark as an inline SVG. Rendered as a repeating
// CSS background over the player so the watermark is never baked into the file.
const DRAFT_SVG = encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='280' height='190'>" +
  "<text x='10' y='120' transform='rotate(-28 140 95)' fill='rgba(255,255,255,0.20)' " +
  "font-size='38' font-weight='700' font-family='Arial, Helvetica, sans-serif' " +
  "letter-spacing='4'>DRAFT</text></svg>"
);

// A draft's display name. Older versions were auto-labelled "Version N"; treat
// those (and empty labels) as "Draft N" so the wording is consistent.
function draftLabel(v) {
  return (v.label && !/^Version \d+$/.test(v.label)) ? v.label : ('Draft ' + v.versionNumber);
}

// mm:ss (or h:mm:ss for long videos) — the timecode style clients expect.
function tc(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(h ? m : m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Frame.io-style revision surface: a video player on the left and a timecoded
 * comment thread on the right. `data` is the public payload from
 * /api/revisions/public. Comments are posted through the store and
 * appended locally (no realtime needed for v1).
 */
export function VideoRevision({ token, data }) {
  const { actions, showMsg } = useStore();
  const videoRef = useRef(null);

  const versions = data.versions || [];
  const [versionId, setVersionId] = useState(versions[0]?.id || null);
  const version = versions.find(v => v.id === versionId) || versions[0] || null;

  const [comments, setComments] = useState(data.comments || []);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [approvedAt, setApprovedAt] = useState(data.approvedAt || null);
  const [approving, setApproving] = useState(false);

  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) || '');
  const [draft, setDraft] = useState('');
  const [pinTime, setPinTime] = useState(null);   // timecode the comment will attach to
  const [pinned, setPinned] = useState(true);     // whether to attach a timecode at all
  const [posting, setPosting] = useState(false);
  const [asset, setAsset] = useState(null);        // uploaded { url, name, type }
  const [assetUploading, setAssetUploading] = useState(false);
  const fileRef = useRef(null);

  async function attachFile(file) {
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { showMsg('File too large (max 100 MB)'); return; }
    setAssetUploading(true);
    try {
      const uploaded = await actions.uploadRevisionAsset(token, file);
      setAsset(uploaded);
    } catch (err) {
      showMsg(err.message || 'Could not upload file');
    } finally {
      setAssetUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  // Comments for the active version, with timecoded ones ordered by time and
  // general ones last.
  const versionComments = useMemo(() => {
    return comments
      .filter(c => c.versionId === versionId)
      .sort((a, b) => {
        const at = a.timecodeSeconds, bt = b.timecodeSeconds;
        if (at == null && bt == null) return new Date(a.createdAt) - new Date(b.createdAt);
        if (at == null) return 1;
        if (bt == null) return -1;
        return at - bt;
      });
  }, [comments, versionId]);

  const markers = versionComments.filter(c => c.timecodeSeconds != null);

  function seekTo(seconds) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = seconds;
    v.pause();
  }

  // Capture the current frame's time when the client starts writing, so the
  // comment pins to where they paused — just like Frame.io.
  function onComposerFocus() {
    setPinTime(videoRef.current ? videoRef.current.currentTime : 0);
  }

  async function submit() {
    const text = draft.trim();
    if (!text && !asset) return;
    let author = name.trim();
    if (!author) {
      author = (window.prompt('Your name (shown with your comments):') || '').trim();
      if (!author) return;
      setName(author);
      localStorage.setItem(NAME_KEY, author);
    }
    setPosting(true);
    try {
      const created = await actions.postRevisionComment(token, {
        versionId,
        body: text,
        authorName: author,
        timecodeSeconds: pinned ? (pinTime ?? 0) : null,
        attachmentUrl: asset?.url || null,
        attachmentName: asset?.name || null,
        attachmentType: asset?.type || null,
      });
      setComments(prev => [...prev, created]);
      setDraft('');
      setPinTime(null);
      setAsset(null);
    } catch (err) {
      showMsg(err.message || 'Could not post comment');
    } finally {
      setPosting(false);
    }
  }

  async function approve() {
    if (approvedAt) return;
    let approver = name.trim();
    if (!approver) {
      approver = (window.prompt('Your name (to confirm approval):') || '').trim();
      if (!approver) return;
      setName(approver);
      localStorage.setItem(NAME_KEY, approver);
    }
    if (!window.confirm('Approve all revisions? This finalises the video and no further comments can be added.')) return;
    setApproving(true);
    try {
      const res = await actions.approveRevision(token, approver);
      setApprovedAt(res.approvedAt || new Date().toISOString());
      showMsg('Revisions approved — thank you!');
    } catch (err) {
      showMsg(err.message || 'Could not approve');
    } finally {
      setApproving(false);
    }
  }

  if (!version) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: BRAND.muted }}>
        <Clapperboard size={32} style={{ opacity: 0.4 }} />
        <p>No video has been uploaded for revision yet.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px',
        borderBottom: `1px solid ${BRAND.border}`, background: '#fff' }}>
        <Clapperboard size={20} color={BRAND.blue} />
        <strong style={{ color: BRAND.ink, fontSize: 15 }}>{data.title}</strong>
        {data.clientName && <span style={{ color: BRAND.muted, fontSize: 13 }}>· {data.clientName}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {versions.length > 1 && (
            <select value={versionId} onChange={e => setVersionId(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${BRAND.border}`, fontSize: 13 }}>
              {versions.map(v => (
                <option key={v.id} value={v.id}>{draftLabel(v)}</option>
              ))}
            </select>
          )}
          {data.callUrl && (
            <a href={data.callUrl} target="_blank" rel="noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8,
                border: `1px solid ${BRAND.border}`, background: '#fff', color: BRAND.ink, fontSize: 13,
                fontWeight: 600, textDecoration: 'none' }}>
              <CalendarClock size={15} color={BRAND.blue} /> Schedule Review Call
            </a>
          )}
          {approvedAt ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8,
              background: '#16A34A', color: '#fff', fontSize: 13, fontWeight: 600 }}>
              <CheckCircle2 size={15} /> Revisions approved
            </span>
          ) : (
            <button onClick={approve} disabled={approving}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8,
                border: 'none', background: '#16A34A', color: '#fff', fontSize: 13, fontWeight: 600,
                cursor: approving ? 'default' : 'pointer' }}>
              <CheckCircle2 size={15} /> {approving ? 'Approving…' : 'Approve Revisions'}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Player + marker strip */}
        <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', background: '#0B1B26', minWidth: 0 }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0 }}>
            <div style={{ position: 'relative', display: 'inline-flex', maxWidth: '100%', maxHeight: '100%' }}>
              <video
                ref={videoRef}
                src={version.videoUrl}
                controls
                controlsList="nodownload"
                onContextMenu={e => e.preventDefault()}
                onLoadedMetadata={e => setDuration(e.target.duration || 0)}
                onTimeUpdate={e => setCurrentTime(e.target.currentTime || 0)}
                style={{ display: 'block', maxWidth: '100%', maxHeight: '100%' }}
              />
              {/* Tiled "DRAFT" watermark — overlaid in CSS so we never have to
                  burn it into the video file. pointer-events:none keeps the
                  player fully usable underneath. */}
              <div aria-hidden style={{
                position: 'absolute', inset: 0, pointerEvents: 'none',
                backgroundImage: `url("data:image/svg+xml,${DRAFT_SVG}")`,
                backgroundRepeat: 'repeat',
              }} />
            </div>
          </div>
          {/* Comment markers along the timeline */}
          <div style={{ position: 'relative', height: 28, background: '#0B1B26',
            borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            {duration > 0 && markers.map(c => (
              <button
                key={c.id}
                title={`${tc(c.timecodeSeconds)} — ${c.authorName}`}
                onClick={() => seekTo(c.timecodeSeconds)}
                style={{ position: 'absolute', top: 6, left: `calc(${(c.timecodeSeconds / duration) * 100}% - 7px)`,
                  width: 14, height: 14, borderRadius: '50%', background: BRAND.blue, border: '2px solid #fff',
                  cursor: 'pointer', padding: 0 }}
              />
            ))}
          </div>
        </div>

        {/* Comment thread */}
        <div style={{ width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column',
          borderLeft: `1px solid ${BRAND.border}`, background: '#fff' }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${BRAND.border}`,
            display: 'flex', alignItems: 'center', gap: 8, color: BRAND.ink, fontWeight: 600, fontSize: 14 }}>
            <MessageSquare size={16} /> {versionComments.length} Comment{versionComments.length === 1 ? '' : 's'}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
            {versionComments.length === 0 && (
              <p style={{ color: BRAND.muted, fontSize: 13, textAlign: 'center', marginTop: 24 }}>
                Play the video, pause where you'd like a change, and leave a comment.
              </p>
            )}
            {versionComments.map(c => (
              <div key={c.id} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <strong style={{ fontSize: 13, color: BRAND.ink }}>{c.authorName}</strong>
                  {c.timecodeSeconds != null && (
                    <button onClick={() => seekTo(c.timecodeSeconds)}
                      style={{ background: 'transparent', border: 'none', color: BRAND.blue, cursor: 'pointer',
                        fontSize: 12, fontWeight: 700, padding: 0 }}>
                      {tc(c.timecodeSeconds)}
                    </button>
                  )}
                </div>
                {c.body && <div style={{ fontSize: 13, color: BRAND.ink, marginTop: 2, whiteSpace: 'pre-wrap' }}>{c.body}</div>}
                {c.attachmentUrl && <CommentAttachment url={c.attachmentUrl} name={c.attachmentName} type={c.attachmentType} />}
              </div>
            ))}
          </div>

          {/* Composer (hidden once approved) */}
          {approvedAt ? (
            <div style={{ borderTop: `1px solid ${BRAND.border}`, padding: 16, textAlign: 'center',
              color: '#16A34A', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center',
              justifyContent: 'center', gap: 6 }}>
              <CheckCircle2 size={16} /> Revisions approved — this video is finalised.
            </div>
          ) : (
          <div style={{ borderTop: `1px solid ${BRAND.border}`, padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: BRAND.muted, cursor: 'pointer' }}>
                <input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} />
                Attach to {tc(pinned ? (pinTime ?? currentTime) : currentTime)}
              </label>
            </div>
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onFocus={onComposerFocus}
              placeholder={name ? 'Leave your comment here…' : 'Leave your comment here… (we\'ll ask your name)'}
              rows={3}
              style={{ width: '100%', resize: 'none', padding: 8, borderRadius: 8,
                border: `1px solid ${BRAND.border}`, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
            />
            {/* Pending attachment chip */}
            {(asset || assetUploading) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: BRAND.muted }}>
                <Paperclip size={13} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {assetUploading ? 'Uploading attachment…' : asset.name}
                </span>
                {asset && !assetUploading && (
                  <button onClick={() => setAsset(null)} title="Remove"
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: BRAND.muted, padding: 0, display: 'flex' }}>
                    <X size={14} />
                  </button>
                )}
              </div>
            )}
            <input ref={fileRef} type="file" style={{ display: 'none' }}
              onChange={e => attachFile(e.target.files?.[0])} />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={assetUploading || posting}
                title="Attach a file (e.g. a replacement logo)"
                style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${BRAND.border}`,
                  background: '#fff', color: BRAND.ink, cursor: assetUploading ? 'default' : 'pointer',
                  display: 'flex', alignItems: 'center' }}>
                <Paperclip size={15} />
              </button>
              <button
                onClick={submit}
                disabled={posting || assetUploading || (!draft.trim() && !asset)}
                style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: 'none',
                  background: (draft.trim() || asset) ? BRAND.blue : BRAND.border, color: '#fff', fontWeight: 600,
                  fontSize: 13, cursor: (draft.trim() || asset) ? 'pointer' : 'default',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <Send size={14} /> {posting ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
