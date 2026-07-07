import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Images, Copy, MessageSquare, Plus, Trash2, Upload, FileText, FileDown, CheckCircle2, ChevronDown, ChevronRight, ChevronLeft, MapPin, BarChart3, Link2, Check, Flag } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile, formatRelativeTime } from '../../utils.js';
import { Modal } from '../ui.jsx';
import { PdfThumb } from '../storyboard/PdfThumb.jsx';
import { PdfPage } from '../storyboard/PdfPage.jsx';
import { RevisionAnalyticsModal } from '../RevisionAnalyticsModal.jsx';
import { DealLinkSummary, AssigneeSelect, CommentDone, CommentFlag, InternalNote, VideoLinkBanner } from './RevisionsView.jsx';

const APPROVED_CHIP = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px',
  borderRadius: 999, background: '#16A34A', color: '#fff', fontSize: 11, fontWeight: 700 };

const PUBLIC_BASE = 'https://app.squideo.com';

// A draft's display name. Older drafts auto-labelled "Version N" fall back to
// "Draft N" so the wording is consistent.
function draftLabel(v) {
  return (v.label && !/^Version \d+$/.test(v.label)) ? v.label : ('Draft ' + v.versionNumber);
}

function CommentAttachment({ url, name, type }) {
  if ((type || '').startsWith('image/')) {
    return (
      <a href={url} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 4 }}>
        <img src={url} alt={name || 'attachment'}
          style={{ maxWidth: 220, maxHeight: 140, borderRadius: 6, border: '1px solid ' + BRAND.border, display: 'block' }} />
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" download
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 4, padding: '5px 9px',
        borderRadius: 6, border: '1px solid ' + BRAND.border, background: '#F8FAFC', color: BRAND.ink,
        fontSize: 12, textDecoration: 'none' }}>
      <FileDown size={13} color={BRAND.blue} />
      {name || 'Download file'}
    </a>
  );
}

