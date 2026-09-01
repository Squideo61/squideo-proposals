import React, { useState } from 'react';
import { Clapperboard, Film, Plus, Trash2, Send, Coins, ExternalLink, ChevronRight, X, Mic, Wallet, Play } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { STAGE_LABEL } from '../../lib/productionStages.js';
import { VideoProgressBar } from './ProductionProgressBar.jsx';
import { Modal, RefBadge } from '../ui.jsx';
import { videoReference } from '../../lib/reference.js';
import { fmtMins } from './ClientCreditCard.jsx';

// The project's videos + the credit behind them. Each video moves through the
// board independently and is edited on its own page (onOpenVideo); this panel
// is the project-level container — add videos, assign credit, jump in.
//
// Two different pots can pay for a video, and the panel keeps them distinct:
//  · the deal's own credit project (creditProject) — a pool bought FOR this
//    project, drawn down per video through the Credit Based Projects card.
//  · the customer's company-wide video credit (companyCredit) — bought in their
//    portal, spendable on any of their projects. Assigning it here RESERVES the
//    minutes against a named video; they're drawn down when it's signed off.
//
// A video with no board position is "planned": named and (usually) paid for out
// of credit, but not started. That's how credit gets pre-assigned to work that
// hasn't begun — including on a deal that hasn't been marked Good to go.
export function ProductionPanel({ dealId, deal, videos, creditProject, companyCredit, hideCredits = false, isMobile, onOpenVideo }) {
  const { actions, showMsg } = useStore();
  const inProduction = !!deal.productionPhase;
  // Credit-based deals draw each video from the Credit Based Project pool; the
  // panel's own legacy counter is only used when there's no credit project.
  const creditMode = !!creditProject;
  const remaining = creditProject ? creditProject.remaining : 0;
  const credits = deal.productionCredits || 0;
  const clientCredit = hideCredits ? null : companyCredit || null;
  const clientAvailable = clientCredit ? (clientCredit.available ?? clientCredit.remaining ?? 0) : 0;
  // A customer can hold several separate credit balances (Newcastle University
  // runs one per NHS study). Everything that spends credit has to say which.
  const creditPools = clientCredit?.pools || [];
  const [addOpen, setAddOpen] = useState(false);
  const [addPlanned, setAddPlanned] = useState(false);

  const container = {
    background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12,
    padding: isMobile ? 16 : 24, marginBottom: 16,
  };

  const planned = videos.filter(v => !v.productionPhase);
  const live = videos.filter(v => v.productionPhase);

  // Add one-or-many videos at once: the modal collects rows (name, plus credits
  // and/or client credit where they apply), then we create them in order so they
  // land on the board in the order they were typed.
  const createVideos = async (rows, plannedFlag) => {
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      await actions.addProjectVideo(dealId, r.title || null, {
        ...(creditMode ? { credits: r.credits } : {}),
        ...(r.creditMinutes ? { creditMinutes: r.creditMinutes, creditClientKey: r.creditClientKey || null } : {}),
        ...(plannedFlag ? { planned: true } : {}),
      });
    }
  };
  const openAdd = (asPlanned) => { setAddPlanned(asPlanned); setAddOpen(true); };
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

  const clientCreditPill = clientCredit && (clientCredit.issued > 0 || clientAvailable !== 0) ? (
    <span
      title="The customer's own video credit — buy it in their portal, reserve it against a video here"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#15803D', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 999, padding: '3px 10px' }}
    >
      <Wallet size={12} /> {fmtMins(clientAvailable)} client credit free
    </span>
  ) : null;

  const addModal = addOpen ? (
    <AddVideosModal
      onClose={() => setAddOpen(false)}
      onCreate={(rows) => createVideos(rows, addPlanned)}
      showMsg={showMsg}
      creditMode={creditMode}
      remaining={remaining}
      clientAvailable={clientCredit ? clientAvailable : 0}
      pools={creditPools}
      planned={addPlanned}
    />
  ) : null;

  if (!inProduction) {
    // A deal only becomes a project once someone marks it "Good to go" (the
    // button at the top of the page) — that's still the single gate for STARTING
    // work. Planning it isn't starting it, though: a production manager can name
    // the videos and reserve the client's credit against them now, and they move
    // onto the board when the project goes live.
    return (
      <div style={container}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <PanelHeader />
          <div style={{ flex: 1 }} />
          {clientCreditPill}
          <button className="btn-ghost" onClick={() => openAdd(true)}><Plus size={14} /> Add planned video</button>
        </div>
        <div style={{ fontSize: 13, color: BRAND.muted, marginBottom: planned.length ? 12 : 0 }}>
          This deal isn’t in production yet. Use <strong>Good to go</strong> at the top of the page to move it into
          Projects and alert the project managers — or plan the videos now and reserve the client’s credit against them.
        </div>
        {planned.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {planned.map(v => (
              <PlannedRow key={v.id} dealId={dealId} dealReference={deal.reference} video={v}
                hideCredits={hideCredits} canStart={false} pools={creditPools} onOpen={() => onOpenVideo && onOpenVideo(v.id)} />
            ))}
          </div>
        )}
        {addModal}
      </div>
    );
  }

  return (
    <div style={container}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <PanelHeader />
        <div style={{ flex: 1 }} />
        {clientCreditPill}
        {hideCredits ? null : creditMode ? (
          // Credit-based deal: the pool lives in the Credit Based Project card, so
          // just show the balance here (topping up happens over there).
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#92400E', background: '#FEF3C7', borderRadius: 999, padding: '3px 10px' }}>
            <Coins size={12} /> {remaining} credit{remaining === 1 ? '' : 's'} remaining
          </span>
        ) : (
          <>
            {credits > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#92400E', background: '#FEF3C7', borderRadius: 999, padding: '3px 10px' }}>
                <Coins size={12} /> {credits} credit{credits === 1 ? '' : 's'}
              </span>
            )}
            {credits > 0 && <button className="btn-ghost" onClick={useCredit}>Use a credit</button>}
            <button className="btn-ghost" onClick={addCredits}><Coins size={14} /> Add credits</button>
          </>
        )}
        <button className="btn-ghost" onClick={() => openAdd(true)} title="Name a video and reserve credit for it without starting it">
          <Plus size={14} /> Plan a video
        </button>
        <button className="btn" onClick={() => openAdd(false)}><Plus size={14} /> Add video</button>
      </div>

      {addModal}

      {videos.length === 0 ? (
        <div style={{ color: BRAND.muted, fontSize: 13, fontStyle: 'italic', padding: '8px 0' }}>
          {creditMode
            ? 'No videos yet. Add one — you’ll set how many credits it’s worth.'
            : 'No videos yet. Add one, or pre-pay credits to use later.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {live.map(v => (
            <VideoRow key={v.id} dealId={dealId} dealReference={deal.reference} video={v}
              hideCredits={hideCredits} pools={creditPools} onOpen={() => onOpenVideo && onOpenVideo(v.id)} />
          ))}
          {planned.length > 0 && (
            <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>
              Planned — not started
            </div>
          )}
          {planned.map(v => (
            <PlannedRow key={v.id} dealId={dealId} dealReference={deal.reference} video={v}
              hideCredits={hideCredits} canStart pools={creditPools} onOpen={() => onOpenVideo && onOpenVideo(v.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// Name one or many videos before creating them. Starts on a single "Video 1"
// row; "Add another" appends "Video N" (editable). On credit-based deals each
// row also carries how many credits the video is worth, and where the customer
// holds their own video credit each row can reserve minutes of it. All rows are
// created in order when you hit the button.
function AddVideosModal({ onClose, onCreate, showMsg, creditMode, remaining, clientAvailable, pools = [], planned }) {
  const [rows, setRows] = useState([{ name: 'Video 1', credits: '1', mins: '' }]);
  const [saving, setSaving] = useState(false);
  // Which of the customer's balances these videos draw on. Only asked when they
  // hold more than one — otherwise the server fills it in.
  const multiPool = pools.length > 1;
  const [poolKey, setPoolKey] = useState(() => (multiPool ? '' : (pools[0]?.clientKey || '')));
  const pool = multiPool ? pools.find((p) => p.clientKey === poolKey) || null : (pools[0] || null);
  // What's actually free depends on the chosen balance, not the company total.
  const spendable = multiPool ? (pool ? pool.available : 0) : clientAvailable;
  const clientMode = clientAvailable > 0 || pools.some((p) => p.available > 0);

  const setAt = (i, patch) => setRows(arr => arr.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows(arr => [...arr, { name: `Video ${arr.length + 1}`, credits: '1', mins: '' }]);
  const removeRow = (i) => setRows(arr => (arr.length <= 1 ? arr : arr.filter((_, idx) => idx !== i)));

  const totalCredits = rows.reduce((s, r) => s + (Number(r.credits) || 0), 0);
  const totalMins = rows.reduce((s, r) => s + (Number(r.mins) || 0), 0);
  const overBudget = creditMode && totalCredits > remaining;
  const overClient = clientMode && totalMins > spendable;

  const submit = async () => {
    if (saving) return;
    if (creditMode) {
      if (rows.some(r => !Number.isFinite(Number(r.credits)) || Number(r.credits) < 0)) {
        showMsg('Enter the credits for each video (0 or more)'); return;
      }
      if (overBudget) { showMsg(`That’s ${totalCredits} credits but only ${remaining} remaining`); return; }
    }
    if (clientMode) {
      if (rows.some(r => r.mins !== '' && (!Number.isFinite(Number(r.mins)) || Number(r.mins) < 0))) {
        showMsg('Client credit must be a number of minutes (or blank)'); return;
      }
      if (multiPool && totalMins > 0 && !poolKey) { showMsg('Choose which of their credit balances these videos draw on'); return; }
      if (overClient) { showMsg(`That reserves ${fmtMins(totalMins)} but only ${fmtMins(spendable)} is free`); return; }
    }
    const items = rows.map(r => ({
      title: r.name.trim(),
      credits: Number(r.credits) || 0,
      creditMinutes: Number(r.mins) || 0,
      creditClientKey: poolKey || pool?.clientKey || null,
    }));
    setSaving(true);
    try {
      await onCreate(items);
      onClose();
    } catch (e) {
      showMsg(e.message || 'Could not add video');
      setSaving(false);
    }
  };

  const count = rows.length;
  const wide = creditMode || clientMode;
  return (
    <Modal onClose={saving ? undefined : onClose} maxWidth={wide ? 620 : 460}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700 }}>
        {planned ? `Plan ${count === 1 ? 'a video' : `${count} videos`}` : `Add ${count === 1 ? 'a video' : `${count} videos`}`}
      </h2>
      <div style={{ fontSize: 13, color: BRAND.muted, marginBottom: 16 }}>
        {planned
          ? 'Named but not started — it stays off the production board until someone starts it. Reserve credit against it now if you want the client’s balance to reflect it.'
          : creditMode
            ? <>Name each video and set how many credits it’s worth. <strong>{remaining}</strong> credit{remaining === 1 ? '' : 's'} available.</>
            : 'Name each video (e.g. “Hero film”, “Cutdown 30s”). You can add as many as you like.'}
      </div>

      {clientMode && multiPool && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginBottom: 12 }}>
          <span style={{ fontWeight: 700, color: BRAND.ink, whiteSpace: 'nowrap' }}>Credit from</span>
          <select
            value={poolKey}
            onChange={(e) => setPoolKey(e.target.value)}
            disabled={saving}
            style={{ flex: 1, minWidth: 0, padding: '7px 9px', fontSize: 13, border: '1px solid ' + BRAND.border, borderRadius: 8, background: 'white' }}
          >
            <option value="">Choose a project…</option>
            {pools.map((p) => (
              <option key={p.clientKey} value={p.clientKey}>{p.name} — {fmtMins(p.available)} free</option>
            ))}
          </select>
        </label>
      )}

      {wide && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
          <span style={{ width: 16, flexShrink: 0 }} />
          <span style={{ flex: 1 }}>Video</span>
          {creditMode && <span style={{ width: 78, flexShrink: 0, textAlign: 'right' }}>Credits</span>}
          {clientMode && <span style={{ width: 110, flexShrink: 0, textAlign: 'right' }}>Client credit</span>}
          <span style={{ width: 30, flexShrink: 0 }} />
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Film size={16} color={BRAND.muted} style={{ flexShrink: 0 }} />
            <input
              autoFocus={i === rows.length - 1}
              value={row.name}
              onChange={e => setAt(i, { name: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
              placeholder={`Video ${i + 1}`}
              disabled={saving}
              style={{
                flex: 1, minWidth: 0, padding: '8px 10px', fontSize: 14,
                border: '1px solid ' + BRAND.border, borderRadius: 8,
              }}
            />
            {creditMode && (
              <input
                type="number"
                min="0"
                step="1"
                value={row.credits}
                onChange={e => setAt(i, { credits: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                aria-label="Credits"
                title="Credits this video is worth"
                disabled={saving}
                style={{
                  width: 78, flexShrink: 0, padding: '8px 10px', fontSize: 14, textAlign: 'right',
                  border: '1px solid ' + BRAND.border, borderRadius: 8,
                }}
              />
            )}
            {clientMode && (
              <div style={{ position: 'relative', width: 110, flexShrink: 0 }}>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={row.mins}
                  onChange={e => setAt(i, { mins: e.target.value })}
                  onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                  aria-label="Client credit minutes"
                  title="Minutes of the customer’s own video credit to reserve for this video"
                  placeholder="0"
                  disabled={saving}
                  style={{
                    width: '100%', padding: '8px 30px 8px 10px', fontSize: 14, textAlign: 'right',
                    border: '1px solid ' + BRAND.border, borderRadius: 8,
                  }}
                />
                <span style={{ position: 'absolute', right: 9, top: 9, fontSize: 12, color: BRAND.muted, pointerEvents: 'none' }}>min</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => removeRow(i)}
              disabled={saving || rows.length <= 1}
              aria-label="Remove video"
              title="Remove"
              style={{
                flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 30, height: 30, borderRadius: 8, border: '1px solid ' + BRAND.border,
                background: 'white', color: BRAND.muted,
                cursor: rows.length <= 1 ? 'default' : 'pointer',
                opacity: rows.length <= 1 ? 0.4 : 1,
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

      {creditMode && (
        <div style={{ marginTop: 12, fontSize: 13, color: overBudget ? '#B91C1C' : BRAND.muted }}>
          {totalCredits} credit{totalCredits === 1 ? '' : 's'} · {Math.max(0, remaining - totalCredits)} would remain
        </div>
      )}
      {clientMode && (
        <div style={{ marginTop: 6, fontSize: 13, color: overClient ? '#B91C1C' : BRAND.muted }}>
          {multiPool && !poolKey && totalMins > 0
            // Don't quote a "would stay free" figure before we know which of
            // their balances it's coming out of — that's the exact confusion
            // this picker exists to end.
            ? <>Choose which project’s credit these {fmtMins(totalMins)} come from, above.</>
            : <>
                Reserving {fmtMins(totalMins)} of client credit{pool ? ` from ${pool.name}` : ''} ·
                {' '}{fmtMins(Math.max(0, spendable - totalMins))} would stay free.
                {' '}They’ll see it in their portal as reserved for these videos.
              </>}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="btn" onClick={submit} disabled={saving || overBudget || overClient}>
          {saving ? 'Adding…' : `${planned ? 'Plan' : 'Add'} ${count === 1 ? 'video' : `${count} videos`}`}
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

// A video that's been named and (usually) paid for out of credit, but hasn't
// started. No progress bar — there's no board position to draw.
function PlannedRow({ dealId, dealReference, video, hideCredits, canStart, pools = [], onOpen }) {
  const { actions, showMsg } = useStore();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const start = () => {
    if (!window.confirm(`Start "${video.title}"? It moves onto the production board at Pre-Production.`)) return;
    setBusy(true);
    actions.startPlannedVideo(dealId, video.id)
      .then(() => showMsg('Video started'))
      .catch(e => showMsg(e.message || 'Could not start the video'))
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#FFFDF5', border: '1px dashed #FDE68A', borderRadius: 8 }}>
      <Film size={15} color="#B45309" />
      <button onClick={onOpen}
        style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontSize: 13, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {video.title}
      </button>
      <RefBadge reference={videoReference(dealReference, video.videoNumber)} size={10} />
      <span style={{ fontSize: 11, color: '#B45309', whiteSpace: 'nowrap' }}>Not started</span>
      {!hideCredits && <CreditChip video={video} onEdit={() => setEditing(true)} />}
      {canStart && (
        <button onClick={start} disabled={busy} className="btn-ghost" title="Move onto the production board">
          <Play size={13} /> Start
        </button>
      )}
      <button onClick={onOpen} className="btn-icon" title="Open video"><ChevronRight size={14} /></button>
      <button
        onClick={() => { if (window.confirm(`Delete "${video.title}"? Any credit reserved for it goes back on the client's balance.`)) actions.deleteProjectVideo(dealId, video.id); }}
        className="btn-icon" title="Delete video"
      ><Trash2 size={13} /></button>
      {editing && <AssignCreditModal dealId={dealId} video={video} pools={pools} onClose={() => setEditing(false)} />}
    </div>
  );
}

// The credit reserved against a video, as a clickable chip. Reads "+ Credit"
// when there's none yet, so assigning is one click from the project page.
export function CreditChip({ video, onEdit }) {
  const mins = video.creditMinutes;
  const spent = video.creditStatus === 'spent';
  if (!mins) {
    return (
      <button onClick={onEdit} className="btn-ghost" title="Reserve the customer's video credit for this video"
        style={{ fontSize: 11, padding: '2px 8px' }}>
        <Wallet size={11} style={{ verticalAlign: -1, marginRight: 3 }} />Credit
      </button>
    );
  }
  return (
    <button
      onClick={spent ? undefined : onEdit}
      disabled={spent}
      title={spent ? 'This credit has been drawn down' : 'Change the credit reserved for this video'}
      style={{
        flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: spent ? 'default' : 'pointer',
        fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', borderRadius: 999, padding: '2px 9px',
        color: spent ? BRAND.muted : '#15803D',
        background: spent ? '#F1F5F9' : '#F0FDF4',
        border: '1px solid ' + (spent ? BRAND.border : '#BBF7D0'),
      }}
    >
      <Wallet size={11} /> {fmtMins(mins)}{spent ? ' used' : ''}
    </button>
  );
}

// Set or clear the client credit reserved against one video. Shared by the
// project page and the video page.
export function AssignCreditModal({ dealId, video, pools = [], onClose }) {
  const { actions, showMsg } = useStore();
  const [mins, setMins] = useState(String(video.creditMinutes || ''));
  const [saving, setSaving] = useState(false);
  // Which balance this comes out of. Pre-set to whatever the video already draws
  // on, so editing an existing reservation doesn't silently move it.
  const multiPool = pools.length > 1;
  const [poolKey, setPoolKey] = useState(video.creditAllocation?.clientKey || video.creditClientKey || '');
  const pool = pools.find((p) => p.clientKey === poolKey) || null;
  // What's free on the chosen balance, with this video's own reservation added
  // back — re-assigning 6 min to a video already holding 4 needs 2 more, not 6.
  const spendable = pool
    ? pool.available + (video.creditAllocation?.clientKey === pool.clientKey ? (video.creditMinutes || 0) : 0)
    : null;

  const save = (value) => {
    const n = Number(value);
    if (value !== '' && (!Number.isFinite(n) || n < 0)) { showMsg('Enter a number of minutes, or 0 to release it'); return; }
    if (n > 0 && multiPool && !poolKey) { showMsg('Choose which of their credit balances this draws on'); return; }
    setSaving(true);
    actions.setVideoCredit(video.id, value === '' ? 0 : n, dealId, poolKey || null)
      .then(() => { showMsg(n > 0 ? `Reserved ${fmtMins(n)} for this video` : 'Credit released back to their balance'); onClose(); })
      .catch(e => { showMsg(e.message || 'Could not assign the credit'); setSaving(false); });
  };

  return (
    <Modal onClose={saving ? undefined : onClose} maxWidth={440}>
      <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700 }}>Client credit for “{video.title}”</h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted, lineHeight: 1.55 }}>
        Reserve minutes of the customer’s own video credit against this video. It comes off what they can spend on
        anything new, but it isn’t drawn down until the video is signed off — and they see exactly this in their portal.
      </p>
      {multiPool && (
        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.ink, marginBottom: 4 }}>Credit from</div>
          <select
            value={poolKey}
            onChange={e => setPoolKey(e.target.value)}
            disabled={saving}
            style={{ width: '100%', padding: '9px 10px', fontSize: 14, border: '1px solid ' + BRAND.border, borderRadius: 8, background: 'white' }}
          >
            <option value="">Choose a project…</option>
            {pools.map((p) => (
              <option key={p.clientKey} value={p.clientKey}>{p.name} — {fmtMins(p.available)} free</option>
            ))}
          </select>
        </label>
      )}

      <div style={{ position: 'relative' }}>
        <input
          autoFocus
          type="number"
          min="0"
          step="0.5"
          value={mins}
          onChange={e => setMins(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(mins); }}
          placeholder="0"
          disabled={saving}
          style={{ width: '100%', padding: '10px 44px 10px 12px', fontSize: 16, border: '1px solid ' + BRAND.border, borderRadius: 8 }}
        />
        <span style={{ position: 'absolute', right: 12, top: 12, fontSize: 13, color: BRAND.muted, pointerEvents: 'none' }}>min</span>
      </div>
      {spendable != null && (
        <div style={{ fontSize: 12, color: Number(mins) > spendable ? '#B91C1C' : BRAND.muted, marginTop: 6 }}>
          {fmtMins(spendable)} free on {pool.name}.
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 20 }}>
        <button type="button" className="btn-ghost" disabled={saving || !video.creditMinutes}
          onClick={() => save(0)} style={{ color: video.creditMinutes ? '#B91C1C' : BRAND.muted }}>
          Release
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn" onClick={() => save(mins)} disabled={saving}>
            {saving ? 'Saving…' : 'Reserve'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function VideoRow({ dealId, dealReference, video, hideCredits, pools = [], onOpen }) {
  const { actions, showMsg } = useStore();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
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

  // Move the video straight from the project page (no need to open it). Confirm
  // first so a stray click doesn't silently jump the stage. `label` is the
  // step's friendly name (e.g. "Storyboard Revisions").
  const moveStage = (phase, stage, label) => {
    if (phase === video.productionPhase && stage === video.productionStage) return;
    if (!window.confirm(`Move "${video.title}" to ${label}?`)) return;
    actions.moveVideoStage(video.id, phase, stage);
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
        <RefBadge reference={videoReference(dealReference, video.videoNumber)} size={10} />

        {video.voiceoverArtistName && (
          <span title="Voiceover chosen by the client" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, color: '#7C3AED', background: '#F3E8FF', border: '1px solid #E9D5FF', borderRadius: 999, padding: '1px 7px', whiteSpace: 'nowrap', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <Mic size={10} /> {video.voiceoverArtistName}
          </span>
        )}

        {!hideCredits && <CreditChip video={video} onEdit={() => setEditing(true)} />}

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

      {/* At-a-glance production progress for this video. Clickable here too so a
          PM can advance the stage without opening the video (confirms first). */}
      <VideoProgressBar
        phaseId={video.productionPhase}
        stageId={video.productionStage}
        revisionRound={video.revisionRound}
        onMove={moveStage}
      />
      {editing && <AssignCreditModal dealId={dealId} video={video} pools={pools} onClose={() => setEditing(false)} />}
    </div>
  );
}
