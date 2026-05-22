import React, { useMemo, useState } from 'react';
import { Clapperboard, Film, Plus, Trash2, Send, Coins, ExternalLink, Edit2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import {
  PRODUCTION_PHASES, PHASE_BY_ID, VIDEO_STATUSES, VIDEO_STATUS_BY_ID, PAYMENT_TERMS,
} from '../../lib/productionStages.js';

const ctrl = {
  width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border,
  fontSize: 13, color: BRAND.ink, background: 'white', boxSizing: 'border-box',
};
const labelStyle = { fontSize: 12, color: BRAND.muted, marginBottom: 4, display: 'block' };

// The deal page's "Project" panel: the Monday-style production controls plus
// the project's videos and pre-paid credit balance. Shown once a deal has
// entered production (paid → auto-entered, or via "Add to production").
export function ProductionPanel({ dealId, deal, videos, isMobile }) {
  const { state, actions, showMsg } = useStore();
  const memberOptions = useMemo(() => Object.entries(state.users || {})
    .map(([email, u]) => ({ email, name: u.name || email }))
    .sort((a, b) => a.name.localeCompare(b.name)), [state.users]);

  const inProduction = !!deal.productionPhase;
  const credits = deal.productionCredits || 0;

  const container = {
    background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12,
    padding: isMobile ? 16 : 24, marginBottom: 16,
  };

  if (!inProduction) {
    return (
      <div style={container}>
        <PanelHeader />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
          <span style={{ fontSize: 13, color: BRAND.muted }}>
            This deal isn’t in production yet. Adding it creates a project with one video in Pre-Production.
          </span>
          <button className="btn" onClick={() => actions.enterProduction(dealId).then(() => showMsg('Added to production'))}>
            <Plus size={14} /> Add to production
          </button>
        </div>
      </div>
    );
  }

  const phase = PHASE_BY_ID[deal.productionPhase] || PRODUCTION_PHASES[0];

  const onPhaseChange = (newPhaseId) => {
    const target = PHASE_BY_ID[newPhaseId];
    if (!target) return;
    actions.moveProjectStage(dealId, newPhaseId, target.stages[0]?.id);
  };
  const onStageChange = (newStageId) => actions.moveProjectStage(dealId, phase.id, newStageId);
  const patch = (fields) => actions.updateProjectProduction(dealId, fields);

  const addVideo = () => {
    const title = (window.prompt('Name this video (e.g. "Hero film", "Cutdown 30s"):') || '').trim();
    if (title === '' && !window.confirm('Add a video with a default name?')) return;
    actions.addProjectVideo(dealId, title || null).catch(e => showMsg(e.message || 'Could not add video'));
  };
  const addCredits = () => {
    const raw = window.prompt('How many credits to add?', '1');
    if (raw == null) return;
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n) || n === 0) { showMsg('Enter a whole number'); return; }
    actions.addProjectCredits(dealId, n).then(() => showMsg(n > 0 ? `Added ${n} credit${n === 1 ? '' : 's'}` : 'Credits updated'));
  };
  const useCredit = () => {
    const title = (window.prompt('Name the video to create from a credit:') || '').trim();
    actions.useProjectCredit(dealId, title || null)
      .then(() => showMsg('Credit used — video added'))
      .catch(e => showMsg(e.message || 'No credits available'));
  };

  return (
    <div style={container}>
      <PanelHeader phaseColor={phase.color} />

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 14, marginTop: 16 }}>
        <div>
          <label style={labelStyle}>Phase</label>
          <select style={ctrl} value={phase.id} onChange={(e) => onPhaseChange(e.target.value)}>
            {PRODUCTION_PHASES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Stage</label>
          <select style={ctrl} value={deal.productionStage || phase.stages[0]?.id} onChange={(e) => onStageChange(e.target.value)}>
            {phase.stages.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Producer</label>
          <select style={ctrl} value={deal.producerEmail || ''} onChange={(e) => patch({ producerEmail: e.target.value || null })}>
            <option value="">— Unassigned —</option>
            {memberOptions.map(m => <option key={m.email} value={m.email}>{m.name}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Payment</label>
          <select style={ctrl} value={deal.paymentTerms || ''} onChange={(e) => patch({ paymentTerms: e.target.value || null })}>
            <option value="">—</option>
            {PAYMENT_TERMS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Delivery deadline</label>
          <input type="date" style={ctrl} value={(deal.deliveryDeadline || '').slice(0, 10)}
            onChange={(e) => patch({ deliveryDeadline: e.target.value || null })} />
        </div>
        <div>
          <label style={labelStyle}>Text-direction deadline</label>
          <input type="date" style={ctrl} value={(deal.textDirectionDeadline || '').slice(0, 10)}
            onChange={(e) => patch({ textDirectionDeadline: e.target.value || null })} />
        </div>
      </div>

      {/* Videos */}
      <div style={{ marginTop: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Film size={16} color={BRAND.blue} /> Videos
            <span style={{ fontSize: 13, color: BRAND.muted, fontWeight: 500 }}>· {videos.length}</span>
          </h3>
          <div style={{ flex: 1 }} />
          {credits > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#92400E', background: '#FEF3C7', borderRadius: 999, padding: '3px 10px' }}>
              <Coins size={12} /> {credits} credit{credits === 1 ? '' : 's'}
            </span>
          )}
          {credits > 0 && <button className="btn-ghost" onClick={useCredit}>Use a credit</button>}
          <button className="btn-ghost" onClick={addCredits}><Coins size={14} /> Add credits</button>
          <button className="btn" onClick={addVideo}><Plus size={14} /> Add video</button>
        </div>

        {videos.length === 0 ? (
          <div style={{ color: BRAND.muted, fontSize: 13, fontStyle: 'italic', padding: '8px 0' }}>
            No videos yet. Add one, or pre-pay credits to use later.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {videos.map(v => <VideoRow key={v.id} dealId={dealId} video={v} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function PanelHeader({ phaseColor }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Clapperboard size={18} color={phaseColor || BRAND.blue} />
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Project / Production</h2>
    </div>
  );
}

function VideoRow({ dealId, video }) {
  const { actions, showMsg } = useStore();
  const [busy, setBusy] = useState(false);
  const status = VIDEO_STATUS_BY_ID[video.status] || VIDEO_STATUSES[0];

  const rename = () => {
    const next = (window.prompt('Rename video:', video.title) || '').trim();
    if (!next || next === video.title) return;
    actions.updateProjectVideo(dealId, video.id, { title: next });
  };
  const sendForReview = () => {
    setBusy(true);
    actions.sendVideoForReview(dealId, video.id)
      .then((resp) => {
        const url = resp?.reviewUrl;
        if (url) navigator.clipboard?.writeText(url).catch(() => {});
        showMsg(video.revisionVideoId ? 'Review link copied' : 'Sent for review — link copied');
      })
      .catch(e => showMsg(e.message || 'Could not send for review'))
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 8 }}>
      <Film size={15} color={BRAND.muted} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {video.title}
      </span>
      <button onClick={rename} className="btn-icon" title="Rename"><Edit2 size={13} /></button>

      <select
        value={video.status}
        onChange={(e) => actions.updateProjectVideo(dealId, video.id, { status: e.target.value })}
        title="Video status"
        style={{ padding: '5px 8px', borderRadius: 999, border: '1px solid ' + BRAND.border, fontSize: 12, fontWeight: 600, color: status.color, background: 'white' }}
      >
        {VIDEO_STATUSES.map(s => <option key={s.id} value={s.id} style={{ color: BRAND.ink }}>{s.label}</option>)}
      </select>

      <button onClick={sendForReview} disabled={busy} className="btn-ghost" title="Create / copy the client review link">
        {video.revisionVideoId ? <><ExternalLink size={13} /> Review link</> : <><Send size={13} /> Send for review</>}
      </button>
      <button
        onClick={() => { if (window.confirm(`Delete "${video.title}"?`)) actions.deleteProjectVideo(dealId, video.id); }}
        className="btn-icon" title="Delete video"
      ><Trash2 size={13} /></button>
    </div>
  );
}
