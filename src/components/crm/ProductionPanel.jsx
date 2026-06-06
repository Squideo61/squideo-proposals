import React, { useState } from 'react';
import { Clapperboard, Film, Plus, Trash2, Send, Coins, ExternalLink, ChevronRight } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { STAGE_LABEL } from '../../lib/productionStages.js';
import { VideoProgressBar } from './ProductionProgressBar.jsx';

// The project's videos + pre-paid credit balance. Each video moves through the
// board independently and is edited on its own page (onOpenVideo); this panel
// is the project-level container — add videos, manage credits, jump in.
export function ProductionPanel({ dealId, deal, videos, isMobile, onOpenVideo }) {
  const { actions, showMsg } = useStore();
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <PanelHeader />
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
          {videos.map(v => <VideoRow key={v.id} dealId={dealId} video={v} onOpen={() => onOpenVideo && onOpenVideo(v.id)} />)}
        </div>
      )}
    </div>
  );
}

function PanelHeader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Clapperboard size={18} color={BRAND.blue} />
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Videos</h2>
    </div>
  );
}

function VideoRow({ dealId, video, onOpen }) {
  const { actions, showMsg } = useStore();
  const [busy, setBusy] = useState(false);
  const stageLabel = video.productionPhase ? (STAGE_LABEL[video.productionPhase]?.[video.productionStage] || video.productionStage) : null;

  const sendForReview = () => {
    setBusy(true);
    actions.sendVideoForReview(dealId, video.id)
      .then((resp) => {
        if (resp?.reviewUrl) navigator.clipboard?.writeText(resp.reviewUrl).catch(() => {});
        showMsg(video.revisionVideoId ? 'Review link copied' : 'Sent for review — link copied');
      })
      .catch(e => showMsg(e.message || 'Could not send for review'))
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Film size={15} color={BRAND.muted} />
        <button onClick={onOpen}
          style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            fontSize: 13, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {video.title}
        </button>

        {stageLabel && (
          <span style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap' }}>{stageLabel}</span>
        )}
        <button onClick={sendForReview} disabled={busy} className="btn-ghost" title="Create / copy the client review link">
          {video.revisionVideoId ? <ExternalLink size={13} /> : <Send size={13} />}
        </button>
        <button onClick={onOpen} className="btn-icon" title="Open video"><ChevronRight size={14} /></button>
        <button
          onClick={() => { if (window.confirm(`Delete "${video.title}"?`)) actions.deleteProjectVideo(dealId, video.id); }}
          className="btn-icon" title="Delete video"
        ><Trash2 size={13} /></button>
      </div>

      {/* At-a-glance production progress for this video (read-only here; open the
          video to move it through the stages). */}
      <VideoProgressBar
        phaseId={video.productionPhase}
        stageId={video.productionStage}
        revisionRound={video.revisionRound}
      />
    </div>
  );
}