export function StoryboardsView({ onBack, projectId, onOpenProject, onCloseProject }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [creating, setCreating] = useState(false);
  const [analyticsProject, setAnalyticsProject] = useState(null);

  const [loaded, setLoaded] = useState(false);

  // The selected project lives in the route (activeId), so navigating here from
  // the header — which clears activeId — always returns to the list. Reload the
  // list whenever we're showing it (initial mount and after backing out).
  useEffect(() => {
    if (projectId) return;
    actions.loadStoryboards().finally(() => setLoaded(true));
    actions.refreshDeals?.();
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (projectId) {
    return <ProjectDetail projectId={projectId} onBack={onCloseProject} />;
  }

  const projects = state.storyboards || [];

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {onBack && <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>}
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Images size={22} color={BRAND.blue} /> Storyboard Revisions
          </h1>
        </div>
        <button onClick={() => setCreating(true)} className="btn"><Plus size={16} /> New project</button>
      </header>

      {projects.length === 0 ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>
          {loaded
            ? 'No storyboard projects yet. Create one, upload a draft PDF, and share the link with your client.'
            : 'Loading projects…'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {projects.map(p => (
            <div key={p.id} style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16,
              display: 'flex', alignItems: 'center', gap: 14 }}>
              <FileText size={20} color={BRAND.blue} />
              <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => onOpenProject(p.id)}>
                <div style={{ fontWeight: 600, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {p.title}
                  {(p.storyboardCount || 0) > 0 && (p.approvedStoryboardCount || 0) === (p.storyboardCount || 0) &&
                    <span style={APPROVED_CHIP}><CheckCircle2 size={11} /> All approved</span>}
                  {p.dealTitle && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: BRAND.blue, background: '#EFF6FF', borderRadius: 999, padding: '1px 8px' }}>
                      <Link2 size={11} /> {p.dealTitle}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>
                  {p.clientName ? p.clientName + ' · ' : ''}
                  {p.storyboardCount || 0} storyboard{p.storyboardCount === 1 ? '' : 's'}
                  {' · '}{p.approvedStoryboardCount || 0} approved
                  {' · '}{p.feedbackSubmittedCount || 0} feedback sent
                  {' · '}{p.commentCount || 0} comment{p.commentCount === 1 ? '' : 's'}
                  {' · '}{p.viewerCount || 0} viewer{p.viewerCount === 1 ? '' : 's'}
                  {' · '}{p.viewCount || 0} view{p.viewCount === 1 ? '' : 's'}
                </div>
              </div>
              <button onClick={() => setAnalyticsProject(p)} className="btn-ghost" title="Engagement analytics"><BarChart3 size={14} /> Analytics</button>
              <CopyLinkButton token={p.shareToken} showMsg={showMsg} />
              <button onClick={() => onOpenProject(p.id)} className="btn-ghost">Open</button>
              <button
                onClick={() => { if (window.confirm('Delete this project and all its storyboards?')) actions.deleteStoryboardProject(p.id); }}
                className="btn-ghost" title="Delete project"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreated={(proj) => { setCreating(false); onOpenProject(proj.id); }}
        />
      )}

      {analyticsProject && (
        <RevisionAnalyticsModal project={analyticsProject} kind="storyboard" onClose={() => setAnalyticsProject(null)} />
      )}
    </div>
  );
}

function CopyLinkButton({ token, showMsg }) {
  const url = PUBLIC_BASE + '/?storyboard=' + token;
  return (
    <button
      onClick={() => navigator.clipboard.writeText(url).then(() => showMsg('Storyboard link copied')).catch(() => {})}
      className="btn-ghost" title={url}><Copy size={14} /> Copy link</button>
  );
}

function NewProjectModal({ onClose, onCreated }) {
  const { actions, showMsg } = useStore();
  const [title, setTitle] = useState('');
  const [clientName, setClientName] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const proj = await actions.createStoryboardProject({ title: title.trim(), clientName: clientName.trim() || null });
      onCreated(proj);
    } catch (err) {
      showMsg(err.message || 'Could not create project');
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2 style={{ fontSize: 18, margin: '0 0 16px', color: BRAND.ink }}>New storyboard project</h2>
      <label style={{ fontSize: 13, color: BRAND.muted }}>Project title</label>
      <input value={title} onChange={e => setTitle(e.target.value)} autoFocus
        placeholder="e.g. Emma Vines - Relationship & Loved Ones"
        style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid ' + BRAND.border, margin: '4px 0 14px', boxSizing: 'border-box' }} />
      <label style={{ fontSize: 13, color: BRAND.muted }}>Client name (optional)</label>
      <input value={clientName} onChange={e => setClientName(e.target.value)}
        style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid ' + BRAND.border, margin: '4px 0 18px', boxSizing: 'border-box' }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={save} disabled={saving || !title.trim()} className="btn">{saving ? 'Creating…' : 'Create'}</button>
      </div>
    </Modal>
  );
}

function ProjectDetail({ projectId, onBack }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [activeStoryboardId, setActiveStoryboardId] = useState(null);

  // Load now, then poll so client comments/views appear live while open.
  useEffect(() => {
    actions.loadStoryboardDetail(projectId);
    const tick = () => { if (document.visibilityState === 'visible') actions.loadStoryboardDetail(projectId); };
    const iv = setInterval(tick, 10000);
    window.addEventListener('focus', tick);
    return () => { clearInterval(iv); window.removeEventListener('focus', tick); };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const detail = state.storyboardDetail[projectId];

  async function addStoryboard() {
    const title = (window.prompt('Name this storyboard (e.g. "Hero film", "Cutdown 30s"):') || '').trim();
    if (!title) return;
    try {
      const sb = await actions.createStoryboard(projectId, title);
      if (sb?.id) setActiveStoryboardId(sb.id);
    } catch (err) { showMsg(err.message || 'Could not add storyboard'); }
  }

  if (!detail) {
    return <div style={{ padding: 32, color: BRAND.muted }}>Loading…</div>;
  }

  const storyboards = detail.storyboards || [];
  const activeStoryboard = storyboards.find(s => s.id === activeStoryboardId) || storyboards[0] || null;
  const commentsByVersion = (detail.comments || []).reduce((m, c) => {
    (m[c.versionId] = m[c.versionId] || []).push(c);
    return m;
  }, {});
  const viewers = detail.viewers || [];

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>{detail.title}</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <AssigneeSelect value={detail.assigneeEmail} users={state.users}
            onChange={(email) => actions.assignStoryboardProject(projectId, email)} />
          <DealLinkSummary dealId={detail.dealId} dealTitle={detail.dealTitle}
            projectId={projectId} kind="storyboard"
            onLinked={() => actions.loadStoryboardDetail(projectId)} />
          <button onClick={addStoryboard} className="btn-ghost"><Plus size={14} /> Add storyboard</button>
          <CopyLinkButton token={detail.shareToken} showMsg={showMsg} />
        </div>
      </header>

      {viewers.length > 0 && (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 4 }}>Viewers ({viewers.length})</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {viewers.map(v => (
              <span key={v.email} style={{ fontSize: 12, color: BRAND.ink, background: '#F1F5F9', borderRadius: 999, padding: '2px 10px' }}>
                {v.name} · {v.email}
              </span>
            ))}
          </div>
        </div>
      )}

      {storyboards.length === 0 ? (
        <div style={{ color: BRAND.muted, textAlign: 'center', padding: 24 }}>
          No storyboards yet. Click “Add storyboard”, then upload draft PDFs into it.
        </div>
      ) : (
        <>
          {storyboards.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <FileText size={16} color={BRAND.blue} />
              <select value={activeStoryboard.id} onChange={e => setActiveStoryboardId(e.target.value)}
                style={{ flex: 1, padding: '9px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border,
                  fontSize: 14, fontWeight: 600, color: BRAND.ink, background: 'white' }}>
                {storyboards.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} — {(s.versions || []).length} draft{(s.versions || []).length === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 12, color: BRAND.muted, whiteSpace: 'nowrap' }}>
                {storyboards.findIndex(s => s.id === activeStoryboard.id) + 1} / {storyboards.length}
              </span>
            </div>
          )}
          <StoryboardCard key={activeStoryboard.id} projectId={projectId} storyboard={activeStoryboard} commentsByVersion={commentsByVersion} />
        </>
      )}
    </div>
  );
}

