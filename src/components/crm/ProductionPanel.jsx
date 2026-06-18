import React, { useState } from 'react';
import { Clapperboard, Film, Plus, Trash2, Send, Coins, ExternalLink, ChevronRight, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { STAGE_LABEL } from '../../lib/productionStages.js';
import { VideoProgressBar } from './ProductionProgressBar.jsx';
import { Modal } from '../ui.jsx';

// The project's videos + pre-paid credit balance. Each video moves through the
// board independently and is edited on its own page (onOpenVideo); this panel
// is the project-level container — add videos, manage credits, jump in.
export function ProductionPanel({ dealId, deal, videos, isMobile, onOpenVideo }) {
  const { actions, showMsg } = useStore();
  const inProduction = !!deal.productionPhase;
  const credits = deal.productionCredits || 0;
  const [addOpen, setAddOpen] = useState(false);

  const container = {
    background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12,
    padding: isMobile ? 16 : 24, marginBottom: 16,
  };

  if (!inProduction) {
    // A deal only becomes a project once someone marks it "Good to go" (the
    // button at the top of the page) — that's the single gate now, and it
    // notifies the project managers. Payment alone no longer enters production,
    // so there's no ungated "Add to production" shortcut here.
    return (
      <div style={container}>
        <PanelHeader />
        <div style={{ fontSize: 13, color: BRAND.muted, marginTop: 12 }}>
          This deal isn’t in production yet. Once it’s sold, use <strong>Good to go</strong> at the top of
          the page to move it into Projects (one video in Pre-Production) and alert the project managers.
        </div>
      </div>
    );
  }

  // Add one-or-many videos at once: the modal collects a list of names, then we
  // create them in order so they land on the board in the order they were typed.
  const createVideos = async (titles) => {
    for (const t of titles) {
      // eslint-disable-next-line no-await-in-loop
      await actions.addProjectVideo(dealId, t || null);
    }
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
        <button className="btn" onClick={() => setAddOpen(true)}><Plus size={14} /> Add video</button>
      </div>

      {addOpen && (
        <AddVideosModal
          onClose={() => setAddOpen(false)}
          onCreate={createVideos}
          showMsg={showMsg}
        />
      )}

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

// Name one or many videos before creating them. Starts on a single "Video 1"
// row; "Add another" appends "Video N" (editable). All rows are created in order
// when you hit the button.
function AddVideosModal({ onClose, onCreate, showMsg }) {
  const [names, setNames] = useState(['Video 1']);
  const [saving, setSaving] = useState(false);

  const setAt = (i, val) => setNames(arr => arr.map((n, idx) => (idx === i ? val : n)));
  const addRow = () => setNames(arr => [...arr, `Video ${arr.length + 1}`]);
  const removeRow = (i) => setNames(arr => (arr.length <= 1 ? arr : arr.filter((_, idx) => idx !== i)));

  const submit = async () => {
    if (saving) return;
    const titles = names.map(n => n.trim());
    setSaving(true);
    try {
      await onCreate(titles);
      onClose();
    } catch (e) {
      showMsg(e.message || 'Could not add video');
      setSaving(false);
    }
  };

  const count = names.length;
  return (
    <Modal onClose={saving ? undefined : onClose} maxWidth={460}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700 }}>Add {count === 1 ? 'a video' : `${count} videos`}</h2>
      <div style={{ fontSize: 13, color: BRAND.muted, marginBottom: 16 }}>
        Name each video (e.g. “Hero film”, “Cutdown 30s”). You can add as many as you like.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {names.map((name, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Film size={16} color={BRAND.muted} style={{ flexShrink: 0 }} />
            <input
              autoFocus={i === names.length - 1}
              value={name}
              onChange={e => setAt(i, e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
              placeholder={`Video ${i + 1}`}
              disabled={saving}
              style={{
                flex: 1, padding: '8px 10px', fontSize: 14,
                border: '1px solid ' + BRAND.border, borderRadius: 8,
              }}
            />
            <button
              type="button"
              onClick={() => removeRow(i)}
              disabled={saving || names.length <= 1}
              aria-label="Remove video"
              title="Remove"
              style={{
                flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 30, height: 30, borderRadius: 8, border: '1px solid ' + BRAND.border,
                background: 'white', color: BRAND.muted,
                cursor: names.length <= 1 ? 'default' : 'pointer',
                opacity: names.length <= 1 ? 0.4 : 1,
              }}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="btn-ghost"
        onClick={addRow}
        disabled={saving}
        style={{ marginTop: 10 }}
      >
        <Plus size={14} /> Add video
      </button>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="btn" onClick={submit} disabled={saving}>
          {saving ? 'Adding…' : `Add ${count === 1 ? 'video' : `${count} videos`}`}
        </button>
      </div>
    </Modal>
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
