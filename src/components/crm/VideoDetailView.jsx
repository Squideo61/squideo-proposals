import React, { useEffect, useState } from 'react';
import { ArrowLeft, Film, FolderOpen, Send, ExternalLink, Trash2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import {
  PRODUCTION_PHASES, PHASE_BY_ID, VIDEO_STATUSES, VIDEO_STATUS_BY_ID, PAYMENT_TERMS,
} from '../../lib/productionStages.js';
import { DealConversation } from './DealConversation.jsx';

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
          <div>
            <label style={labelStyle}>Producer</label>
            <select style={ctrl} value={video.producerEmail || ''} onChange={(e) => update({ producerEmail: e.target.value || null })}>
              <option value="">— Unassigned —</option>
              {Object.entries(state.users || {}).map(([email, u]) => <option key={email} value={email}>{u.name || email}</option>)}
            </select>
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

      {video.dealId && <DealConversation dealId={video.dealId} isMobile={isMobile} />}
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
