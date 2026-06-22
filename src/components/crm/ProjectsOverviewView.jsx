import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, LayoutGrid, Film, ChevronRight, ExternalLink, CalendarDays } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { PRODUCTION_PHASES, PHASE_BY_ID, STAGE_LABEL } from '../../lib/productionStages.js';
import { SearchBox } from './ProductionView.jsx';

// A project spans many videos across stages; its position in the pipeline is the
// LEAST-advanced video's phase (mirrors the deal/project progress bar rule), so
// a project only leaves a phase once every video has moved past it.
const PHASE_INDEX = Object.fromEntries(PRODUCTION_PHASES.map((p, i) => [p.id, i]));
function overallPhaseId(videos) {
  let min = null;
  for (const v of videos) {
    const idx = PHASE_INDEX[v.productionPhase];
    if (idx == null) continue;
    if (min == null || idx < min) min = idx;
  }
  return PRODUCTION_PHASES[min ?? 0]?.id || PRODUCTION_PHASES[0].id;
}

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
// How the project was paid, labelling the date it landed in production: a 50/50
// deal kicks off on its deposit, a "full" deal on the full payment, a PO deal on
// the confirmed PO.
const paidLabel = (paymentOption) => (
  paymentOption === '5050' ? 'Deposit paid'
    : paymentOption === 'po' ? 'PO confirmed'
      : 'Paid'
);

