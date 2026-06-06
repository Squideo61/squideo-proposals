import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Clapperboard, Copy, MessageSquare, Plus, Trash2, Upload, Film, FileDown, CheckCircle2, CalendarClock, ChevronDown, ChevronRight, BarChart3, Eye, Send, Link2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile, formatRelativeTime } from '../../utils.js';
import { permissionsInclude } from '../../lib/permissions.js';
import { Modal } from '../ui.jsx';
import { RevisionAnalyticsModal } from '../RevisionAnalyticsModal.jsx';

// Compact <select> linking a project to a CRM deal (its team gets the client
// feedback notifications). Mirrors the deal picker in TaskFormModal.
export function DealLinkSelect({ projectId, value, kind = 'revision', onLinked }) {
  const { state, actions, showMsg } = useStore();
  const deals = Object.values(state.deals || {}).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const link = kind === 'storyboard' ? actions.linkStoryboardDeal : actions.linkRevisionDeal;
  const change = async (e) => {
    const id = e.target.value || null;
    try {
      await link(projectId, id);
      onLinked && onLinked(id);
      showMsg(id ? 'Linked to deal' : 'Unlinked from deal');
    } catch (err) {
      showMsg(err.message || 'Could not update deal link');
    }
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Link2 size={14} color={BRAND.muted} />
      <select
        value={value || ''}
        onChange={change}
        title="Link this project to a CRM deal so its team gets feedback alerts"
        style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border, fontSize: 13, background: 'white', maxWidth: 260 }}
      >
        <option value="">Not linked to a deal</option>
        {deals.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
      </select>
    </span>
  );
}

const APPROVED_CHIP = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px',
  borderRadius: 999, background: '#16A34A', color: '#fff', fontSize: 11, fontWeight: 700 };

const PUBLIC_BASE = 'https://app.squideo.com';

function tc(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60), r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// A draft's display name. Older versions were auto-labelled "Version N"; treat
// those (and empty labels) as "Draft N" so the wording is consistent.
function draftLabel(v) {
  return (v.label && !/^Version \d+$/.test(v.label)) ? v.label : ('Draft ' + v.versionNumber);
}

// A comment's supporting asset: inline thumbnail for images, download chip otherwise.
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

