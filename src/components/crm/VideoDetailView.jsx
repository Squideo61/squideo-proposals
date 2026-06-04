import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Film, FolderOpen, Send, ExternalLink, Trash2, FileText, Upload, CheckCircle2, Circle, ListChecks } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import {
  PRODUCTION_PHASES, PHASE_BY_ID, VIDEO_STATUSES, VIDEO_STATUS_BY_ID, PAYMENT_TERMS,
  VIDEO_MILESTONES, STAGE_LABEL,
} from '../../lib/productionStages.js';
import { DealConversation } from './DealConversation.jsx';
import { AssigneePicker } from './TaskFormModal.jsx';

const sectionCard = {
  background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 20, marginTop: 18,
};
const approvedChip = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px',
  borderRadius: 999, background: '#16A34A', color: '#fff', fontSize: 11, fontWeight: 700,
};

const ctrl = {
  width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border,
  fontSize: 13, color: BRAND.ink, background: 'white', boxSizing: 'border-box',
};
const labelStyle = { fontSize: 12, color: BRAND.muted, marginBottom: 4, display: 'block' };

// A single video's page: its board position (phase + stage), its Monday-style
// columns, status, and the client review hand-off. Opened from the production
// board and from the project page.
export function VideoDetailView({ videoId, onBack, onOpenProject, onOpenDeal }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();

  useEffect(() => { if (videoId) actions.loadVideo(videoId); }, [videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  const video = state.videoDetail?.[videoId];

  if (!video) {
    return (
      <div style={{ padding: 32 }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
        <p style={{ marginTop: 24, color: BRAND.muted }}>Loading video…</p>
      </div>
    );
  }

  const phase = PHASE_BY_ID[video.productionPhase] || PRODUCTION_PHASES[0];
  const status = VIDEO_STATUS_BY_ID[video.status] || VIDEO_STATUSES[0];
  const update = (fields) => actions.updateVideo(videoId, fields).catch(() => {});

  const onPhaseChange = (newPhaseId) => {
    const target = PHASE_BY_ID[newPhaseId];
    if (target) actions.moveVideoStage(videoId, newPhaseId, target.stages[0]?.id);
  };
  const onStageChange = (newStageId) => actions.moveVideoStage(videoId, phase.id, newStageId);

  const sendForReview = () => {
    actions.sendVideoForReview(video.dealId, videoId)
      .then((resp) => {
        if (resp?.reviewUrl) navigator.clipboard?.writeText(resp.reviewUrl).catch(() => {});
        showMsg(video.revisionVideoId ? 'Review link copied' : 'Sent for review — link copied');
      })
      .catch(e => showMsg(e.message || 'Could not send for review'));
  };
  const remove = () => {
    if (!window.confirm(`Delete "${video.title}"? This removes the video from its project.`)) return;
    actions.deleteProjectVideo(video.dealId, videoId).then(() => onBack());
  };

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Production</button>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {onOpenProject && video.dealId && (
            <button onClick={() => onOpenProject(video.dealId)} className="btn-ghost"><FolderOpen size={14} /> Open project</button>
          )}
          {onOpenDeal && video.dealId && (
            <button onClick={() => onOpenDeal(video.dealId)} className="btn-ghost"><ExternalLink size={14} /> Go to deal</button>
          )}
          <button onClick={sendForReview} className="btn-ghost">
            {video.revisionVideoId ? <><ExternalLink size={14} /> Review link</> : <><Send size={14} /> Send for review</>}
          </button>
          <button onClick={remove} className="btn-ghost is-danger"><Trash2 size={14} /> Delete</button>
        </div>
      </header>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 16 : 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Film size={18} color={phase.color} />
          <InlineText
            value={video.title}
            onSave={(v) => update({ title: v || video.title })}
            style={{ ...ctrl, fontSize: 20, fontWeight: 700, border: '1px solid transparent', padding: '4px 6px' }}
          />
        </div>
        {(video.projectTitle || video.companyName) && (
          <button onClick={() => onOpenProject && video.dealId && onOpenProject(video.dealId)}
            style={{ background: 'none', border: 'none', padding: '0 6px 0 32px', cursor: onOpenProject ? 'pointer' : 'default', color: BRAND.muted, fontSize: 13, marginBottom: 16 }}>
            {[video.projectTitle, video.companyName].filter(Boolean).join(' · ')}
          </button>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 14, marginTop: 12 }}>
          <div>
            <label style={labelStyle}>Phase</label>
            <select style={ctrl} value={phase.id} onChange={(e) => onPhaseChange(e.target.value)}>
              {PRODUCTION_PHASES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Stage</label>
            <select style={ctrl} value={video.productionStage || phase.stages[0]?.id} onChange={(e) => onStageChange(e.target.value)}>
              {phase.stages.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Status</label>
            <select style={{ ...ctrl, color: status.color, fontWeight: 600 }} value={video.status} onChange={(e) => update({ status: e.target.value })}>
              {VIDEO_STATUSES.map(s => <option key={s.id} value={s.id} style={{ color: BRAND.ink }}>{s.label}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Producers</label>
            <AssigneePicker
              users={Object.entries(state.users || {}).map(([email, u]) => ({ email, ...u }))}
              selected={video.producerEmails || (video.producerEmail ? [video.producerEmail] : [])}
              onToggle={(email) => {
                const set = new Set(video.producerEmails || (video.producerEmail ? [video.producerEmail] : []));
                set.has(email) ? set.delete(email) : set.add(email);
                update({ producerEmails: Array.from(set) });
              }}
              emptyLabel="No producers assigned"
            />
          </div>
          <div>
            <label style={labelStyle}>Payment</label>
            <select style={ctrl} value={video.paymentTerms || ''} onChange={(e) => update({ paymentTerms: e.target.value || null })}>
              <option value="">—</option>
              {PAYMENT_TERMS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Video length</label>
            <InlineText value={video.videoLength} placeholder="e.g. 90s, 1.5m, 606w" onSave={(v) => update({ videoLength: v })} />
          </div>
          <div>
            <label style={labelStyle}>Delivery deadline</label>
            <input type="date" style={ctrl} value={(video.deliveryDeadline || '').slice(0, 10)}
              onChange={(e) => update({ deliveryDeadline: e.target.value || null })} />
          </div>
          <div>
            <label style={labelStyle}>Text-direction deadline</label>
            <input type="date" style={ctrl} value={(video.textDirectionDeadline || '').slice(0, 10)}
              onChange={(e) => update({ textDirectionDeadline: e.target.value || null })} />
          </div>
        </div>
      </div>

      <ScriptCard video={video} videoId={videoId} />
      <MilestonesCard video={video} videoId={videoId} />

      {video.dealId && <DealConversation dealId={video.dealId} isMobile={isMobile} />}
    </div>
  );
}

// Resolve an actor email to a display name from the loaded users.
function useUserName() {
  const { state } = useStore();
  return (email) => (email && state.users?.[email]?.name) || email || 'Someone';
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return ''; }
}

// Script section: a copywriter uploads a script; producers view + approve it.
// Approving is the "Script" milestone (advances the card to Scripts Completed).
function ScriptCard({ video, videoId }) {
  const { actions, showMsg } = useStore();
  const userName = useUserName();
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  const script = video.script || null;
  const approved = (video.milestones || []).find(m => m.id === 'script') || null;

  async function handleFile(file) {
    if (!file) return;
    setUploading(true);
    try { await actions.uploadVideoScript(videoId, file); showMsg(script ? 'Script replaced' : 'Script uploaded'); }
    catch (e) { showMsg(e.message || 'Upload failed'); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  }
  async function approve() {
    setBusy(true);
    try { await actions.approveVideoMilestone(videoId, 'script', true); showMsg('Script approved — card moved to Scripts Completed'); }
    catch { /* showMsg handled in action */ }
    finally { setBusy(false); }
  }

  return (
    <div style={sectionCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <FileText size={18} color={BRAND.blue} />
        <strong style={{ fontSize: 16, color: BRAND.ink }}>Script</strong>
        {approved && <span style={approvedChip}><CheckCircle2 size={11} /> Approved</span>}
      </div>

      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={e => handleFile(e.target.files?.[0])} />

      {!script ? (
        <div
          onClick={() => !uploading && fileRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); if (!uploading) handleFile(e.dataTransfer.files?.[0]); }}
          style={{ border: `2px dashed ${BRAND.border}`, borderRadius: 10, padding: 22, textAlign: 'center',
            color: BRAND.muted, cursor: uploading ? 'default' : 'pointer', fontSize: 13 }}>
          <Upload size={16} /> <span style={{ marginLeft: 6 }}>
            {uploading ? 'Uploading…' : 'Drop the script here, or click to upload (PDF, DOC, etc.)'}
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <FileText size={20} color={BRAND.muted} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {script.filename}
            </div>
            <div style={{ fontSize: 12, color: BRAND.muted }}>
              Uploaded by {userName(script.uploadedBy)} · {fmtDate(script.createdAt)}
            </div>
          </div>
          {script.url && (
            <a href={script.url} target="_blank" rel="noreferrer" className="btn-ghost"><ExternalLink size={14} /> View</a>
          )}
          <button onClick={() => fileRef.current?.click()} disabled={uploading} className="btn-ghost">
            <Upload size={14} /> {uploading ? 'Uploading…' : 'Replace'}
          </button>
          {approved ? (
            <span style={{ fontSize: 12, color: '#16A34A', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <CheckCircle2 size={14} /> Approved by {userName(approved.approvedBy)} · {fmtDate(approved.approvedAt)}
            </span>
          ) : (
            <button onClick={approve} disabled={busy} className="btn">
              <CheckCircle2 size={14} /> {busy ? 'Approving…' : 'Approve script'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Milestones: Script → Visual Direction → Storyboard → Video. Approving each
// advances the card forward on the board.
function MilestonesCard({ video, videoId }) {
  const { actions } = useStore();
  const userName = useUserName();
  const [busy, setBusy] = useState(null);
  const approvedMap = Object.fromEntries((video.milestones || []).map(m => [m.id, m]));

  async function toggle(id, approved) {
    setBusy(id);
    try { await actions.approveVideoMilestone(videoId, id, approved); }
    catch { /* showMsg handled in action */ }
    finally { setBusy(null); }
  }

  return (
    <div style={sectionCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <ListChecks size={18} color={BRAND.blue} />
        <strong style={{ fontSize: 16, color: BRAND.ink }}>Milestones</strong>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {VIDEO_MILESTONES.map((m, i) => {
          const a = approvedMap[m.id];
          const stageLabel = STAGE_LABEL[m.phase]?.[m.stage] || m.stage;
          // The Script milestone is driven by an uploaded + approved script.
          const needsScript = m.id === 'script' && !video.script;
          return (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0',
              borderTop: i === 0 ? 'none' : '1px solid ' + BRAND.border, flexWrap: 'wrap' }}>
              {a ? <CheckCircle2 size={18} color="#16A34A" /> : <Circle size={18} color={BRAND.muted} style={{ opacity: 0.5 }} />}
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontWeight: 600, color: BRAND.ink }}>{m.label}</div>
                <div style={{ fontSize: 12, color: BRAND.muted }}>→ moves to {stageLabel}</div>
              </div>
              {a ? (
                <>
                  <span style={{ fontSize: 12, color: '#16A34A', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <CheckCircle2 size={13} /> Approved by {userName(a.approvedBy)} · {fmtDate(a.approvedAt)}
                  </span>
                  <button onClick={() => toggle(m.id, false)} disabled={busy === m.id} className="btn-ghost" title="Un-approve">
                    Undo
                  </button>
                </>
              ) : (
                <button onClick={() => toggle(m.id, true)} disabled={busy === m.id || needsScript} className="btn"
                  title={needsScript ? 'Upload a script first' : undefined}>
                  {busy === m.id ? 'Approving…' : 'Approve'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Text input that only saves on blur / Enter, re-syncing when the value reloads.
function InlineText({ value, placeholder, onSave, style }) {
  const [draft, setDraft] = useState(value || '');
  useEffect(() => { setDraft(value || ''); }, [value]);
  const commit = () => { const v = draft.trim() || null; if (v !== (value || null)) onSave(v); };
  return (
    <input
      type="text" style={style || ctrl} value={draft} placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}
