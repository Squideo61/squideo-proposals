import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Send, Images, Paperclip, X, FileDown, CheckCircle2, CalendarClock, MapPin, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useIsMobile } from '../../utils.js';
import { loadPdf } from '../../lib/pdf.js';
import { PdfPage } from './PdfPage.jsx';
import { PdfThumb } from './PdfThumb.jsx';
import { ConflictBanner } from '../revision/ConflictBanner.jsx';

const NAME_KEY = 'squideo.storyboard.name';
const EMAIL_KEY = 'squideo.storyboard.email';

// Diagonal, tiled "DRAFT" watermark as an inline SVG, overlaid on the slide so
// it's never baked into the file.
const DRAFT_SVG = encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='280' height='190'>" +
  "<text x='10' y='120' transform='rotate(-28 140 95)' fill='rgba(15,42,61,0.10)' " +
  "font-size='38' font-weight='700' font-family='Arial, Helvetica, sans-serif' " +
  "letter-spacing='4'>DRAFT</text></svg>"
);

const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// Round prev/next slide button (disabled state dims + blocks the click).
// Bigger on a phone so it clears the ~44px touch target.
function navBtn(disabled, big = false) {
  const size = big ? 44 : 34;
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: size, height: size, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.25)',
    background: 'rgba(255,255,255,0.08)', color: '#fff', padding: 0,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.35 : 1,
  };
}