export function RevisionsView({ onBack }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [analyticsProject, setAnalyticsProject] = useState(null);

  const [loaded, setLoaded] = useState(false);

  // Deals power the link picker on each project.
  useEffect(() => {
    actions.loadRevisions().finally(() => setLoaded(true));
    actions.refreshDeals?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (selectedId) {
    return <ProjectDetail projectId={selectedId} onBack={() => { setSelectedId(null); actions.loadRevisions(); }} />;
  }

  const projects = state.revisions || [];

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {onBack && <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>}
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clapperboard size={22} color={BRAND.blue} /> Video Revisions
          </h1>
        </div>
        <button onClick={() => setCreating(true)} className="btn"><Plus size={16} /> New project</button>
      </header>

      {permissionsInclude(state.session?.permissions, 'settings.manage') && <BookingLinkEditor />}

      {projects.length === 0 ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>
          {loaded
            ? 'No revision projects yet. Create one, upload a draft video, and share the link with your client.'
            : 'Loading projects…'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {projects.map(p => (
            <div key={p.id} style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16,
              display: 'flex', alignItems: 'center', gap: 14 }}>
              <Film size={20} color={BRAND.blue} />
              <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setSelectedId(p.id)}>
                <div style={{ fontWeight: 600, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {p.title}
                  {(p.videoCount || 0) > 0 && (p.approvedVideoCount || 0) === (p.videoCount || 0) &&
                    <span style={APPROVED_CHIP}><CheckCircle2 size={11} /> All approved</span>}
                  {p.dealTitle && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: BRAND.blue, background: '#EFF6FF', borderRadius: 999, padding: '1px 8px' }}>
                      <Link2 size={11} /> {p.dealTitle}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>
                  {p.clientName ? p.clientName + ' · ' : ''}
                  {p.videoCount || 0} video{p.videoCount === 1 ? '' : 's'}
                  {' · '}{p.approvedVideoCount || 0} approved
                  {' · '}{p.feedbackSubmittedCount || 0} feedback sent
                  {' · '}{p.commentCount || 0} comment{p.commentCount === 1 ? '' : 's'}
                  {' · '}{p.viewerCount || 0} viewer{p.viewerCount === 1 ? '' : 's'}
                  {' · '}{p.viewCount || 0} view{p.viewCount === 1 ? '' : 's'}
                </div>
              </div>
              <button onClick={() => setAnalyticsProject(p)} className="btn-ghost" title="Engagement analytics"><BarChart3 size={14} /> Analytics</button>
              <CopyLinkButton token={p.shareToken} showMsg={showMsg} />
              <button onClick={() => setSelectedId(p.id)} className="btn-ghost">Open</button>
              <button
                onClick={() => { if (window.confirm('Delete this project and all its videos?')) actions.deleteRevisionProject(p.id); }}
                className="btn-ghost" title="Delete project"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreated={(proj) => { setCreating(false); setSelectedId(proj.id); }}
        />
      )}

      {analyticsProject && (
        <RevisionAnalyticsModal project={analyticsProject} kind="revision" onClose={() => setAnalyticsProject(null)} />
      )}
    </div>
  );
}

function CopyLinkButton({ token, showMsg }) {
  const url = PUBLIC_BASE + '/?revision=' + token;
  return (
    <button
      onClick={() => navigator.clipboard.writeText(url).then(() => showMsg('Revision link copied')).catch(() => {})}
      className="btn-ghost" title={url}><Copy size={14} /> Copy link</button>
  );
}

// Team-wide booking link for the client "Schedule Review Call" button. Only
// rendered for users who can manage workspace settings.
function BookingLinkEditor() {
  const { state, actions, showMsg } = useStore();
  const [url, setUrl] = useState(state.revisionCallUrl || '');
  const [saving, setSaving] = useState(false);
  const dirty = url !== (state.revisionCallUrl || '');

  const save = async () => {
    setSaving(true);
    try { await actions.saveRevisionCallUrl(url.trim()); showMsg('Booking link saved'); }
    catch (e) { showMsg(e.message || 'Could not save'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, padding: '10px 14px',
      background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, flexWrap: 'wrap' }}>
      <CalendarClock size={16} color={BRAND.blue} />
      <label style={{ fontSize: 13, color: BRAND.muted }}>Review-call booking link</label>
      <input value={url} onChange={e => setUrl(e.target.value)}
        placeholder="https://calendly.com/your-team/review-call"
        style={{ flex: 1, minWidth: 220, padding: 8, borderRadius: 8, border: '1px solid ' + BRAND.border, fontSize: 13 }} />
      <button onClick={save} disabled={!dirty || saving} className="btn">{saving ? 'Saving…' : 'Save'}</button>
    </div>
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
      const proj = await actions.createRevisionProject({ title: title.trim(), clientName: clientName.trim() || null });
      onCreated(proj);
    } catch (err) {
      showMsg(err.message || 'Could not create project');
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2 style={{ fontSize: 18, margin: '0 0 16px', color: BRAND.ink }}>New revision project</h2>
      <label style={{ fontSize: 13, color: BRAND.muted }}>Project title</label>
      <input value={title} onChange={e => setTitle(e.target.value)} autoFocus
        placeholder="e.g. UN WCMC video 2"
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
  const [activeVideoId, setActiveVideoId] = useState(null);

  useEffect(() => { actions.loadRevisionDetail(projectId); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const detail = state.revisionDetail[projectId];

  async function addVideo() {
    const title = (window.prompt('Name this video (e.g. "Hero film", "Cutdown 30s"):') || '').trim();
    if (!title) return;
    try {
      const video = await actions.createRevisionVideo(projectId, title);
      if (video?.id) setActiveVideoId(video.id);
    } catch (err) { showMsg(err.message || 'Could not add video'); }
  }

  if (!detail) {
    return <div style={{ padding: 32, color: BRAND.muted }}>Loading…</div>;
  }

  const videos = detail.videos || [];
  const activeVideo = videos.find(v => v.id === activeVideoId) || videos[0] || null;
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
          <DealLinkSelect projectId={projectId} value={detail.dealId} kind="revision"
            onLinked={() => actions.loadRevisionDetail(projectId)} />
          <button onClick={addVideo} className="btn-ghost"><Plus size={14} /> Add video</button>
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

      {videos.length === 0 ? (
        <div style={{ color: BRAND.muted, textAlign: 'center', padding: 24 }}>
          No videos yet. Click “Add video”, then upload drafts into it.
        </div>
      ) : (
        <>
          {videos.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <Film size={16} color={BRAND.blue} />
              <select value={activeVideo.id} onChange={e => setActiveVideoId(e.target.value)}
                style={{ flex: 1, padding: '9px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border,
                  fontSize: 14, fontWeight: 600, color: BRAND.ink, background: 'white' }}>
                {videos.map((v, i) => (
                  <option key={v.id} value={v.id}>
                    {v.title} — {(v.versions || []).length} draft{(v.versions || []).length === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 12, color: BRAND.muted, whiteSpace: 'nowrap' }}>
                {videos.findIndex(v => v.id === activeVideo.id) + 1} / {videos.length}
              </span>
            </div>
          )}
          <VideoCard key={activeVideo.id} projectId={projectId} video={activeVideo} commentsByVersion={commentsByVersion} />
        </>
      )}
    </div>
  );
}

// One video within a project: its own upload dropzone + list of drafts.
function VideoCard({ projectId, video, commentsByVersion }) {
  const { actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const fileInputRef = useRef(null);
  const [progress, setProgress] = useState(null);
  // Latest draft is open by default (recomputed each render, so a freshly
  // uploaded draft auto-expands); older ones collapse. Manual toggles override.
  const latestId = (video.versions || [])[0]?.id;
  const [overrides, setOverrides] = useState({}); // versionId -> explicit open/closed
  const isDraftOpen = (id) => (id in overrides ? overrides[id] : id === latestId);
  const toggle = (id) => setOverrides(prev => ({ ...prev, [id]: !isDraftOpen(id) }));

  async function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith('video/')) { showMsg('Please choose a video file'); return; }
    setProgress(0);
    try {
      await actions.uploadRevisionVersion(projectId, video.id, file, { onProgress: setProgress });
      showMsg('Draft uploaded');
    } catch (err) {
      showMsg(err.message || 'Upload failed');
    } finally {
      setProgress(null);
    }
  }

  const versions = video.versions || [];

  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 16, marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Film size={18} color={BRAND.blue} />
        <strong style={{ color: BRAND.ink, fontSize: 16 }}>{video.title}</strong>
        {video.approvedAt
          ? <span style={APPROVED_CHIP}><CheckCircle2 size={11} /> Approved</span>
          : <span style={{ ...APPROVED_CHIP, background: '#F59E0B' }}>Pending review</span>}
        <span style={{ fontSize: 12, color: BRAND.muted }}>{versions.length} draft{versions.length === 1 ? '' : 's'}</span>
        <button
          onClick={() => { if (window.confirm(`Delete "${video.title}" and all its drafts?`)) actions.deleteRevisionVideo(projectId, video.id); }}
          className="btn-ghost" style={{ marginLeft: 'auto' }} title="Delete video"><Trash2 size={14} /></button>
      </div>

      {/* Upload a new draft for this video */}
      <div
        onClick={() => progress == null && fileInputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); if (progress == null) handleFile(e.dataTransfer.files?.[0]); }}
        style={{ border: `2px dashed ${BRAND.border}`, borderRadius: 10, padding: 16, textAlign: 'center',
          color: BRAND.muted, cursor: progress == null ? 'pointer' : 'default', marginBottom: 14, fontSize: 13 }}>
        <input ref={fileInputRef} type="file" accept="video/*" style={{ display: 'none' }}
          onChange={e => handleFile(e.target.files?.[0])} />
        {progress == null ? (
          <><Upload size={16} /> <span style={{ marginLeft: 6 }}>Drop a new draft here, or click to upload</span></>
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
          const at = a.timecodeSeconds, bt = b.timecodeSeconds;
          if (at == null && bt == null) return new Date(a.createdAt) - new Date(b.createdAt);
          if (at == null) return 1; if (bt == null) return -1; return at - bt;
        });
        const isOpen = isDraftOpen(v.id);
        return (
          <div key={v.id} style={{ borderTop: '1px solid ' + BRAND.border, paddingTop: 12, marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: isOpen ? 8 : 0 }}>
              <button onClick={() => toggle(v.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none',
                  cursor: 'pointer', padding: 0, flex: 1, textAlign: 'left' }}>
                {isOpen ? <ChevronDown size={16} color={BRAND.muted} /> : <ChevronRight size={16} color={BRAND.muted} />}
                <strong style={{ color: BRAND.ink, fontSize: 14 }}>{draftLabel(v)}</strong>
                <span style={{ fontSize: 12, color: BRAND.muted, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <MessageSquare size={13} /> {comments.length}
                </span>
              </button>
              <button
                onClick={() => { if (window.confirm('Delete this draft?')) actions.deleteRevisionVersion(projectId, v.id); }}
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
                {/* Video on the left, comments on the right (stacks on mobile).
                    Fullscreen is available via the native player controls. */}
                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 14, alignItems: 'flex-start' }}>
                  <div style={{ flex: isMobile ? '1 1 auto' : '1 1 62%', minWidth: 0, width: '100%' }}>
                    <video src={v.videoUrl} controls style={{ display: 'block', width: '100%', maxHeight: '60vh', borderRadius: 8, background: '#000' }} />
                  </div>
                  <div style={{ flex: isMobile ? '1 1 auto' : '1 1 38%', minWidth: 0, width: '100%', maxHeight: isMobile ? undefined : '60vh', overflowY: 'auto' }}>
                    {comments.length === 0 ? (
                      <div style={{ fontSize: 13, color: BRAND.muted, padding: '4px 2px' }}>No comments yet.</div>
                    ) : comments.map(c => (
                      <div key={c.id} style={{ marginBottom: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <strong style={{ fontSize: 13, color: BRAND.ink }}>{c.authorName}</strong>
                          {c.timecodeSeconds != null && (
                            <span style={{ color: BRAND.blue, fontSize: 12, fontWeight: 700 }}>{tc(c.timecodeSeconds)}</span>
                          )}
                        </div>
                        {c.body && <div style={{ fontSize: 13, color: BRAND.ink, whiteSpace: 'pre-wrap' }}>{c.body}</div>}
                        {c.attachmentUrl && <CommentAttachment url={c.attachmentUrl} name={c.attachmentName} type={c.attachmentType} />}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
