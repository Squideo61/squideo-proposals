import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Clapperboard, Copy, MessageSquare, Plus, Trash2, Upload, Film } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { Modal } from '../ui.jsx';

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

export function RevisionsView({ onBack }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => { actions.loadRevisions(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (selectedId) {
    return <ProjectDetail projectId={selectedId} onBack={() => { setSelectedId(null); actions.loadRevisions(); }} />;
  }

  const projects = state.revisions || [];

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clapperboard size={22} color={BRAND.blue} /> Video Revisions
          </h1>
        </div>
        <button onClick={() => setCreating(true)} className="btn"><Plus size={16} /> New project</button>
      </header>

      {projects.length === 0 ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>
          No revision projects yet. Create one, upload a draft video, and share the link with your client.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {projects.map(p => (
            <div key={p.id} style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16,
              display: 'flex', alignItems: 'center', gap: 14 }}>
              <Film size={20} color={BRAND.blue} />
              <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setSelectedId(p.id)}>
                <div style={{ fontWeight: 600, color: BRAND.ink }}>{p.title}</div>
                <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>
                  {p.clientName ? p.clientName + ' · ' : ''}
                  {p.versionCount || 0} version{p.versionCount === 1 ? '' : 's'} · {p.commentCount || 0} comment{p.commentCount === 1 ? '' : 's'}
                </div>
              </div>
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
  const fileInputRef = useRef(null);
  const [progress, setProgress] = useState(null); // 0–100 while uploading

  useEffect(() => { actions.loadRevisionDetail(projectId); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const detail = state.revisionDetail[projectId];

  async function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith('video/')) { showMsg('Please choose a video file'); return; }
    setProgress(0);
    try {
      await actions.uploadRevisionVersion(projectId, file, { onProgress: setProgress });
      showMsg('Draft uploaded');
    } catch (err) {
      showMsg(err.message || 'Upload failed');
    } finally {
      setProgress(null);
    }
  }

  if (!detail) {
    return <div style={{ maxWidth: 900, margin: '0 auto', padding: 32, color: BRAND.muted }}>Loading…</div>;
  }

  const versions = detail.versions || [];
  const commentsByVersion = (detail.comments || []).reduce((m, c) => {
    (m[c.versionId] = m[c.versionId] || []).push(c);
    return m;
  }, {});

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>{detail.title}</h1>
        </div>
        <CopyLinkButton token={detail.shareToken} showMsg={showMsg} />
      </header>

      {/* Upload */}
      <div
        onClick={() => progress == null && fileInputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); if (progress == null) handleFile(e.dataTransfer.files?.[0]); }}
        style={{ border: `2px dashed ${BRAND.border}`, borderRadius: 10, padding: 24, textAlign: 'center',
          color: BRAND.muted, cursor: progress == null ? 'pointer' : 'default', marginBottom: 20, background: 'white' }}>
        <input ref={fileInputRef} type="file" accept="video/*" style={{ display: 'none' }}
          onChange={e => handleFile(e.target.files?.[0])} />
        {progress == null ? (
          <><Upload size={18} /> <div style={{ marginTop: 6 }}>Drop a draft video here, or click to upload a new version</div></>
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
        <div style={{ color: BRAND.muted, textAlign: 'center', padding: 24 }}>No versions uploaded yet.</div>
      ) : versions.map(v => {
        const comments = (commentsByVersion[v.id] || []).slice().sort((a, b) => {
          const at = a.timecodeSeconds, bt = b.timecodeSeconds;
          if (at == null && bt == null) return new Date(a.createdAt) - new Date(b.createdAt);
          if (at == null) return 1; if (bt == null) return -1; return at - bt;
        });
        return (
          <div key={v.id} style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16, marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <Film size={18} color={BRAND.blue} />
              <strong style={{ color: BRAND.ink }}>{draftLabel(v)}</strong>
              <span style={{ fontSize: 12, color: BRAND.muted, display: 'flex', alignItems: 'center', gap: 4 }}>
                <MessageSquare size={13} /> {comments.length}
              </span>
              <button
                onClick={() => { if (window.confirm('Delete this version?')) actions.deleteRevisionVersion(projectId, v.id); }}
                className="btn-ghost" style={{ marginLeft: 'auto' }} title="Delete version"><Trash2 size={14} /></button>
            </div>
            <video src={v.videoUrl} controls style={{ width: '100%', maxHeight: 360, borderRadius: 8, background: '#000' }} />
            {comments.length > 0 && (
              <div style={{ marginTop: 12, borderTop: '1px solid ' + BRAND.border, paddingTop: 12 }}>
                {comments.map(c => (
                  <div key={c.id} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <strong style={{ fontSize: 13, color: BRAND.ink }}>{c.authorName}</strong>
                      {c.timecodeSeconds != null && (
                        <span style={{ color: BRAND.blue, fontSize: 12, fontWeight: 700 }}>{tc(c.timecodeSeconds)}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, color: BRAND.ink, whiteSpace: 'pre-wrap' }}>{c.body}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