// Projects overview: every project at a glance — how many videos it has and
// which stages those videos are spread across. Derived from the same video
// list that powers the board (grouped by project). Click a project to open it.
export function ProjectsOverviewView({ onBack, onOpenProject }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();

  useEffect(() => { actions.loadProductionVideos(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Undefined until the first load resolves — distinguishes "still loading" from
  // a genuinely empty board, so we don't flash "no projects" on entry.
  const loading = state.productionVideos === undefined;
  const videos = state.productionVideos || [];
  const projects = useMemo(() => {
    const map = new Map();
    for (const v of videos) {
      if (!map.has(v.dealId)) map.set(v.dealId, { dealId: v.dealId, projectTitle: v.projectTitle, companyName: v.companyName, projectNumber: v.projectNumber || null, driveFolderId: v.driveFolderId || null, enteredProductionAt: null, earliestCreated: null, paymentOption: v.paymentOption || null, startDate: v.productionStartDate || null, videos: [] });
      const p = map.get(v.dealId);
      p.videos.push(v);
      // When the project was paid (landed in production): the deal's
      // production_entered_at, falling back to the earliest video created_at.
      if (!p.enteredProductionAt && v.enteredProductionAt) p.enteredProductionAt = v.enteredProductionAt;
      if (v.createdAt && (!p.earliestCreated || v.createdAt < p.earliestCreated)) p.earliestCreated = v.createdAt;
      if (!p.paymentOption && v.paymentOption) p.paymentOption = v.paymentOption;
      if (!p.startDate && v.productionStartDate) p.startDate = v.productionStartDate;
    }
    const list = Array.from(map.values()).map(p => ({ ...p, paidAt: p.enteredProductionAt || p.earliestCreated || null, phaseId: overallPhaseId(p.videos) }));
    // Newest project first (by when it was paid); undated fall to the bottom.
    return list.sort((a, b) => {
      const ta = a.paidAt ? new Date(a.paidAt).getTime() : 0;
      const tb = b.paidAt ? new Date(b.paidAt).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return (a.projectTitle || '').localeCompare(b.projectTitle || '');
    });
  }, [videos]);

  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matched = useMemo(() => {
    if (!q) return projects;
    return projects.filter(p =>
      (p.projectTitle || '').toLowerCase().includes(q)
      || (p.companyName || '').toLowerCase().includes(q)
    );
  }, [projects, q]);

  // Group projects by their overall phase, for the pipeline-style stage cards.
  const grouped = useMemo(() => {
    const out = Object.fromEntries(PRODUCTION_PHASES.map(p => [p.id, []]));
    for (const p of matched) (out[p.phaseId] || out[PRODUCTION_PHASES[0].id]).push(p);
    return out;
  }, [matched]);

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {onBack && <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>}
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <LayoutGrid size={22} color={BRAND.blue} /> Projects
        </h1>
        <SearchBox value={query} onChange={setQuery} placeholder="Search projects, customers…" />
        <span style={{ fontSize: 13, color: BRAND.muted }}>{loading ? 'Loading…' : `${matched.length} ${matched.length === 1 ? 'project' : 'projects'}${q ? ' match' : ''}`}</span>
      </header>

      {loading ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>
          Loading projects…
        </div>
      ) : matched.length === 0 ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>
          {q ? 'No matches.' : 'No projects in production yet.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {PRODUCTION_PHASES.map(phase => (
            <PhaseGroup
              key={phase.id}
              phase={phase}
              projects={grouped[phase.id] || []}
              onOpenProject={onOpenProject}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One phase's group, mirroring the Sales Pipeline's StageRow: a card with a
// coloured left border keyed to the phase, a collapsible header (label · count ·
// video total), and the projects rendered as compact rows inside.
function PhaseGroup({ phase, projects, onOpenProject }) {
  const [collapsed, setCollapsed] = useState(false);
  const videoTotal = projects.reduce((s, p) => s + (p.videos?.length || 0), 0);
  return (
    <div
      style={{
        background: '#F8FAFC',
        border: '1px solid ' + BRAND.border,
        borderLeft: '4px solid ' + phase.color,
        borderRadius: 10,
        padding: 12,
      }}
    >
      <button
        onClick={() => setCollapsed(c => !c)}
        style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8,
          width: '100%', padding: '0 2px', marginBottom: collapsed ? 0 : 10,
          background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
        }}
        aria-expanded={!collapsed}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: phase.color, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {phase.label}
          </span>
          <span style={{ fontSize: 12, color: BRAND.muted }}>· {projects.length}</span>
          {videoTotal > 0 && (
            <span style={{ fontSize: 12, color: BRAND.muted }}>· {videoTotal} video{videoTotal === 1 ? '' : 's'}</span>
          )}
        </div>
        <span style={{ fontSize: 11, color: BRAND.muted }}>{collapsed ? 'Show' : 'Hide'}</span>
      </button>
      {!collapsed && (
        projects.length === 0 ? (
          <div style={{ padding: '12px 8px', color: BRAND.muted, fontSize: 12, fontStyle: 'italic' }}>
            No projects
          </div>
        ) : (
          <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden' }}>
            {projects.map(p => <ProjectRow key={p.dealId} project={p} onOpen={() => onOpenProject(p.dealId)} />)}
          </div>
        )
      )}
    </div>
  );
}

// Compact project row inside a phase group — the project-side counterpart to the
// pipeline's DealRow.
function ProjectRow({ project, onOpen }) {
  const { videos } = project;

  // Count videos per (phase, stage) and render a chip for each occupied stage.
  const breakdown = useMemo(() => {
    const counts = new Map();
    for (const v of videos) {
      const key = (v.productionPhase || '') + '|' + (v.productionStage || '');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([key, count]) => {
      const [phaseId, stageId] = key.split('|');
      const phase = PHASE_BY_ID[phaseId];
      const label = STAGE_LABEL[phaseId]?.[stageId] || stageId || '—';
      return { color: phase?.color || BRAND.muted, label, count };
    });
  }, [videos]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; }}
      style={{ borderTop: '1px solid ' + BRAND.border, background: 'white', cursor: 'pointer', padding: '10px 12px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {project.projectNumber && (
              <span style={{ fontSize: 11, fontWeight: 600, color: BRAND.muted }}>{project.projectNumber}</span>
            )}
            <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {project.projectTitle || 'Untitled project'}
            </span>
            {breakdown.map((b, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: BRAND.ink, background: '#F1F5F9', borderRadius: 999, padding: '2px 9px' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: b.color }} />
                {b.count} {b.label}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {project.companyName ? <span>{project.companyName}</span> : null}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Film size={12} /> {videos.length} video{videos.length === 1 ? '' : 's'}</span>
            {fmtDate(project.paidAt) && (
              <span>· {paidLabel(project.paymentOption)} {fmtDate(project.paidAt)}</span>
            )}
            {fmtDate(project.startDate) && (
              <span title="Production start date" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: BRAND.blue }}>
                · <CalendarDays size={12} /> Starts {fmtDate(project.startDate)}
              </span>
            )}
          </div>
        </div>
        {project.driveFolderId && (
          <a
            href={`https://drive.google.com/drive/folders/${project.driveFolderId}`}
            target="_blank" rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Open the project's Drive folder"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, fontSize: 12, fontWeight: 600, color: BRAND.blue, textDecoration: 'none' }}
          >
            Open folder <ExternalLink size={12} />
          </a>
        )}
        <ChevronRight size={18} color={BRAND.muted} style={{ flexShrink: 0 }} />
      </div>
    </div>
  );
}