// One storyboard within a project: its own upload dropzone + list of draft PDFs.
function StoryboardCard({ projectId, storyboard, commentsByVersion }) {
  const { actions, showMsg } = useStore();
  const fileInputRef = useRef(null);
  const [progress, setProgress] = useState(null);
  const latestId = (storyboard.versions || [])[0]?.id;
  const [overrides, setOverrides] = useState({}); // versionId -> explicit open/closed
  const isDraftOpen = (id) => (id in overrides ? overrides[id] : id === latestId);
  const toggle = (id) => setOverrides(prev => ({ ...prev, [id]: !isDraftOpen(id) }));

  async function handleFile(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { showMsg('Please choose a PDF file'); return; }
    setProgress(0);
    try {
      await actions.uploadStoryboardVersion(projectId, storyboard.id, file, { onProgress: setProgress });
      showMsg('Draft uploaded');
    } catch (err) {
      showMsg(err.message || 'Upload failed');
    } finally {
      setProgress(null);
    }
  }

  const versions = storyboard.versions || [];

  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 16, marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <FileText size={18} color={BRAND.blue} />
        <strong style={{ color: BRAND.ink, fontSize: 16 }}>{storyboard.title}</strong>
        {storyboard.approvedAt
          ? <span style={APPROVED_CHIP}><CheckCircle2 size={11} /> Approved</span>
          : <span style={{ ...APPROVED_CHIP, background: '#F59E0B' }}>Pending review</span>}
        <span style={{ fontSize: 12, color: BRAND.muted }}>{versions.length} draft{versions.length === 1 ? '' : 's'}</span>
        <button
          onClick={() => { if (window.confirm(`Delete "${storyboard.title}" and all its drafts?`)) actions.deleteStoryboard(projectId, storyboard.id); }}
          className="btn-ghost" style={{ marginLeft: 'auto' }} title="Delete storyboard"><Trash2 size={14} /></button>
      </div>

      <VideoLinkBanner linked={storyboard.linkedProjectVideo} />

      {/* Upload a new draft PDF for this storyboard */}
      <div
        onClick={() => progress == null && fileInputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); if (progress == null) handleFile(e.dataTransfer.files?.[0]); }}
        style={{ border: `2px dashed ${BRAND.border}`, borderRadius: 10, padding: 16, textAlign: 'center',
          color: BRAND.muted, cursor: progress == null ? 'pointer' : 'default', marginBottom: 14, fontSize: 13 }}>
        <input ref={fileInputRef} type="file" accept="application/pdf" style={{ display: 'none' }}
          onChange={e => handleFile(e.target.files?.[0])} />
        {progress == null ? (
          <><Upload size={16} /> <span style={{ marginLeft: 6 }}>Drop a new draft PDF here, or click to upload</span></>
        ) : (
          <div>
            <div style={{ marginBottom: 8 }}>Uploading… {progress}%</div>
            <div style={{ height: 6, background: BRAND.border, borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: progress + '%', height: '100%', background: BRAND.blue, transition: 'width .2s' }} />
            </div>
          </div>
        )}
      </div>

      {versions.length === 0 ? (
        <div style={{ color: BRAND.muted, textAlign: 'center', padding: 12, fontSize: 13 }}>No drafts uploaded yet.</div>
      ) : versions.map(v => {
        const comments = (commentsByVersion[v.id] || []).slice().sort((a, b) => {
          const ap = a.pageNumber || 1, bp = b.pageNumber || 1;
          if (ap !== bp) return ap - bp;
          return new Date(a.createdAt) - new Date(b.createdAt);
        });
        const isOpen = isDraftOpen(v.id);
        const doneCount = comments.filter(c => c.completedAt).length;
        const flaggedCount = comments.filter(c => c.producerNote).length;
        return (
          <div key={v.id} style={{ borderTop: '1px solid ' + BRAND.border, paddingTop: 12, marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: isOpen ? 8 : 0 }}>
              <button onClick={() => toggle(v.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none',
                  cursor: 'pointer', padding: 0, flex: 1, textAlign: 'left', flexWrap: 'wrap' }}>
                {isOpen ? <ChevronDown size={16} color={BRAND.muted} /> : <ChevronRight size={16} color={BRAND.muted} />}
                <strong style={{ color: BRAND.ink, fontSize: 14 }}>{draftLabel(v)}</strong>
                {v.pageCount != null && <span style={{ fontSize: 12, color: BRAND.muted }}>{v.pageCount} slide{v.pageCount === 1 ? '' : 's'}</span>}
                <span style={{ fontSize: 12, color: BRAND.muted, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <MessageSquare size={13} /> {comments.length}
                </span>
                {doneCount > 0 && (
                  <span title={`${doneCount} marked done`} style={{ fontSize: 12, color: '#16A34A', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}>
                    <Check size={13} /> {doneCount}
                  </span>
                )}
                {flaggedCount > 0 && (
                  <span title={`${flaggedCount} flagged`} style={{ fontSize: 12, color: '#B45309', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}>
                    <Flag size={13} /> {flaggedCount}
                  </span>
                )}
              </button>
              <a href={v.pdfUrl} target="_blank" rel="noreferrer" className="btn-ghost" title="Open PDF"><FileDown size={14} /></a>
              <button
                onClick={() => { if (window.confirm('Delete this draft?')) actions.deleteStoryboardVersion(projectId, v.id); }}
                className="btn-ghost" title="Delete draft"><Trash2 size={14} /></button>
            </div>
            {isOpen && (
              <>
                {(v.views && v.views.length > 0) && (
                  <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 8 }}>
                    Viewed by{' '}
                    {v.views.map((vw, i) => (
                      <span key={vw.email}>
                        {i > 0 ? ', ' : ''}
                        <strong style={{ color: BRAND.ink, fontWeight: 600 }}>{vw.name || vw.email}</strong>
                        {' '}({formatRelativeTime(vw.lastViewedAt)}{vw.viewCount > 1 ? `, ${vw.viewCount}×` : ''})
                      </span>
                    ))}
                  </div>
                )}
                <DraftComments projectId={projectId} version={v} comments={comments} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Comments for one draft, grouped by slide. Slides with anchored comments show
// the rendered slide with read-only numbered pins so the producer sees exactly
// where each note points.
function DraftComments({ projectId, version, comments }) {
  const { actions } = useStore();
  // Which comment the prev/next navigator is currently focused on (index into
  // the flat, slide-ordered `comments` list). -1 = none focused yet.
  const [navIndex, setNavIndex] = useState(-1);
  const itemRefs = useRef({});

  // Keep the focus valid as comments come/go (poll refreshes the list).
  useEffect(() => {
    if (navIndex >= comments.length) setNavIndex(comments.length ? comments.length - 1 : -1);
  }, [comments.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function goToComment(idx) {
    if (!comments.length) return;
    const clamped = (idx + comments.length) % comments.length; // wrap around
    setNavIndex(clamped);
    const el = itemRefs.current[comments[clamped].id];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  if (comments.length === 0) {
    return (
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <PdfThumb url={version.pdfUrl} pageNumber={1} width={140} />
        <div style={{ color: BRAND.muted, fontSize: 13, paddingTop: 8 }}>No comments on this draft yet.</div>
      </div>
    );
  }

  const doneCount = comments.filter(c => c.completedAt).length;
  const flaggedCount = comments.filter(c => c.producerNote).length;

  // Group by slide, preserving slide order.
  const byPage = comments.reduce((m, c) => {
    const p = c.pageNumber || 1;
    (m[p] = m[p] || []).push(c);
    return m;
  }, {});
  const pageNumbers = Object.keys(byPage).map(Number).sort((a, b) => a - b);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Comment summary + next/previous navigator */}
      <div style={{ position: 'sticky', top: 0, zIndex: 2, display: 'flex', alignItems: 'center',
        gap: 10, flexWrap: 'wrap', padding: '8px 12px', background: '#F8FAFC',
        border: '1px solid ' + BRAND.border, borderRadius: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 5 }}>
          <MessageSquare size={14} color={BRAND.blue} /> {comments.length} comment{comments.length === 1 ? '' : 's'}
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#16A34A', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Check size={13} /> {doneCount} done
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#B45309', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Flag size={13} /> {flaggedCount} flagged
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={() => goToComment(navIndex < 0 ? comments.length - 1 : navIndex - 1)}
            className="btn-ghost" title="Previous comment"
            style={{ padding: '4px 8px' }}><ChevronLeft size={14} /></button>
          <span style={{ fontSize: 12, color: BRAND.muted, minWidth: 44, textAlign: 'center' }}>
            {navIndex < 0 ? '–' : navIndex + 1} / {comments.length}
          </span>
          <button onClick={() => goToComment(navIndex < 0 ? 0 : navIndex + 1)}
            className="btn-ghost" title="Next comment"
            style={{ padding: '4px 8px' }}><ChevronRight size={14} /></button>
        </div>
      </div>
      {pageNumbers.map(p => {
        const list = byPage[p];
        let pinNo = 0;
        const pins = list.filter(c => c.anchorX != null && c.anchorY != null)
          .map(c => ({ id: c.id, x: c.anchorX, y: c.anchorY, label: ++pinNo }));
        const pinNumberByComment = {};
        let k = 0;
        list.forEach(c => { if (c.anchorX != null && c.anchorY != null) pinNumberByComment[c.id] = ++k; });
        return (
          <div key={p} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ width: 320, maxWidth: '100%', flexShrink: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.ink, marginBottom: 6 }}>Slide {p}</div>
              <PdfPage url={version.pdfUrl} pageNumber={p} pins={pins} />
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              {list.map(c => {
                const no = pinNumberByComment[c.id];
                const focused = navIndex >= 0 && comments[navIndex]?.id === c.id;
                return (
                  <div key={c.id} ref={el => { itemRefs.current[c.id] = el; }}
                    style={{ marginBottom: 12, opacity: c.completedAt ? 0.55 : 1,
                      borderRadius: 8, padding: focused ? '8px 10px' : 0,
                      margin: focused ? '0 -10px 12px' : '0 0 12px',
                      background: focused ? '#EEF7FB' : 'transparent',
                      boxShadow: focused ? `0 0 0 1px ${BRAND.blue}` : 'none',
                      transition: 'background .2s' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {no != null ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 18, height: 18, borderRadius: '50%', background: BRAND.blue, color: '#fff',
                          fontSize: 10, fontWeight: 700 }}>{no}</span>
                      ) : (
                        <MapPin size={13} color={BRAND.muted} style={{ opacity: 0.4 }} />
                      )}
                      <strong style={{ fontSize: 13, color: BRAND.ink }}>{c.authorName}</strong>
                      <span style={{ fontSize: 11, color: BRAND.muted }}>{formatRelativeTime(c.createdAt)}</span>
                      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <CommentFlag note={c.producerNote}
                          onSave={(note) => actions.setStoryboardCommentNote(projectId, c.id, note)} />
                        <CommentDone
                          done={!!c.completedAt}
                          title={c.completedAt
                            ? `Done ${formatRelativeTime(c.completedAt)}${c.completedBy ? ' by ' + c.completedBy : ''} — click to reopen`
                            : 'Mark this revision done'}
                          onClick={() => actions.completeStoryboardComment(projectId, c.id, !c.completedAt)}
                        />
                      </span>
                    </div>
                    {c.body && <div style={{ fontSize: 13, color: BRAND.ink, whiteSpace: 'pre-wrap', marginTop: 2, textDecoration: c.completedAt ? 'line-through' : 'none' }}>{c.body}</div>}
                    {c.attachmentUrl && <CommentAttachment url={c.attachmentUrl} name={c.attachmentName} type={c.attachmentType} />}
                    <InternalNote note={c.producerNote} />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
