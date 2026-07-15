// Portal home: per-project ball-in-court banners, phase progress and the
// quick actions (request-a-video with the 10% badge, partner programme).
import React from 'react';
import { BRAND } from '../../theme.js';
import { usePortal } from '../PortalContext.jsx';
import { portalApi } from '../api.js';
import {
  Card, CourtBanner, PhaseTimeline, StatusPill, EmptyState, SectionHeading,
} from '../components.jsx';
import { Film, FolderOpen, Sparkles, Handshake, ChevronRight, Video } from 'lucide-react';

const PARTNER_URL = 'https://squideo.com/partner-programme';

export function runCta(cta, dealId) {
  if (!cta) return;
  if (cta.action === 'po-number') {
    window.location.hash = `#/project/${dealId}`;
    return;
  }
  if (cta.href?.startsWith('#/')) {
    window.location.hash = cta.href;
    return;
  }
  if (cta.href) window.location.href = cta.href; // proposal / revision deep-links
}

function ProjectCard({ project }) {
  const open = () => { window.location.hash = `#/project/${project.id}`; };
  return (
    <Card onClick={open} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div>
          <div style={{ fontSize: 16.5, fontWeight: 800, color: BRAND.ink }}>{project.title}</div>
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 3 }}>
            {project.videos?.length
              ? `${project.videos.length} video${project.videos.length === 1 ? '' : 's'}`
              : project.stageLabel}
          </div>
        </div>
        <ChevronRight size={18} color={BRAND.muted} style={{ flexShrink: 0, marginTop: 4 }} />
      </div>

      {project.inProduction && (
        <div style={{ padding: '4px 2px' }}>
          <PhaseTimeline production={project.production} />
        </div>
      )}

      <CourtBanner nextStep={project.nextStep} onCta={(cta) => runCta(cta, project.id)} compact />

      {project.videos?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {project.videos.slice(0, 4).map((v) => (
            <span key={v.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: BRAND.ink }}>
              <Video size={13} color={BRAND.muted} />
              <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.title}</span>
              <StatusPill label={v.statusLabel} color={v.statusColor} />
            </span>
          ))}
          {project.videos.length > 4 && (
            <span style={{ fontSize: 12, color: BRAND.muted }}>+{project.videos.length - 4} more</span>
          )}
        </div>
      )}

      {project.extrasAvailable > 0 && (
        <button
          className="btn-ghost"
          onClick={(e) => { e.stopPropagation(); window.location.hash = `#/extras/${project.id}`; }}
          style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: BRAND.blue }}
        >
          <Sparkles size={14} /> Add extras — portal prices
        </button>
      )}
    </Card>
  );
}

function QuickAction({ Icon, title, body, badge, onClick, accent }) {
  return (
    <Card onClick={onClick} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', padding: 16 }}>
      <div style={{
        width: 40, height: 40, borderRadius: 10, display: 'grid', placeItems: 'center', flexShrink: 0,
        background: (accent || BRAND.blue) + '1a', color: accent || BRAND.blue,
      }}>
        <Icon size={20} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, fontSize: 14, color: BRAND.ink }}>{title}</span>
          {badge && (
            <span style={{ background: '#16A34A', color: '#fff', borderRadius: 999, padding: '2px 8px', fontSize: 10.5, fontWeight: 800 }}>
              {badge}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: BRAND.muted, marginTop: 3, lineHeight: 1.45 }}>{body}</div>
      </div>
    </Card>
  );
}

function timeOfDayGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function Dashboard() {
  const { user, preview, overview, overviewLoading, companyId, showToast } = usePortal();
  // In a staff preview there's no real person, so greet the organisation rather
  // than the synthetic "Preview" account name.
  const firstName = preview
    ? (preview.company?.name || null)
    : ((user?.name || '').split(' ')[0] || null);
  const projects = overview?.projects || [];
  const actionNeeded = overview?.actionNeeded || 0;

  const partnerInterest = async () => {
    try {
      await portalApi.post(`partner-interest?companyId=${encodeURIComponent(companyId)}`);
      showToast("Nice one — we'll be in touch about the Partner Programme ✓");
    } catch (err) {
      showToast(err.message);
    }
    window.open(PARTNER_URL, '_blank', 'noopener');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: BRAND.ink }}>
          {firstName ? `${timeOfDayGreeting()}, ${firstName} 👋` : `${timeOfDayGreeting()} 👋`}
        </h1>
        <p style={{ margin: '6px 0 0', fontSize: 14, color: BRAND.muted }}>
          {actionNeeded > 0
            ? <>You have <strong style={{ color: '#B45309' }}>{actionNeeded} project{actionNeeded === 1 ? '' : 's'} waiting on you</strong> — sorted in a couple of clicks below.</>
            : projects.length > 0
              ? 'Everything is moving — nothing needed from you right now.'
              : 'Your projects will appear here.'}
        </p>
      </div>

      <section>
        <SectionHeading>Your projects</SectionHeading>
        {overviewLoading && !overview ? (
          <Card><div style={{ color: BRAND.muted, fontSize: 13, textAlign: 'center', padding: 20 }}>Loading projects…</div></Card>
        ) : projects.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Film size={34} />}
              title="No live projects just yet"
              body="When a proposal is signed your project appears here with live status, review links and downloads."
              action={<a className="btn" href="#/request">Request a video — 10% off</a>}
            />
          </Card>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(340px, 100%), 1fr))', gap: 16 }}>
            {projects.map((p) => <ProjectCard key={p.id} project={p} />)}
          </div>
        )}
      </section>

      <section>
        <SectionHeading>Quick actions</SectionHeading>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 14 }}>
          <QuickAction
            Icon={Sparkles}
            title="Request a new video"
            badge="10% PORTAL DISCOUNT"
            body="Tell us what you need — portal requests get an exclusive 10% off the quote."
            onClick={() => { window.location.hash = '#/request'; }}
            accent="#16A34A"
          />
          <QuickAction
            Icon={Film}
            title="Video library"
            body="Watch and download every finished video we've made for you."
            onClick={() => { window.location.hash = '#/library'; }}
          />
          <QuickAction
            Icon={FolderOpen}
            title="Share brand guidelines"
            body="Upload logos, fonts and guidelines once — our team uses them on every project."
            onClick={() => { window.location.hash = '#/documents'; }}
          />
          <QuickAction
            Icon={Handshake}
            title="Partner Programme"
            body="Regular videos? Earn bigger discounts every month — tap to learn more and register interest."
            onClick={partnerInterest}
            accent="#7C3AED"
          />
        </div>
      </section>
    </div>
  );
}
