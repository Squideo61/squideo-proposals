import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, Clapperboard, Film, Plus, LayoutGrid, Search, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { Modal, RefBadge } from '../ui.jsx';
import { XeroContactPicker } from './XeroContactPicker.jsx';
import { api } from '../../api.js';
import {
  PRODUCTION_PHASES, PHASE_BY_ID, STAGE_LABEL, PAYMENT_OPTION_LABEL,
  VIDEO_LENGTH_OPTIONS, VIDEO_LENGTH_VALUES,
} from '../../lib/productionStages.js';

const inlineSel = { width: '100%', padding: '4px 6px', border: '1px solid ' + BRAND.blue, borderRadius: 6, fontSize: 12, background: 'white' };

const PRODUCER_FILTER_STORAGE_KEY = 'squideo.production.producerFilter';
const PHASE_STORAGE_KEY = 'squideo.production.phase';

// Table columns, mirroring Monday's main table. Each row is a VIDEO.
const COLS = 'minmax(220px, 2.2fr) 110px 100px 120px 120px 170px';
const chip = { display: 'inline-block', fontSize: 11, color: BRAND.ink, background: '#F1F5F9', borderRadius: 999, padding: '2px 8px' };

// Production board: VIDEOS move through the workflow (a project just groups
// them). Stage groups of rows with Payment / Length / Producer columns; phase
// tabs switch boards. Dragging a video onto a stage group (or phase tab) moves
// it; clicking opens that video's page.
export function ProductionView({ onBack, onOpenVideo, onOpenProject, onOpenProjects }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();

  useEffect(() => { actions.loadProductionVideos(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [activePhase, setActivePhase] = useState(() => {
    try { return localStorage.getItem(PHASE_STORAGE_KEY) || PRODUCTION_PHASES[0].id; } catch { return PRODUCTION_PHASES[0].id; }
  });
  useEffect(() => { try { localStorage.setItem(PHASE_STORAGE_KEY, activePhase); } catch {} }, [activePhase]);

  const [producerFilter, setProducerFilter] = useState(() => {
    try { return localStorage.getItem(PRODUCER_FILTER_STORAGE_KEY) || ''; } catch { return ''; }
  });
  useEffect(() => { try { localStorage.setItem(PRODUCER_FILTER_STORAGE_KEY, producerFilter); } catch {} }, [producerFilter]);

  const videos = useMemo(() => (state.productionVideos || []), [state.productionVideos]);
  // A video matches the producer filter if that person is any of its producers.
  const videoProducers = (v) => (v.producerEmails && v.producerEmails.length)
    ? v.producerEmails : (v.producerEmail ? [v.producerEmail] : []);
  const filtered = useMemo(
    () => (producerFilter ? videos.filter(v => videoProducers(v).includes(producerFilter)) : videos),
    [videos, producerFilter],
  );

  // Live search across video title, project title, customer, and producer name.
  // When the query is non-empty the board switches to a flat results list so
  // matches from every phase show up at once (with each row's stage chipped).
  const q = query.trim().toLowerCase();
  const searched = useMemo(() => {
    if (!q) return filtered;
    return filtered.filter(v => {
      const producerNames = videoProducers(v).map(e => state.users?.[e]?.name || e).join(' ').toLowerCase();
      return (v.title || '').toLowerCase().includes(q)
        || (v.projectTitle || '').toLowerCase().includes(q)
        || (v.companyName || '').toLowerCase().includes(q)
        || producerNames.includes(q);
    });
  }, [filtered, q, state.users]);

  const countByPhase = useMemo(() => {
    const out = Object.fromEntries(PRODUCTION_PHASES.map(p => [p.id, 0]));
    for (const v of searched) if (out[v.productionPhase] != null) out[v.productionPhase] += 1;
    return out;
  }, [searched]);

  const phase = PHASE_BY_ID[activePhase] || PRODUCTION_PHASES[0];
  const grouped = useMemo(() => {
    const out = Object.fromEntries(phase.stages.map(s => [s.id, []]));
    const fallback = phase.stages[0]?.id;
    for (const v of searched) {
      if (v.productionPhase !== phase.id) continue;
      const stage = out[v.productionStage] ? v.productionStage : fallback;
      (out[stage] || out[fallback]).push(v);
    }
    return out;
  }, [searched, phase]);

  const memberOptions = useMemo(() => Object.entries(state.users || {})
    .map(([email, u]) => ({ email, name: u.name || email }))
    .sort((a, b) => a.name.localeCompare(b.name)), [state.users]);

  const handleDropOnStage = (video, stageId) => {
    if (!video) return;
    if (video.productionPhase === phase.id && video.productionStage === stageId) return;
    actions.moveVideoStage(video.id, phase.id, stageId);
    showMsg(`Moved to ${phase.stages.find(s => s.id === stageId)?.label || stageId}`);
  };

  const handleDropOnPhase = (video, phaseId) => {
    if (!video) return;
    const target = PHASE_BY_ID[phaseId];
    if (!target) return;
    const firstStage = target.stages[0]?.id;
    if (video.productionPhase === phaseId && video.productionStage === firstStage) return;
    actions.moveVideoStage(video.id, phaseId, firstStage);
    setActivePhase(phaseId);
    showMsg(`Moved to ${target.label}`);
  };

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {onBack && <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>}
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clapperboard size={22} color={BRAND.blue} /> Production
          </h1>
          <ProducerFilter
            producerFilter={producerFilter}
            setProducerFilter={setProducerFilter}
            memberOptions={memberOptions}
            sessionEmail={state.session?.email || ''}
          />
          <SearchBox value={query} onChange={setQuery} placeholder="Search videos, projects, customers…" />
          <span style={{ fontSize: 13, color: BRAND.muted }}>{searched.length} {searched.length === 1 ? 'video' : 'videos'}{q ? ' match' : ''}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {onOpenProjects && <button onClick={onOpenProjects} className="btn-ghost"><LayoutGrid size={14} /> Projects</button>}
          <button onClick={() => setCreating(true)} className="btn"><Plus size={16} /> New project</button>
        </div>
      </header>

      {/* Phase tabs — also drop targets for cross-phase moves. */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid ' + BRAND.border, flexWrap: 'wrap' }}>
        {PRODUCTION_PHASES.map(p => (
          <PhaseTab
            key={p.id}
            phase={p}
            active={p.id === activePhase}
            count={countByPhase[p.id] || 0}
            onSelect={() => setActivePhase(p.id)}
            onDropVideo={(video) => handleDropOnPhase(video, p.id)}
          />
        ))}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 900 }}>
          <ColumnsHeader />
          {q ? (
            // Live search: flat list across every phase, each row chipped with
            // its current stage so it's instantly obvious where it sits.
            <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: searched.length ? 6 : 0 }}>
                Search results · {searched.length}
              </div>
              {searched.length === 0
                ? <div style={{ padding: '6px 2px', color: BRAND.muted, fontSize: 12, fontStyle: 'italic' }}>No matches</div>
                : searched.map(v => <VideoRow key={v.id} video={v} onOpen={() => onOpenVideo(v.id)} showStage />)}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {phase.stages.map(s => (
                <StageGroup
                  key={s.id}
                  stage={s}
                  color={phase.color}
                  videos={grouped[s.id] || []}
                  onDrop={(video) => handleDropOnStage(video, s.id)}
                  onOpenVideo={onOpenVideo}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreated={(deal) => { setCreating(false); if (deal) onOpenProject(deal.id); }}
        />
      )}
    </div>
  );
}

function ColumnsHeader() {
  const cell = { fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, alignItems: 'center', padding: '0 13px 6px 16px' }}>
      <span style={cell}>Video</span>
      <span style={cell}>Payment</span>
      <span style={cell}>Length</span>
      <span style={cell}>Text direction</span>
      <span style={cell}>Delivery</span>
      <span style={cell}>Producer</span>
    </div>
  );
}

