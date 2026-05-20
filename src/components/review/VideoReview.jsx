import React, { useMemo, useRef, useState } from 'react';
import { MessageSquare, Send, Clapperboard } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';

const NAME_KEY = 'squideo.review.name';

// Diagonal, tiled "DRAFT" watermark as an inline SVG. Rendered as a repeating
// CSS background over the player so the watermark is never baked into the file.
const DRAFT_SVG = encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='280' height='190'>" +
  "<text x='10' y='120' transform='rotate(-28 140 95)' fill='rgba(255,255,255,0.20)' " +
  "font-size='38' font-weight='700' font-family='Arial, Helvetica, sans-serif' " +
  "letter-spacing='4'>DRAFT</text></svg>"
);

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
 * Frame.io-style review surface: a video player on the left and a timecoded
 * comment thread on the right. `data` is the public payload from
 * /api/reviews?action=public. Comments are posted through the store and
 * appended locally (no realtime needed for v1).
 */
export function VideoReview({ token, data }) {
  const { actions, showMsg } = useStore();
  const videoRef = useRef(null);

  const versions = data.versions || [];
  const [versionId, setVersionId] = useState(versions[0]?.id || null);
  const version = versions.find(v => v.id === versionId) || versions[0] || null;

  const [comments, setComments] = useState(data.comments || []);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) || '');
  const [draft, setDraft] = useState('');
  const [pinTime, setPinTime] = useState(null);   // timecode the comment will attach to
  const [pinned, setPinned] = useState(true);     // whether to attach a timecode at all
  const [posting, setPosting] = useState(false);

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
    if (!text) return;
    let author = name.trim();
    if (!author) {
      author = (window.prompt('Your name (shown with your comments):') || '').trim();
      if (!author) return;
      setName(author);
      localStorage.setItem(NAME_KEY, author);
    }
    setPosting(true);
    try {
      const created = await actions.postReviewComment(token, {
        versionId,
        body: text,
        authorName: author,
        timecodeSeconds: pinned ? (pinTime ?? 0) : null,
      });
      setComments(prev => [...prev, created]);
      setDraft('');
      setPinTime(null);
    } catch (err) {
      showMsg(err.message || 'Could not post comment');
    } finally {
      setPosting(false);
    }
  }

  if (!version) {
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
        borderBottom: `1px solid ${BRAND.border}`, background: '#fff' }}>
        <Clapperboard size={20} color={BRAND.blue} />
        <strong style={{ color: BRAND.ink, fontSize: 15 }}>{data.title}</strong>
        {data.clientName && <span style={{ color: BRAND.muted, fontSize: 13 }}>· {data.clientName}</span>}
        <div style={{ marginLeft: 'auto' }}>
          {versions.length > 1 && (
            <select value={versionId} onChange={e => setVersionId(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${BRAND.border}`, fontSize: 13 }}>
              {versions.map(v => (
                <option key={v.id} value={v.id}>{v.label || ('Version ' + v.versionNumber)}</option>
              ))}
            </select>
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
                <div style={{ fontSize: 13, color: BRAND.ink, marginTop: 2, whiteSpace: 'pre-wrap' }}>{c.body}</div>
              </div>
            ))}
          </div>

          {/* Composer */}
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
            <button
              onClick={submit}
              disabled={posting || !draft.trim()}
              style={{ marginTop: 6, width: '100%', padding: '8px 12px', borderRadius: 8, border: 'none',
                background: draft.trim() ? BRAND.blue : BRAND.border, color: '#fff', fontWeight: 600,
                fontSize: 13, cursor: draft.trim() ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <Send size={14} /> {posting ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
