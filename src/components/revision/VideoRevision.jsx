import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Send, Clapperboard, Paperclip, X, FileDown, CheckCircle2, CalendarClock, Eye, Pencil, Trash2, Maximize2, Minimize2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { ConflictBanner } from './ConflictBanner.jsx';

const NAME_KEY = 'squideo.revision.name';
const EMAIL_KEY = 'squideo.revision.email';

// Diagonal, tiled "DRAFT" watermark as an inline SVG. Rendered as a repeating
// CSS background over the player so the watermark is never baked into the file.
const DRAFT_SVG = encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='280' height='190'>" +
  "<text x='10' y='120' transform='rotate(-28 140 95)' fill='rgba(255,255,255,0.20)' " +
  "font-size='38' font-weight='700' font-family='Arial, Helvetica, sans-serif' " +
  "letter-spacing='4'>DRAFT</text></svg>"
);

const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// A draft's display name. Older drafts were auto-labelled "Version N"; treat
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
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Renders a comment's supporting asset: inline thumbnail for images, download chip otherwise.
function CommentAttachment({ url, name, type }) {
  if ((type || '').startsWith('image/')) {
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

/**
 * Frame.io-style revision surface. `data` is the public payload from
 * /api/revisions/public: a project with one or more videos, each with drafts.
 * Reviewers must enter their name + email before viewing.
 */
export function VideoRevision({ token, data }) {
  const { actions, showMsg } = useStore();
  const videoRef = useRef(null);
  const playerWrapRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Use a wrapper-level fullscreen so the DRAFT overlay travels with the video.
  // The native <video> fullscreen renders only the media element, which would
  // strip the watermark and let a screen-recorder grab a clean copy.
  useEffect(() => {
    const handler = () => {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      setIsFullscreen(fsEl === playerWrapRef.current);
    };
    document.addEventListener('fullscreenchange', handler);
    document.addEventListener('webkitfullscreenchange', handler);
    return () => {
      document.removeEventListener('fullscreenchange', handler);
      document.removeEventListener('webkitfullscreenchange', handler);
    };
  }, []);

  function toggleFullscreen() {
    const el = playerWrapRef.current;
    if (!el) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
    }
  }

  // ── Name + email gate ──────────────────────────────────────────────────────
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) || '');
  const [email, setEmail] = useState(() => localStorage.getItem(EMAIL_KEY) || '');
  const [identified, setIdentified] = useState(() => !!localStorage.getItem(NAME_KEY) && isEmail(localStorage.getItem(EMAIL_KEY) || ''));
  const [gateName, setGateName] = useState(name);
  const [gateEmail, setGateEmail] = useState(email);

  function submitGate(e) {
    e.preventDefault();
    const n = gateName.trim();
    const em = gateEmail.trim();
    if (!n || !isEmail(em)) { showMsg('Please enter your name and a valid email'); return; }
    localStorage.setItem(NAME_KEY, n);
    localStorage.setItem(EMAIL_KEY, em);
    setName(n); setEmail(em); setIdentified(true);
    actions.recordRevisionViewer(token, { name: n, email: em }).catch(() => {});
  }

  // ── Video + draft selection ─────────────────────────────────────────────────
  const videos = data.videos || [];
  const [videoId, setVideoId] = useState(videos[0]?.id || null);
  const activeVideo = videos.find(v => v.id === videoId) || videos[0] || null;
  const versions = activeVideo?.versions || [];
  const [versionId, setVersionId] = useState(versions[0]?.id || null);
  // Keep a valid draft selected as the video changes.
  const version = versions.find(v => v.id === versionId) || versions[0] || null;

  const [comments, setComments] = useState(data.comments || []);
  const [activeViewers, setActiveViewers] = useState(data.activeViewers || []);
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  // Approval is per-video.
  const [approvals, setApprovals] = useState(() =>
    Object.fromEntries((data.videos || []).map(v => [v.id, v.approvedAt || null])));
  const approvedAt = activeVideo ? approvals[activeVideo.id] : null;
  const [approving, setApproving] = useState(false);
  // Per-video "feedback submitted" state (seeded from the server). The
  // standalone "Send feedback" button has been folded into "Finalise and send
  // revisions", so submitted is now stamped by finalise() and the polling
  // loop — but we still track it for the engagement analytics endpoint.
  const [submitted, setSubmitted] = useState(() =>
    Object.fromEntries((data.videos || []).map(v => [v.id, v.feedbackSubmittedAt || null])));

  const [draft, setDraft] = useState('');
  const [pinTime, setPinTime] = useState(null);
  const [pinned, setPinned] = useState(true);
  const [posting, setPosting] = useState(false);
  const [asset, setAsset] = useState(null);
  const [assetUploading, setAssetUploading] = useState(false);
  const fileRef = useRef(null);

  function selectVideo(id) {
    setVideoId(id);
    const v = videos.find(x => x.id === id);
    setVersionId(v?.versions?.[0]?.id || null);
  }

  const versionComments = useMemo(() => {
    const activeVersionId = version?.id;
    return comments
      .filter(c => c.versionId === activeVersionId)
      .sort((a, b) => {
        const at = a.timecodeSeconds, bt = b.timecodeSeconds;
        if (at == null && bt == null) return new Date(a.createdAt) - new Date(b.createdAt);
        if (at == null) return 1;
        if (bt == null) return -1;
        return at - bt;
      });
  }, [comments, version]);

  const markers = versionComments.filter(c => c.timecodeSeconds != null);

  function seekTo(seconds) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = seconds;
    v.pause();
  }

  function onComposerFocus() {
    setPinTime(videoRef.current ? videoRef.current.currentTime : 0);
  }

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

  async function submit() {
    const text = draft.trim();
    if ((!text && !asset) || !version) return;
    setPosting(true);
    try {
      const created = await actions.postRevisionComment(token, {
        versionId: version.id,
        body: text,
        authorName: name,
        authorEmail: email,
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

  // "Finalise and send revisions" merges what used to be Approve + Send
  // feedback into a single client action. Server-side, approveRevision now
  // stamps both approved_at and feedback_submitted_at and fires the team
  // notification.
  async function finalise() {
    if (!activeVideo || approvedAt) return;
    const commentCount = versionComments.length;
    const single = videos.length === 1;
    const what = single ? 'this video' : `"${activeVideo.title}"`;
    const msg = commentCount > 0
      ? `Send your ${commentCount} comment${commentCount === 1 ? '' : 's'} to the production team and finalise ${what}? `
        + `No further comments can be added after this.`
      : `You haven't left any comments. Finalise ${what} as approved with no changes? `
        + `No further comments can be added after this.`;
    if (!window.confirm(msg)) return;
    setApproving(true);
    try {
      const res = await actions.approveRevision(token, activeVideo.id, name);
      const at = res.approvedAt || new Date().toISOString();
      setApprovals(prev => ({ ...prev, [activeVideo.id]: at }));
      setSubmitted(prev => ({ ...prev, [activeVideo.id]: res.feedbackSubmittedAt || new Date().toISOString() }));
      showMsg('Revisions finalised and sent — thank you!');
    } catch (err) {
      showMsg(err.message || 'Could not finalise');
    } finally {
      setApproving(false);
    }
  }

  // Record a view whenever the client lands on / switches to a draft.
  useEffect(() => {
    if (!identified || !version) return;
    actions.recordRevisionView(token, { versionId: version.id, name, email });
  }, [identified, version?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates + presence heartbeat: poll publicView every ~6s once the
  // viewer has identified themselves. Refreshes comments (so co-viewers'
  // changes appear live), the activeViewers list (drives the presence banner),
  // and per-video approval / feedback-submitted state. We deliberately do NOT
  // overwrite the local videos/versions arrays or any in-progress UI state.
  useEffect(() => {
    if (!identified || !email) return;
    let alive = true;
    const tick = async () => {
      try {
        const d = await actions.pollPublicRevision(token, email);
        if (!alive || !d) return;
        setComments(d.comments || []);
        setActiveViewers(d.activeViewers || []);
        if (Array.isArray(d.videos)) {
          setApprovals(prev => {
            const next = { ...prev };
            for (const v of d.videos) next[v.id] = v.approvedAt || null;
            return next;
          });
          setSubmitted(prev => {
            const next = { ...prev };
            for (const v of d.videos) next[v.id] = v.feedbackSubmittedAt || null;
            return next;
          });
        }
      } catch { /* polling is best-effort */ }
    };
    tick();
    const handle = setInterval(tick, 6000);
    return () => { alive = false; clearInterval(handle); };
  }, [identified, email, token]); // eslint-disable-line react-hooks/exhaustive-deps

  function startEdit(c) {
    if (approvedAt) return;
    setEditingId(c.id);
    setEditingText(c.body || '');
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingText('');
  }

  async function saveEdit() {
    const id = editingId;
    const text = editingText.trim();
    if (!id || !text || savingEdit) return;
    setSavingEdit(true);
    try {
      const updated = await actions.editRevisionComment(token, id, text, email);
      setComments(prev => prev.map(c => (c.id === id ? { ...c, ...updated } : c)));
      setEditingId(null);
      setEditingText('');
    } catch (err) {
      showMsg(err.message || 'Could not save changes');
    } finally {
      setSavingEdit(false);
    }
  }

  async function deleteComment(c) {
    if (approvedAt) return;
    if (!window.confirm('Delete this comment? This cannot be undone.')) return;
    try {
      await actions.deleteRevisionComment(token, c.id, email);
      setComments(prev => prev.filter(x => x.id !== c.id));
      if (editingId === c.id) cancelEdit();
    } catch (err) {
      showMsg(err.message || 'Could not delete comment');
    }
  }

  // ── Gate screen ─────────────────────────────────────────────────────────────
  if (!identified) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: BRAND.paper, padding: 20 }}>
        <form onSubmit={submitGate} style={{ width: '100%', maxWidth: 380, background: '#fff',
          border: `1px solid ${BRAND.border}`, borderRadius: 12, padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Clapperboard size={20} color={BRAND.blue} />
            <strong style={{ fontSize: 16, color: BRAND.ink }}>{data.title}</strong>
          </div>
          <p style={{ color: BRAND.muted, fontSize: 13, margin: '0 0 18px' }}>
            Please enter your details to view and comment on this revision.
          </p>
          <label style={{ fontSize: 12, color: BRAND.muted }}>Your name</label>
          <input value={gateName} onChange={e => setGateName(e.target.value)} autoFocus
            style={{ width: '100%', padding: 9, borderRadius: 8, border: `1px solid ${BRAND.border}`,
              margin: '4px 0 12px', boxSizing: 'border-box', fontSize: 14 }} />
          <label style={{ fontSize: 12, color: BRAND.muted }}>Your email</label>
          <input value={gateEmail} onChange={e => setGateEmail(e.target.value)} type="email"
            style={{ width: '100%', padding: 9, borderRadius: 8, border: `1px solid ${BRAND.border}`,
              margin: '4px 0 18px', boxSizing: 'border-box', fontSize: 14 }} />
          <button type="submit"
            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: 'none',
              background: BRAND.blue, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
            View revisions
          </button>
        </form>
      </div>
    );
  }

  if (!activeVideo || !version) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: BRAND.muted }}>
        <Clapperboard size={32} style={{ opacity: 0.4 }} />
        <p>No video has been uploaded for review yet.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px',
        borderBottom: `1px solid ${BRAND.border}`, background: '#fff', flexWrap: 'wrap' }}>
        <Clapperboard size={20} color={BRAND.blue} />
        <strong style={{ color: BRAND.ink, fontSize: 15 }}>{data.title}</strong>
        {data.clientName && <span style={{ color: BRAND.muted, fontSize: 13 }}>· {data.clientName}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {videos.length > 1 && (
            <select value={videoId} onChange={e => selectVideo(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${BRAND.border}`, fontSize: 13, fontWeight: 600 }}>
              {videos.map(v => <option key={v.id} value={v.id}>{v.title}</option>)}
            </select>
          )}
          {versions.length > 1 && (
            <select value={version.id} onChange={e => setVersionId(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${BRAND.border}`, fontSize: 13 }}>
              {versions.map(v => <option key={v.id} value={v.id}>{draftLabel(v)}</option>)}
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
              <CheckCircle2 size={15} /> {videos.length > 1 ? 'Video finalised' : 'Revisions finalised'}
            </span>
          ) : (
            <button onClick={finalise} disabled={approving}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8,
                border: 'none', background: '#16A34A', color: '#fff', fontSize: 13, fontWeight: 600,
                cursor: approving ? 'default' : 'pointer' }}>
              <CheckCircle2 size={15} /> {approving ? 'Sending…' : 'Finalise and send revisions'}
            </button>
          )}
        </div>
      </div>

      <ConflictBanner activeViewers={activeViewers} />

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Player + marker strip */}
        <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', background: '#0B1B26', minWidth: 0 }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0 }}>
            <div
              ref={playerWrapRef}
              style={{
                position: 'relative',
                display: isFullscreen ? 'flex' : 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                maxWidth: '100%',
                maxHeight: '100%',
                width: isFullscreen ? '100%' : 'auto',
                height: isFullscreen ? '100%' : 'auto',
                background: isFullscreen ? '#000' : 'transparent',
              }}
            >
              <video
                ref={videoRef}
                key={version.id}
                src={version.videoUrl}
                controls
                controlsList="nodownload nofullscreen"
                disablePictureInPicture
                onContextMenu={e => e.preventDefault()}
                onLoadedMetadata={e => setDuration(e.target.duration || 0)}
                onTimeUpdate={e => setCurrentTime(e.target.currentTime || 0)}
                style={{ display: 'block', maxWidth: '100%', maxHeight: '100%' }}
              />
              <div aria-hidden style={{
                position: 'absolute', inset: 0, pointerEvents: 'none',
                backgroundImage: `url("data:image/svg+xml,${DRAFT_SVG}")`,
                backgroundRepeat: 'repeat',
              }} />
              <button
                onClick={toggleFullscreen}
                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                style={{
                  position: 'absolute', top: 8, right: 8,
                  width: 32, height: 32,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(0,0,0,0.55)', color: '#fff',
                  border: 'none', borderRadius: 6, cursor: 'pointer',
                }}
              >
                {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            </div>
          </div>
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
            {versionComments.map(c => {
              const isEditing = editingId === c.id;
              const canManage = c.mine && !approvedAt;
              return (
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
                    {canManage && !isEditing && (
                      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
                        <button onClick={() => startEdit(c)} title="Edit"
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                            color: BRAND.muted, padding: 2, display: 'inline-flex' }}>
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => deleteComment(c)} title="Delete"
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                            color: BRAND.muted, padding: 2, display: 'inline-flex' }}>
                          <Trash2 size={13} />
                        </button>
                      </span>
                    )}
                  </div>
                  {isEditing ? (
                    <div style={{ marginTop: 4 }}>
                      <textarea
                        value={editingText}
                        onChange={e => setEditingText(e.target.value)}
                        rows={3}
                        autoFocus
                        style={{ width: '100%', resize: 'vertical', padding: 8, borderRadius: 8,
                          border: `1px solid ${BRAND.border}`, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
                      />
                      <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
                        <button onClick={cancelEdit} disabled={savingEdit}
                          style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${BRAND.border}`,
                            background: '#fff', color: BRAND.ink, fontSize: 12, cursor: 'pointer' }}>
                          Cancel
                        </button>
                        <button onClick={saveEdit} disabled={savingEdit || !editingText.trim()}
                          style={{ padding: '6px 12px', borderRadius: 8, border: 'none',
                            background: editingText.trim() ? BRAND.blue : BRAND.border, color: '#fff',
                            fontWeight: 600, fontSize: 12, cursor: editingText.trim() ? 'pointer' : 'default' }}>
                          {savingEdit ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {c.body && <div style={{ fontSize: 13, color: BRAND.ink, marginTop: 2, whiteSpace: 'pre-wrap' }}>{c.body}</div>}
                      {c.attachmentUrl && <CommentAttachment url={c.attachmentUrl} name={c.attachmentName} type={c.attachmentType} />}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Composer (hidden once approved) */}
          {approvedAt ? (
            <div style={{ borderTop: `1px solid ${BRAND.border}`, padding: 16, textAlign: 'center',
              color: '#16A34A', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center',
              justifyContent: 'center', gap: 6 }}>
              <CheckCircle2 size={16} /> Approved — this video is finalised.
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
              placeholder="Leave your comment here…"
              rows={3}
              style={{ width: '100%', resize: 'none', padding: 8, borderRadius: 8,
                border: `1px solid ${BRAND.border}`, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
            />
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
                <Send size={14} /> {posting ? 'Adding…' : 'Add comment'}
              </button>
            </div>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