function PhaseTab({ phase, active, count, onSelect, onDropVideo }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onSelect}
      onDragOver={(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        try { onDropVideo(JSON.parse(e.dataTransfer.getData('application/json'))); } catch {}
      }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 14px',
        border: 'none', borderBottom: '2px solid ' + (active ? phase.color : 'transparent'),
        background: hover ? '#F0F9FF' : 'transparent', cursor: 'pointer',
        fontSize: 14, fontWeight: active ? 700 : 500, color: active ? BRAND.ink : BRAND.muted,
        marginBottom: -1,
      }}
    >
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: phase.color, opacity: active ? 1 : 0.5 }} />
      {phase.label}
      <span style={{ fontSize: 12, color: BRAND.muted, fontWeight: 500 }}>· {count}</span>
    </button>
  );
}

function StageGroup({ stage, color, videos, onDrop, onOpenVideo }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        try { onDrop(JSON.parse(e.dataTransfer.getData('application/json'))); } catch {}
      }}
      style={{
        background: hover ? '#F0F9FF' : 'white',
        border: hover ? '1px dashed ' + BRAND.blue : '1px solid ' + BRAND.border,
        borderLeft: '4px solid ' + color,
        borderRadius: 10,
        padding: 12,
        transition: 'background 100ms, border-color 100ms',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: videos.length ? 6 : 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 0.4 }}>{stage.label}</span>
        <span style={{ fontSize: 12, color: BRAND.muted }}>· {videos.length}</span>
      </div>
      {videos.length === 0
        ? <div style={{ padding: '6px 2px', color: BRAND.muted, fontSize: 12, fontStyle: 'italic' }}>No videos</div>
        : videos.map(v => <VideoRow key={v.id} video={v} onOpen={() => onOpenVideo(v.id)} />)}
    </div>
  );
}

