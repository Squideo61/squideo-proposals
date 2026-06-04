import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, LayoutGrid, Film, ChevronRight, ExternalLink } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { PHASE_BY_ID, STAGE_LABEL } from '../../lib/productionStages.js';
import { SearchBox } from './ProductionView.jsx';

// Projects overview: every project at a glance — how many videos it has and
// which stages those videos are spread across. Derived from the same video
// list that powers the board (grouped by project). Click a project to open it.
export function ProjectsOverviewView({ onBack, onOpenProject }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();

  useEffect(() => { actions.loadProductionVideos(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const videos = state.productionVideos || [];
  const projects = useMemo(() => {
    const map = new Map();
    for (const v of videos) {
      if (!map.has(v.dealId)) map.set(v.dealId, { dealId: v.dealId, projectTitle: v.projectTitle, companyName: v.companyName, projectNumber: v.projectNumber || null, driveFolderId: v.driveFolderId || null, videos: [] });
      map.get(v.dealId).videos.push(v);
    }
    return Array.from(map.values()).sort((a, b) => (a.projectTitle || '').localeCompare(b.projectTitle || ''));
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

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {onBack && <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>}
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <LayoutGrid size={22} color={BRAND.blue} /> Projects
        </h1>
        <SearchBox value={query} onChange={setQuery} placeholder="Search projects, customers…" />
        <span style={{ fontSize: 13, color: BRAND.muted }}>{matched.length} {matched.length === 1 ? 'project' : 'projects'}{q ? ' match' : ''}</span>
      </header>

      {matched.length === 0 ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 40, textAlign: 'center', color: BRAND.muted }}>
          {q ? 'No matches.' : 'No projects in production yet.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {matched.map(p => <ProjectCard key={p.dealId} project={p} onOpen={() => onOpenProject(p.dealId)} />)}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project, onOpen }) {
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
      style={{
        display: 'flex', alignItems: 'center', gap: 14, width: '100%', textAlign: 'left',
        background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16, cursor: 'pointer',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {project.projectNumber && (
            <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.muted }}>{project.projectNumber}</span>
          )}
          <span>{project.projectTitle || 'Untitled project'}</span>
        </div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
          {project.companyName ? <span>{project.companyName} · </span> : null}
          <Film size={12} /> {videos.length} video{videos.length === 1 ? '' : 's'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {breakdown.map((b, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: BRAND.ink, background: '#F1F5F9', borderRadius: 999, padding: '2px 9px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: b.color }} />
              {b.count} {b.label}
            </span>
          ))}
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
      <ChevronRight size={18} color={BRAND.muted} />
    </div>
  );
}