// Slide picker. Vertical column on desktop; on a phone the same thumbnails run
// as a horizontally-scrolling filmstrip so they cost ~90px of height instead of
// 148px of width.
function SlideRail({ pages, pageNumber, goToPage, comments, versionId, pdfUrl, horizontal = false }) {
  const thumbWidth = horizontal ? 84 : 120;
  return (
    <div style={horizontal
      ? { flexShrink: 0, display: 'flex', gap: 8, overflowX: 'auto', WebkitOverflowScrolling: 'touch',
          background: '#0B1B26', borderTop: '1px solid rgba(255,255,255,0.08)', padding: '8px 10px' }
      : { width: 148, flexShrink: 0, overflowY: 'auto', background: '#0B1B26',
          borderRight: '1px solid rgba(255,255,255,0.08)', padding: 10 }}>
      {pages.map(n => {
        const count = comments.filter(c => c.versionId === versionId && (c.pageNumber || 1) === n).length;
        const active = n === pageNumber;
        return (
          <button key={n} onClick={() => goToPage(n)}
            style={{ display: 'block', flexShrink: horizontal ? 0 : undefined,
              width: horizontal ? undefined : '100%', marginBottom: horizontal ? 0 : 10,
              padding: 4, borderRadius: 6,
              border: active ? `2px solid ${BRAND.blue}` : '2px solid transparent', background: 'transparent',
              cursor: 'pointer', position: 'relative' }}>
            <PdfThumb url={pdfUrl} pageNumber={n} width={thumbWidth} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              color: active ? '#fff' : 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 3 }}>
              <span>{horizontal ? n : `Slide ${n}`}</span>
              {count > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                  <MessageSquare size={11} /> {count}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// A draft's display name. Older drafts auto-labelled "Version N" fall back to
// "Draft N" so the wording is consistent.
function draftLabel(v) {
  return (v.label && !/^Version \d+$/.test(v.label)) ? v.label : ('Draft ' + v.versionNumber);
}

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
 * Frame.io-style storyboard review surface. `data` is the public payload from
 * /api/storyboards/public: a project with one or more storyboards, each with
 * draft PDF versions. Reviewers must enter their name + email before viewing,
 * then comment per-slide (optionally pinned to a spot) and approve.
 */
export function StoryboardRevision({ token, data, api, showMsg, identity = null, embedded = false, initialVersionId = null }) {
  const preIdentified = !!(identity && isEmail(identity.email || ''));
  // Phones get a stacked layout: the desktop three-column split (148px slide
  // rail + slide + 380px thread) leaves the slide a few pixels wide on a 390px
  // screen, so the client sees an empty page.
  const isMobile = useIsMobile();
  // ≥16px inputs stop iOS Safari zooming in when the field takes focus.
  const inputFont = isMobile ? 16 : 13;

  // ── Name + email gate (skipped for a pre-identified portal user) ────────────
  const [name, setName] = useState(() => identity?.name || localStorage.getItem(NAME_KEY) || '');
  const [email, setEmail] = useState(() => identity?.email || localStorage.getItem(EMAIL_KEY) || '');
  const [identified, setIdentified] = useState(() => preIdentified || (!!localStorage.getItem(NAME_KEY) && isEmail(localStorage.getItem(EMAIL_KEY) || '')));
  const [gateName, setGateName] = useState(name);
  const [gateEmail, setGateEmail] = useState(email);

  // A logged-in portal viewer is recorded automatically (no gate to submit).
  useEffect(() => {
    if (preIdentified) api.recordStoryboardViewer(token, { name: identity.name || identity.email, email: identity.email }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function submitGate(e) {
    e.preventDefault();
    const n = gateName.trim();
    const em = gateEmail.trim();
    if (!n || !isEmail(em)) { showMsg('Please enter your name and a valid email'); return; }
    localStorage.setItem(NAME_KEY, n);
    localStorage.setItem(EMAIL_KEY, em);
    setName(n); setEmail(em); setIdentified(true);
    api.recordStoryboardViewer(token, { name: n, email: em }).catch(() => {});
  }

  // ── Storyboard + draft selection ────────────────────────────────────────────
  const storyboards = data.storyboards || [];
  // A per-draft link (…&draft=<versionId>) opens straight on that draft. If the
  // draft isn't visible to this viewer — not submitted yet, or deleted — we fall
  // back to the newest one they can see.
  const deepLink = storyboards
    .map(s => ({ storyboardId: s.id, version: (s.versions || []).find(v => v.id === initialVersionId) }))
    .find(x => x.version) || null;
  const [storyboardId, setStoryboardId] = useState(deepLink?.storyboardId || storyboards[0]?.id || null);
  const activeStoryboard = storyboards.find(s => s.id === storyboardId) || storyboards[0] || null;
  const versions = activeStoryboard?.versions || [];
  const [versionId, setVersionId] = useState(deepLink?.version.id || versions[0]?.id || null);
  const version = versions.find(v => v.id === versionId) || versions[0] || null;

  const [comments, setComments] = useState(data.comments || []);
  const [activeViewers, setActiveViewers] = useState(data.activeViewers || []);
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [pageNumber, setPageNumber] = useState(1);
  const [draftPin, setDraftPin] = useState(null); // { x, y } | null
  const [activeCommentId, setActiveCommentId] = useState(null);

  // Slide count: prefer the stored page_count, fall back to reading the PDF.
  const [resolvedPages, setResolvedPages] = useState(version?.pageCount || 0);
  useEffect(() => {
    let alive = true;
    setResolvedPages(version?.pageCount || 0);
    if (version && !version.pageCount && version.pdfUrl) {
      loadPdf(version.pdfUrl).then(doc => { if (alive) setResolvedPages(doc.numPages); }).catch(() => {});
    }
    return () => { alive = false; };
  }, [version?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const pageCount = resolvedPages || version?.pageCount || 1;

  // Approval is per-storyboard.
  const [approvals, setApprovals] = useState(() =>
    Object.fromEntries((data.storyboards || []).map(s => [s.id, s.approvedAt || null])));
  const approvedAt = activeStoryboard ? approvals[activeStoryboard.id] : null;
  const [approving, setApproving] = useState(false);
  // Per-storyboard "feedback submitted" state (seeded from the server).
  const [submitted, setSubmitted] = useState(() =>
    Object.fromEntries((data.storyboards || []).map(s => [s.id, s.feedbackSubmittedAt || null])));

  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [asset, setAsset] = useState(null);
  const [assetUploading, setAssetUploading] = useState(false);
  const fileRef = useRef(null);
  const composerRef = useRef(null);

  function selectStoryboard(id) {
    setStoryboardId(id);
    const s = storyboards.find(x => x.id === id);
    setVersionId(s?.versions?.[0]?.id || null);
    setPageNumber(1);
    setDraftPin(null);
  }
  function selectVersion(id) {
    setVersionId(id);
    setPageNumber(1);
    setDraftPin(null);
  }
  function goToPage(n) {
    setPageNumber(n);
    setDraftPin(null);
    setActiveCommentId(null);
  }

  // Comments on the current draft + slide.
  const pageComments = useMemo(() => {
    if (!version) return [];
    return comments
      .filter(c => c.versionId === version.id && (c.pageNumber || 1) === pageNumber)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }, [comments, version, pageNumber]);

  // Anchored comments become numbered pins on the slide.
  const pins = useMemo(() => {
    let n = 0;
    return pageComments
      .filter(c => c.anchorX != null && c.anchorY != null)
      .map(c => ({ id: c.id, x: c.anchorX, y: c.anchorY, label: ++n, active: c.id === activeCommentId }));
  }, [pageComments, activeCommentId]);
  const pinNumberByComment = useMemo(() => {
    const m = {}; let n = 0;
    pageComments.forEach(c => { if (c.anchorX != null && c.anchorY != null) m[c.id] = ++n; });
    return m;
  }, [pageComments]);

  function placePin(x, y) {
    setDraftPin({ x, y });
    if (composerRef.current) composerRef.current.focus();
  }

  async function attachFile(file) {
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { showMsg('File too large (max 100 MB)'); return; }
    setAssetUploading(true);
    try {
      const uploaded = await api.uploadStoryboardAsset(token, file);
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
      const created = await api.postStoryboardComment(token, {
        versionId: version.id,
        body: text,
        authorName: name,
        authorEmail: email,
        pageNumber,
        anchorX: draftPin ? draftPin.x : null,
        anchorY: draftPin ? draftPin.y : null,
        attachmentUrl: asset?.url || null,
        attachmentName: asset?.name || null,
        attachmentType: asset?.type || null,
      });
      setComments(prev => [...prev, created]);
      setDraft('');
      setDraftPin(null);
      setAsset(null);
    } catch (err) {
      showMsg(err.message || 'Could not post comment');
    } finally {
      setPosting(false);
    }
  }

  // "Finalise and send revisions" — single client action, mirrors the video
  // viewer. Server-side, approveStoryboard now stamps both approved_at and
  // feedback_submitted_at and fires the team notification.
  async function finalise() {
    if (!activeStoryboard || approvedAt) return;
    const commentCount = (comments || []).filter(c => c.versionId === version?.id).length;
    const single = storyboards.length === 1;
    const what = single ? 'this storyboard' : `"${activeStoryboard.title}"`;
    const msg = commentCount > 0
      ? `Send your ${commentCount} comment${commentCount === 1 ? '' : 's'} to the production team and finalise ${what}? `
        + `No further comments can be added after this.`
      : `You haven't left any comments. Finalise ${what} as approved with no changes? `
        + `No further comments can be added after this.`;
    if (!window.confirm(msg)) return;
    setApproving(true);
    try {
      const res = await api.approveStoryboard(token, activeStoryboard.id, name);
      const at = res.approvedAt || new Date().toISOString();
      setApprovals(prev => ({ ...prev, [activeStoryboard.id]: at }));
      setSubmitted(prev => ({ ...prev, [activeStoryboard.id]: res.feedbackSubmittedAt || new Date().toISOString() }));
      showMsg('Revisions finalised and sent — thank you!');
    } catch (err) {
      showMsg(err.message || 'Could not finalise');
    } finally {
      setApproving(false);
    }
  }

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
      const updated = await api.editStoryboardComment(token, id, text, email);
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
      await api.deleteStoryboardComment(token, c.id, email);
      setComments(prev => prev.filter(x => x.id !== c.id));
      if (editingId === c.id) cancelEdit();
    } catch (err) {
      showMsg(err.message || 'Could not delete comment');
    }
  }

  // Record a view whenever the client lands on / switches to a draft.
  useEffect(() => {
    if (!identified || !version) return;
    api.recordStoryboardView(token, { versionId: version.id, name, email });
  }, [identified, version?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates + presence heartbeat: poll publicView every ~6s once the
  // viewer has identified themselves. Refreshes comments and the
  // activeViewers list (which drives the ConflictBanner). We deliberately
  // don't overwrite the local storyboards/versions arrays.
  useEffect(() => {
    if (!identified || !email) return;
    let alive = true;
    const tick = async () => {
      try {
        const d = await api.pollPublicStoryboard(token, email);
        if (!alive || !d) return;
        if (Array.isArray(d.comments)) setComments(d.comments);
        if (Array.isArray(d.activeViewers)) setActiveViewers(d.activeViewers);
      } catch { /* polling is best-effort */ }
    };
    tick();
    const handle = setInterval(tick, 6000);
    return () => { alive = false; clearInterval(handle); };
  }, [identified, email, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arrow keys step through slides (unless typing in the composer).
  useEffect(() => {
    function onKey(e) {
      const el = document.activeElement;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && pageNumber < pageCount) {
        e.preventDefault(); goToPage(pageNumber + 1);
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowLeft') && pageNumber > 1) {
        e.preventDefault(); goToPage(pageNumber - 1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pageNumber, pageCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Gate screen ─────────────────────────────────────────────────────────────
  if (!identified) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: BRAND.paper, padding: 20 }}>
        <form onSubmit={submitGate} style={{ width: '100%', maxWidth: 380, background: '#fff',
          border: `1px solid ${BRAND.border}`, borderRadius: 12, padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Images size={20} color={BRAND.blue} />
            <strong style={{ fontSize: 16, color: BRAND.ink }}>{data.title}</strong>
          </div>
          <p style={{ color: BRAND.muted, fontSize: 13, margin: '0 0 18px' }}>
            Please enter your details to view and comment on this storyboard.
          </p>
          <label style={{ fontSize: 12, color: BRAND.muted }}>Your name</label>
          <input value={gateName} onChange={e => setGateName(e.target.value)} autoFocus={!isMobile}
            style={{ width: '100%', padding: 9, borderRadius: 8, border: `1px solid ${BRAND.border}`,
              margin: '4px 0 12px', boxSizing: 'border-box', fontSize: isMobile ? 16 : 14 }} />
          <label style={{ fontSize: 12, color: BRAND.muted }}>Your email</label>
          <input value={gateEmail} onChange={e => setGateEmail(e.target.value)} type="email"
            inputMode="email" autoCapitalize="none" autoCorrect="off"
            style={{ width: '100%', padding: 9, borderRadius: 8, border: `1px solid ${BRAND.border}`,
              margin: '4px 0 18px', boxSizing: 'border-box', fontSize: isMobile ? 16 : 14 }} />
          <button type="submit"
            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: 'none',
              background: BRAND.blue, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
            View storyboard
          </button>
        </form>
      </div>
    );
  }

  if (!activeStoryboard || !version) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: BRAND.muted }}>
        <Images size={32} style={{ opacity: 0.4 }} />
        <p>No storyboard has been uploaded for review yet.</p>
      </div>
    );
  }

  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  const railProps = { pages, pageNumber, goToPage, comments, versionId: version.id, pdfUrl: version.pdfUrl };

  return (
    <div style={embedded
      ? { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }
      : { display: 'flex', flexDirection: 'column', height: isMobile ? '100dvh' : '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12,
        padding: isMobile ? '10px 12px' : '12px 18px', flexShrink: 0,
        borderBottom: `1px solid ${BRAND.border}`, background: '#fff', flexWrap: 'wrap' }}>
        <Images size={20} color={BRAND.blue} />
        <strong style={{ color: BRAND.ink, fontSize: isMobile ? 14 : 15, minWidth: 0, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.title}</strong>
        {data.clientName && !isMobile && <span style={{ color: BRAND.muted, fontSize: 13 }}>· {data.clientName}</span>}
        <div style={{ marginLeft: isMobile ? 0 : 'auto', width: isMobile ? '100%' : undefined,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {storyboards.length > 1 && (
            <div title="This project has more than one storyboard — switch between them here"
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px 5px 12px',
                borderRadius: 10, border: `2px solid ${BRAND.blue}`, background: '#EAF6FB',
                width: isMobile ? '100%' : undefined, boxSizing: 'border-box' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: BRAND.blue, whiteSpace: 'nowrap' }}>
                <Images size={14} /> Storyboard {storyboards.findIndex(s => s.id === activeStoryboard.id) + 1} of {storyboards.length}
              </span>
              <select value={storyboardId} onChange={e => selectStoryboard(e.target.value)}
                style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${BRAND.blue}`,
                  fontSize: isMobile ? 16 : 14, flex: isMobile ? 1 : undefined, minWidth: 0,
                  fontWeight: 700, color: BRAND.ink, background: '#fff', cursor: 'pointer' }}>
                {storyboards.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            </div>
          )}
          {versions.length > 1 && (
            <select value={version.id} onChange={e => selectVersion(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${BRAND.border}`,
                fontSize: inputFont, minWidth: 0 }}>
              {versions.map(v => <option key={v.id} value={v.id}>{draftLabel(v)}</option>)}
            </select>
          )}
          {data.callUrl && (
            <a href={data.callUrl} target="_blank" rel="noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: isMobile ? '9px 12px' : '7px 12px', borderRadius: 8,
                border: `1px solid ${BRAND.border}`, background: '#fff', color: BRAND.ink, fontSize: 13,
                fontWeight: 600, textDecoration: 'none' }}>
              <CalendarClock size={15} color={BRAND.blue} /> Schedule Review Call
            </a>
          )}
          {approvedAt ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: isMobile ? '9px 12px' : '7px 12px', borderRadius: 8, flex: isMobile ? 1 : undefined,
              background: '#16A34A', color: '#fff', fontSize: 13, fontWeight: 600 }}>
              <CheckCircle2 size={15} /> Storyboard finalised
            </span>
          ) : (
            <button onClick={finalise} disabled={approving}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: isMobile ? '10px 12px' : '7px 12px', borderRadius: 8, flex: isMobile ? 1 : undefined,
                border: 'none', background: '#16A34A', color: '#fff', fontSize: 13, fontWeight: 600,
                cursor: approving ? 'default' : 'pointer' }}>
              <CheckCircle2 size={15} /> {approving ? 'Sending…' : 'Finalise and send revisions'}
            </button>
          )}
        </div>
      </div>

      <ConflictBanner activeViewers={activeViewers} />

      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', flex: 1, minHeight: 0 }}>
        {/* Slide thumbnail rail — a left column on desktop, a horizontal
            filmstrip under the slide on a phone (a 148px column would eat
            two-fifths of the screen). */}
        {!isMobile && <SlideRail {...railProps} />}

        {/* Current slide + bottom navigator */}
        <div style={{ flex: isMobile ? '0 0 auto' : '1 1 auto', display: 'flex', flexDirection: 'column',
          background: '#0B1B26', minWidth: 0 }}>
          {/* Slide area: grows to fill the pane, slide centred; scrolls if a
              slide is taller than the space. The navigator below stays put. */}
          <div style={{ flex: isMobile ? '0 0 auto' : 1, minHeight: 0,
            maxHeight: isMobile ? '36dvh' : undefined,
            // A tall slide inside a centred flex box can have its top clipped
            // out of scroll reach, so on mobile (where that's likely) the slide
            // sits at the top and scrolls normally.
            overflow: 'auto', display: 'flex', alignItems: isMobile ? 'flex-start' : undefined,
            padding: isMobile ? 10 : 18 }}>
            <div style={{ position: 'relative', maxWidth: 900, width: '100%',
              margin: isMobile ? '0 auto' : 'auto' }}>
              <PdfPage
                url={version.pdfUrl}
                pageNumber={pageNumber}
                pins={pins}
                draftPin={draftPin}
                onPlacePin={approvedAt ? undefined : placePin}
                onPinClick={(id) => setActiveCommentId(id)}
              />
              <div aria-hidden style={{
                position: 'absolute', inset: 0, pointerEvents: 'none',
                backgroundImage: `url("data:image/svg+xml,${DRAFT_SVG}")`,
                backgroundRepeat: 'repeat',
              }} />
            </div>
          </div>

          {/* Navigator pinned to the bottom of the pane (Frame.io-style) so it
              never moves when the slide's aspect ratio changes. */}
          <div style={{ flexShrink: 0, padding: isMobile ? '8px 12px 10px' : '12px 18px 14px',
            borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
              <button onClick={() => goToPage(pageNumber - 1)} disabled={pageNumber <= 1}
                title="Previous slide"
                style={navBtn(pageNumber <= 1, isMobile)}>
                {isMobile ? <ChevronLeft size={20} /> : <ChevronUp size={18} />}
              </button>
              <span style={{ color: '#fff', fontSize: 13, minWidth: 64, textAlign: 'center' }}>
                <strong>{pageNumber}</strong>
                <span style={{ opacity: 0.5 }}> / {pageCount}</span>
              </span>
              <button onClick={() => goToPage(pageNumber + 1)} disabled={pageNumber >= pageCount}
                title="Next slide"
                style={navBtn(pageNumber >= pageCount, isMobile)}>
                {isMobile ? <ChevronRight size={20} /> : <ChevronDown size={18} />}
              </button>
            </div>
            {!approvedAt && (
              <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 8 }}>
                {isMobile ? 'Tap the slide to pin a comment to that spot.'
                  : 'Click anywhere on the slide to pin a comment to that spot.'}
              </div>
            )}
          </div>

          {isMobile && <SlideRail {...railProps} horizontal />}
        </div>

        {/* Comment thread (current slide) */}
        <div style={{ width: isMobile ? '100%' : 380, flex: isMobile ? '1 1 auto' : '0 0 auto',
          minHeight: 0, display: 'flex', flexDirection: 'column',
          borderLeft: isMobile ? undefined : `1px solid ${BRAND.border}`,
          borderTop: isMobile ? `1px solid ${BRAND.border}` : undefined, background: '#fff' }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${BRAND.border}`,
            display: 'flex', alignItems: 'center', gap: 8, color: BRAND.ink, fontWeight: 600, fontSize: 14 }}>
            <MessageSquare size={16} /> Slide {pageNumber} · {pageComments.length} comment{pageComments.length === 1 ? '' : 's'}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
            {pageComments.length === 0 && (
              <p style={{ color: BRAND.muted, fontSize: 13, textAlign: 'center', marginTop: 24 }}>
                No comments on this slide yet. Click the slide to pin a note, or just type below to comment on the whole slide.
              </p>
            )}
            {pageComments.map(c => {
              const pinNo = pinNumberByComment[c.id];
              const active = c.id === activeCommentId;
              const isEditing = editingId === c.id;
              const canManage = c.mine && !approvedAt;
              return (
                <div key={c.id}
                  onClick={() => !isEditing && setActiveCommentId(c.id)}
                  style={{ marginBottom: 14, padding: 8, borderRadius: 8, cursor: isEditing ? 'default' : 'pointer',
                    background: active ? '#EEF7FB' : 'transparent', border: active ? `1px solid ${BRAND.blue}` : '1px solid transparent' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    {pinNo != null ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 18, height: 18, borderRadius: '50%', background: BRAND.blue, color: '#fff',
                        fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{pinNo}</span>
                    ) : (
                      <span title="Whole-slide comment" style={{ display: 'inline-flex', flexShrink: 0 }}>
                        <MessageSquare size={13} color={BRAND.muted} />
                      </span>
                    )}
                    <strong style={{ fontSize: 13, color: BRAND.ink }}>{c.authorName}</strong>
                    {canManage && !isEditing && (
                      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
                        <button onClick={(e) => { e.stopPropagation(); startEdit(c); }} title="Edit"
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                            color: BRAND.muted, padding: 2, display: 'inline-flex' }}>
                          <Pencil size={13} />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); deleteComment(c); }} title="Delete"
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                            color: BRAND.muted, padding: 2, display: 'inline-flex' }}>
                          <Trash2 size={13} />
                        </button>
                      </span>
                    )}
                  </div>
                  {isEditing ? (
                    <div style={{ marginTop: 4 }} onClick={e => e.stopPropagation()}>
                      <textarea
                        value={editingText}
                        onChange={e => setEditingText(e.target.value)}
                        rows={3}
                        autoFocus
                        style={{ width: '100%', resize: 'vertical', padding: 8, borderRadius: 8,
                          border: `1px solid ${BRAND.border}`, fontSize: inputFont, fontFamily: 'inherit', boxSizing: 'border-box' }}
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
              <CheckCircle2 size={16} /> Approved — this storyboard is finalised.
            </div>
          ) : (
            <div style={{ borderTop: `1px solid ${BRAND.border}`, padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12 }}>
                {draftPin ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#B45309',
                    background: '#FEF3C7', borderRadius: 999, padding: '3px 10px', fontWeight: 600 }}>
                    <MapPin size={13} /> Pinned to slide {pageNumber}
                    <button onClick={() => setDraftPin(null)} title="Remove pin"
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#B45309', padding: 0, display: 'flex' }}>
                      <X size={13} />
                    </button>
                  </span>
                ) : (
                  <span style={{ color: BRAND.muted }}>Commenting on slide {pageNumber}</span>
                )}
              </div>
              <textarea
                ref={composerRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                placeholder="Leave your comment here…"
                rows={isMobile ? 2 : 3}
                style={{ width: '100%', resize: 'none', padding: 8, borderRadius: 8,
                  border: `1px solid ${BRAND.border}`, fontSize: inputFont, fontFamily: 'inherit', boxSizing: 'border-box' }}
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
                  title="Attach a file (e.g. a replacement image)"
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