function VideoRow({ video, onOpen, showStage }) {
  const { state, actions } = useStore();
  const producers = (video.producerEmails && video.producerEmails.length)
    ? video.producerEmails : (video.producerEmail ? [video.producerEmail] : []);
  const memberOptions = useMemo(() => Object.entries(state.users || {})
    .map(([email, u]) => ({ email, name: u.name || email }))
    .sort((a, b) => a.name.localeCompare(b.name)), [state.users]);
  // Inline field editing (Callum fills the card straight from the board).
  const [editing, setEditing] = useState(null); // 'length' | 'producer' | null
  const stop = (e) => e.stopPropagation();
  const saveLength = (value) => {
    if (value === '__other__') {
      const custom = window.prompt('Custom video length (e.g. "6 minutes (840w)"). Add "N days" to set the schedule duration:', video.videoLength || '');
      setEditing(null);
      if (custom != null) actions.updateVideo(video.id, { videoLength: custom.trim() || null });
      return;
    }
    setEditing(null);
    actions.updateVideo(video.id, { videoLength: value || null });
  };
  const saveProducer = (email) => {
    setEditing(null);
    actions.updateVideo(video.id, { producerEmails: email ? [email] : [] });
  };
  return (
    <div
      draggable={!editing}
      onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify(video))}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      style={{
        display: 'grid', gridTemplateColumns: COLS, gap: 12, alignItems: 'center',
        padding: '9px 0', borderTop: '1px solid ' + BRAND.border, cursor: 'grab', fontSize: 13,
      }}
    >
      {/* Project (prominent) + its video number / customer; stage chip in search results */}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {video.projectTitle || video.companyName || video.title}
        </div>
        <div style={{ fontSize: 11, color: BRAND.muted, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap' }}>
          {showStage && <StageChip phase={video.productionPhase} stage={video.productionStage} />}
          <RefBadge reference={video.reference} size={10} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {[video.title, (video.companyName && video.companyName !== video.projectTitle) ? video.companyName : null].filter(Boolean).join(' · ') || '—'}
          </span>
        </div>
      </div>
      {/* Payment (from the signed proposal) */}
      <div>{video.paymentOption
        ? <span style={chip}>{PAYMENT_OPTION_LABEL[video.paymentOption] || video.paymentOption}</span>
        : <span style={{ color: BRAND.muted }}>—</span>}</div>
      {/* Length — click to pick from the preset dropdown */}
      <div onClick={stop} style={{ minWidth: 0 }}>
        {editing === 'length' ? (
          <select autoFocus value={VIDEO_LENGTH_VALUES.has(video.videoLength) ? video.videoLength : (video.videoLength || '')}
            onChange={(e) => saveLength(e.target.value)} onBlur={() => setEditing(null)} onClick={stop} style={inlineSel}>
            <option value="">—</option>
            {video.videoLength && !VIDEO_LENGTH_VALUES.has(video.videoLength) && <option value={video.videoLength}>{video.videoLength}</option>}
            {VIDEO_LENGTH_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
            <option value="__other__">Other…</option>
          </select>
        ) : (
          <span onClick={(e) => { stop(e); setEditing('length'); }} title="Set video length"
            style={{ cursor: 'pointer', borderBottom: '1px dashed ' + BRAND.border, color: video.videoLength ? BRAND.ink : BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '100%' }}>
            {video.videoLength || '—'}
          </span>
        )}
      </div>
      {/* Text direction */}
      <div style={{ color: video.textDirectionDeadline ? BRAND.ink : BRAND.muted }}>{video.textDirectionDeadline ? formatDate(video.textDirectionDeadline) : '—'}</div>
      {/* Delivery */}
      <div style={{ color: video.deliveryDeadline ? BRAND.ink : BRAND.muted }}>{video.deliveryDeadline ? formatDate(video.deliveryDeadline) : '—'}</div>
      {/* Producers — click to assign */}
      <div onClick={stop} style={{ minWidth: 0 }}>
        {editing === 'producer' ? (
          <select autoFocus value={producers[0] || ''} onChange={(e) => saveProducer(e.target.value)} onBlur={() => setEditing(null)} onClick={stop} style={inlineSel}>
            <option value="">Unassigned</option>
            {memberOptions.map(m => <option key={m.email} value={m.email}>{m.name}</option>)}
          </select>
        ) : (
          <div onClick={(e) => { stop(e); setEditing('producer'); }} title="Assign producer"
            style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, cursor: 'pointer' }}>
            {producers.length === 0 ? (
              <span style={{ color: BRAND.muted, borderBottom: '1px dashed ' + BRAND.border }}>Unassigned</span>
            ) : producers.length === 1 ? (
              <>
                <Avatar user={state.users[producers[0]]} fallback={producers[0]} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {state.users[producers[0]]?.name || producers[0]}
                </span>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  {producers.slice(0, 3).map((e, i) => (
                    <span key={e} style={{ marginLeft: i === 0 ? 0 : -8 }}>
                      <Avatar user={state.users[e]} fallback={e} />
                    </span>
                  ))}
                </div>
                <span style={{ color: BRAND.muted, fontSize: 12, whiteSpace: 'nowrap' }}>
                  {producers.length} producers{producers.length > 3 ? ` (+${producers.length - 3})` : ''}
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Producer filter — "All producers" / "<Name>". Mirrors the pipeline owner filter.
function ProducerFilter({ producerFilter, setProducerFilter, memberOptions, sessionEmail }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const selectedName = producerFilter ? (memberOptions.find(m => m.email === producerFilter)?.name || producerFilter) : '';
  const label = !producerFilter ? 'All producers' : `${selectedName.split(' ')[0]}'s videos`;
  const choose = (email) => { setProducerFilter(email); setOpen(false); };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
        className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
        {label}<ChevronDown size={14} style={{ opacity: 0.6 }} />
      </button>
      {open && (
        <div role="listbox" style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, background: 'white',
          border: '1px solid ' + BRAND.border, borderRadius: 8, boxShadow: '0 8px 24px rgba(15, 42, 61, 0.12)',
          minWidth: 220, padding: 4, zIndex: 50, maxHeight: 320, overflowY: 'auto',
        }}>
          <FilterOption label="All producers" selected={!producerFilter} onClick={() => choose('')} />
          {memberOptions.map(m => (
            <FilterOption key={m.email}
              label={m.email === sessionEmail ? `${m.name} (me)` : m.name}
              selected={producerFilter === m.email}
              onClick={() => choose(m.email)} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterOption({ label, selected, onClick }) {
  return (
    <button role="option" aria-selected={selected} onClick={onClick}
      onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = selected ? '#EFF8FC' : 'transparent'; }}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%',
        padding: '8px 10px', border: 'none', background: selected ? '#EFF8FC' : 'transparent', borderRadius: 6,
        cursor: 'pointer', fontSize: 13, color: BRAND.ink, textAlign: 'left',
      }}>
      <span>{label}</span>{selected && <Check size={14} color={BRAND.blue} />}
    </button>
  );
}

function Avatar({ user, fallback, size = 18 }) {
  const name = user?.name || fallback || '?';
  const initial = (name[0] || '?').toUpperCase();
  return (
    <div title={name} style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: Math.round(size * 0.5), flexShrink: 0 }}>
      {user?.avatar
        ? <img src={user.avatar} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : initial}
    </div>
  );
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Small pill showing a video's current phase + stage. Used in search-result
// rows so the user sees where a match sits without leaving the search list.
function StageChip({ phase, stage }) {
  const ph = PHASE_BY_ID[phase];
  const label = (phase && STAGE_LABEL[phase]?.[stage]) || stage || '—';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: BRAND.ink, background: '#F1F5F9', borderRadius: 999, padding: '1px 7px', flexShrink: 0, whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: ph?.color || BRAND.muted }} />
      {label}
    </span>
  );
}

// Live search input with an inline clear button. Reused by ProjectsOverviewView.
export function SearchBox({ value, onChange, placeholder }) {
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: BRAND.muted, pointerEvents: 'none' }} />
      <input
        type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        style={{ padding: '7px 28px 7px 30px', borderRadius: 8, border: '1px solid ' + BRAND.border, fontSize: 13, minWidth: 240, boxSizing: 'border-box' }}
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search"
          style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: BRAND.muted, padding: 4, display: 'flex' }}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

// Create a project and assign it to a customer. Mirrors the pipeline's "New
// deal" modal (Xero contact → company); the result lands on the board as a
// project with one video.
function NewProjectModal({ onClose, onCreated }) {
  const { state, actions, showMsg } = useStore();
  const [title, setTitle] = useState('');
  const [xeroContact, setXeroContact] = useState(null);
  const [primaryContactId, setPrimaryContactId] = useState('');
  const [producerEmail, setProducerEmail] = useState('');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const contacts = Object.values(state.contacts || {});
  const memberOptions = Object.entries(state.users || {})
    .map(([email, u]) => ({ email, name: u.name || email }))
    .sort((a, b) => a.name.localeCompare(b.name));

  function handleXeroPick(c) {
    setXeroContact(c);
    if (c && !title.trim()) setTitle(c.name);
  }

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      let companyId = null;
      if (xeroContact) {
        const company = await api.post('/api/crm/companies/from-xero-contact', { xeroContactId: xeroContact.id });
        companyId = company.id;
      }
      const deal = await actions.createProject({
        title: title.trim(),
        companyId,
        primaryContactId: primaryContactId || null,
        producerEmail: producerEmail || null,
        value: value === '' ? null : Number(value),
      });
      onCreated?.(deal);
    } catch (err) {
      showMsg?.('Failed to create project: ' + (err?.message || 'unknown error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} fullScreenOnMobile>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>New project</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Customer (Xero contact)
          <div style={{ marginTop: 4 }}>
            <XeroContactPicker value={xeroContact} onChange={handleXeroPick} placeholder="Search Xero contacts…" />
          </div>
        </label>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Project title
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Acme Corp — Brand explainer" style={{ marginTop: 4 }} required />
        </label>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Primary contact (optional)
          <select className="input" value={primaryContactId} onChange={(e) => setPrimaryContactId(e.target.value)} style={{ marginTop: 4 }}>
            <option value="">—</option>
            {contacts.map(c => <option key={c.id} value={c.id}>{c.name || c.email}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Producer (optional)
          <select className="input" value={producerEmail} onChange={(e) => setProducerEmail(e.target.value)} style={{ marginTop: 4 }}>
            <option value="">— Unassigned —</option>
            {memberOptions.map(m => <option key={m.email} value={m.email}>{m.name}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13, fontWeight: 500 }}>
          Value (£, ex VAT, optional)
          <input className="input" type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={!title.trim() || submitting}>
            {submitting ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
