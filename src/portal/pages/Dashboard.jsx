// Portal home: per-project ball-in-court banners, phase progress and the
// quick actions (request-a-video with the 10% badge, partner programme).
import React from 'react';
import { BRAND } from '../../theme.js';
import { usePortal } from '../PortalContext.jsx';
import {
  Card, CourtBanner, PhaseTimeline, StatusPill, EmptyState, SectionHeading, ProjectTasks,
} from '../components.jsx';
import { Film, FolderOpen, Sparkles, Handshake, ChevronRight, Video, FileText, Wallet } from 'lucide-react';
import { portalApi } from '../api.js';
import { DEMO_STAGES, demoConfigured } from '../demo/stages.js';
import { demoProgress } from '../demo/store.js';
import { LEAD_MAGNET } from '../../lib/leadMagnet.js';

function BriefDraftCard({ draft }) {
  const when = draft.updatedAt ? new Date(draft.updatedAt) : null;
  const today = when && new Date().toDateString() === when.toDateString();
  return (
    <div style={{
      background: '#F3F9FC', border: '1px solid #CFE6F2', borderRadius: 12,
      padding: '16px 18px', display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
    }}>
      <FileText size={22} style={{ color: BRAND.blue, flexShrink: 0 }} />
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: BRAND.ink }}>
          {draft.projectName || 'Your video brief'} — {draft.pct}% done
        </div>
        <div style={{ fontSize: 13, color: BRAND.muted, marginTop: 2 }}>
          {draft.done} of {draft.total} answered
          {when && ` · saved ${today
            ? when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
            : when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
        </div>
        <div style={{
          height: 5, background: '#DCEAF2', borderRadius: 999,
          overflow: 'hidden', marginTop: 8, maxWidth: 320,
        }}>
          <div style={{ width: `${draft.pct}%`, height: '100%', background: BRAND.blue }} />
        </div>
      </div>
      <a className="btn" href="#/brief" style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}>
        Pick up where you left off
      </a>
    </div>
  );
}

// The sample project, rendered as a PROJECT — same card, same phase bar, same
// task list a real one gets.
//
// It started life as a link inside the "you have no projects" empty state,
// which made the most persuasive thing in the portal something you only found
// after reading that there was nothing here. Promoting it to a banner helped,
// but it still read as an advert sitting above the room rather than something
// in it.
//
// This is the version worth having: a prospect lands on the same screen a
// client lands on — a project waiting on them, with tasks to work down — and
// the tasks happen to be the sample ones. The demo stops being a tour of the
// portal and becomes a rehearsal of it, which is a far better argument.
function SampleProjectCard({ config, progress }) {
  const stages = DEMO_STAGES.filter((s) => s.ready(config));
  const done = stages.filter((s) => progress[s.key]?.tried).length;
  const openCount = stages.length - done;
  const allDone = openCount === 0;

  const tasks = stages.map((s) => ({
    key: s.key,
    title: s.taskTitle,
    detail: progress[s.key]?.tried ? s.doneDetail : s.taskDetail,
    status: progress[s.key]?.tried ? 'done' : 'todo',
    cta: { label: progress[s.key]?.tried ? 'Open again' : s.taskCta, href: `#/demo/${s.key}` },
  }));

  // The phase bar moves as they go, which quietly demonstrates the phase bar
  // itself. Honest within the sample's own fiction: storyboard sign-off really
  // is pre-production and the video review really is production.
  const phase = allDone ? 'completed' : progress.storyboard?.tried ? 'production' : 'pre_production';
  const stageLabel = allDone ? 'You’ve seen it all' : progress.storyboard?.tried ? 'Your cut is ready' : 'Your storyboard is ready';

  return (
    <Card
      onClick={() => { window.location.hash = '#/demo'; }}
      style={{ display: 'flex', flexDirection: 'column', gap: 14, borderColor: '#BFE0EE' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 16.5, fontWeight: 800, color: BRAND.ink }}>
              {config.title || 'Sample project'}
            </span>
            {/* Never let it be mistaken for a real job of theirs. */}
            <span style={{
              background: '#EAF6FB', color: '#0B6E93', border: '1px solid #BFE0EE', borderRadius: 999,
              padding: '2px 9px', fontSize: 10.5, fontWeight: 800, letterSpacing: 0.3, textTransform: 'uppercase',
            }}>
              Sample
            </span>
          </div>
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 3 }}>
            A made-up job, so you can try the bits you'd actually do
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {openCount > 0 && (
            <span style={{ background: '#FEF3C7', color: '#B45309', border: '1px solid #FDE68A', borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}>
              {openCount} to try
            </span>
          )}
          <ChevronRight size={18} color={BRAND.muted} style={{ marginTop: 4 }} />
        </div>
      </div>

      <div style={{ padding: '4px 2px' }}>
        <PhaseTimeline production={{ phase, stageLabel }} />
      </div>

      <CourtBanner
        nextStep={allDone
          ? {
            court: 'done',
            headline: 'That’s the whole review loop — both stages done.',
            cta: { label: 'Tell us what you’re making', href: '#/brief' },
          }
          : {
            court: 'you',
            headline: openCount === stages.length
              ? 'Have a go — everything here really works'
              : 'One left: see how the rest of it works',
          }}
        onCta={(cta) => runCta(cta, null)}
        compact
      />

      <div>
        <div style={{ fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.4, color: BRAND.muted, margin: '0 0 7px' }}>
          Your tasks{openCount > 0 ? ` · ${openCount} to do` : ' · all done ✅'}
        </div>
        <ProjectTasks tasks={tasks} onCta={(cta) => runCta(cta, null)} compact />
      </div>
    </Card>
  );
}

// The item/draft half of a standalone review link, as a hash query.
function reviewQuery(href) {
  const parts = [];
  for (const key of ['item', 'draft']) {
    const m = href?.match(new RegExp(`[?&]${key}=([^&]+)`));
    if (m) parts.push(`${key}=${m[1]}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

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
  // Keep review deep-links INSIDE the portal. deriveNextStep hands back the
  // standalone /?revision= / /?storyboard= links (right for emails), but a
  // logged-in client should stay in the portal chrome (with its back button)
  // rather than being dumped onto the standalone viewer.
  // …carrying &item=/&draft= across the rewrite, since they're what says WHICH
  // video and draft the CTA was about. Dropping them opened the project's
  // oldest video instead.
  const rev = cta.href?.match(/[?&]revision=([^&]+)/);
  if (rev) { window.location.hash = `#/review/${decodeURIComponent(rev[1])}${reviewQuery(cta.href)}`; return; }
  const sb = cta.href?.match(/[?&]storyboard=([^&]+)/);
  if (sb) { window.location.hash = `#/storyboard/${decodeURIComponent(sb[1])}${reviewQuery(cta.href)}`; return; }
  if (cta.href) window.location.href = cta.href; // proposal deep-links
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {project.openTasks > 0 && (
            <span style={{ background: '#FEF3C7', color: '#B45309', border: '1px solid #FDE68A', borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}>
              {project.openTasks} task{project.openTasks === 1 ? '' : 's'} to do
            </span>
          )}
          <ChevronRight size={18} color={BRAND.muted} style={{ marginTop: 4 }} />
        </div>
      </div>

      {project.inProduction && (
        <div style={{ padding: '4px 2px' }}>
          <PhaseTimeline production={project.production} />
        </div>
      )}

      {/* Suppress the banner when it's just echoing the task list below it. */}
      {!(project.nextStep?.fromTasks && project.tasks?.length > 0) && (
        <CourtBanner nextStep={project.nextStep} onCta={(cta) => runCta(cta, project.id)} compact />
      )}

      {project.tasks?.length > 0 && (
        <div>
          <div style={{ fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.4, color: BRAND.muted, margin: '0 0 7px' }}>
            Your tasks{project.openTasks > 0 ? ` · ${project.openTasks} to do` : ' · all done ✅'}
          </div>
          <ProjectTasks tasks={project.tasks} onCta={(cta) => runCta(cta, project.id)} compact />
        </div>
      )}

      {project.videos?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {project.videos.slice(0, 4).map((v) => (
            <span key={v.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: BRAND.ink }}>
              <Video size={13} color={BRAND.muted} />
              <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.title}</span>
              {/* Live board stage, not the vestigial per-video `status` (stuck "Not started"). */}
              {v.production?.stageLabel
                ? <StatusPill label={v.production.stageLabel} color={v.production.phaseColor || BRAND.blue} />
                : <StatusPill label={v.statusLabel} color={v.statusColor} />}
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
  const { user, preview, overview, overviewLoading, companyId, refreshOverview, isProspect } = usePortal();
  // Refetch whenever the client lands on Home so task / next-step / phase state
  // reflects anything that changed elsewhere (uploaded brand files, booked the
  // kick-off, or their project just moved to Completed after final payment)
  // without needing a full page refresh. Also refetch the moment they return to
  // the tab, so a change made while they were away shows up straight away.
  // refreshOverview keeps the previous data on screen during the fetch (no flash).
  React.useEffect(() => {
    if (!companyId) return undefined;
    refreshOverview(companyId).catch(() => {});
    const onActive = () => { if (document.visibilityState !== 'hidden') refreshOverview(companyId).catch(() => {}); };
    window.addEventListener('focus', onActive);
    document.addEventListener('visibilitychange', onActive);
    return () => {
      window.removeEventListener('focus', onActive);
      document.removeEventListener('visibilitychange', onActive);
    };
  }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps
  // In a staff preview there's no real person, so greet the organisation rather
  // than the synthetic "Preview" account name.
  const firstName = preview
    ? (preview.company?.name || null)
    : ((user?.name || '').split(' ')[0] || null);
  const projects = overview?.projects || [];
  const actionNeeded = overview?.actionNeeded || 0;

  // The sample project stands in for a real one while a prospect hasn't got
  // one. Only fetched for them — a paying client should never pay a round trip
  // for something they'll never be shown.
  const [demoConfig, setDemoConfig] = React.useState(null);
  React.useEffect(() => {
    if (!isProspect) return;
    portalApi.get('demo-project').then((d) => setDemoConfig(d?.demo || {})).catch(() => setDemoConfig({}));
  }, [isProspect]);
  // Read once on mount: the page unmounts while they're inside a stage, so it
  // is re-read on the way back with their ticks up to date.
  const demoDone = React.useMemo(() => demoProgress(), []);
  const showSample = isProspect && projects.length === 0 && demoConfigured(demoConfig);
  const sampleOpen = showSample
    ? DEMO_STAGES.filter((s) => s.ready(demoConfig) && !demoDone[s.key]?.tried).length
    : 0;

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
              // Don't tell someone their projects will appear here while a
              // project card is sitting right underneath the sentence.
              : showSample
                ? sampleOpen > 0
                  ? <>Your real projects land here once we're underway. Until then, here's <strong>a sample one to try</strong> — it works exactly like the real thing.</>
                  : "You've been through the whole review loop. Ready to do it for real?"
                : 'Your projects will appear here.'}
        </p>
      </div>

      {/* An unfinished brief, surfaced where they land. This is the single
          thing most likely to bring someone back to finish it — a draft nobody
          is reminded about is a draft nobody completes, and a half-finished
          brief is already a warmer lead than a form that was never opened. */}
      {overview?.briefDraft && <BriefDraftCard draft={overview.briefDraft} />}

      {/* Credit, offered at the moment it starts making sense: they have a
          project, so a style exists to repeat, and they haven't bought any yet.
          Deliberately quiet and carries no number — the rate lives one click
          away on a page they can now reach. */}
      {overview?.suggestCredit && (
        <div style={{
          background: '#fff', border: `1px solid ${BRAND.border}`, borderRadius: 12,
          padding: '14px 18px', display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
        }}>
          <Wallet size={20} style={{ color: BRAND.blue, flexShrink: 0 }} />
          <div style={{ flex: '1 1 260px', minWidth: 0, fontSize: 13.5, lineHeight: 1.55, color: BRAND.ink }}>
            <strong>Planning more like this?</strong>{' '}
            <span style={{ color: BRAND.muted }}>
              Now we've got your style, buying production time as a block works out cheaper
              than quoting each one separately.
            </span>
          </div>
          <a className="btn-ghost" href="#/video-credit" style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}>
            See how it works
          </a>
        </div>
      )}

      <section>
        <SectionHeading>Your projects</SectionHeading>
        {overviewLoading && !overview ? (
          <Card><div style={{ color: BRAND.muted, fontSize: 13, textAlign: 'center', padding: 20 }}>Loading projects…</div></Card>
        ) : showSample ? (
          // A prospect gets the sample IN PLACE of the empty state, so they
          // land on a populated Projects screen rather than being told there's
          // nothing here and offered a link to somewhere else.
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SampleProjectCard config={demoConfig} progress={demoDone} />
            <div style={{ fontSize: 12.5, color: BRAND.muted, lineHeight: 1.6 }}>
              Nothing you do in the sample reaches anyone, and it resets when you close the tab.
              Your own projects appear here the moment a proposal is signed —{' '}
              <a href="#/brief" style={{ color: BRAND.blue, fontWeight: 600 }}>start a brief</a>
              {' or '}
              <a href="#/course" style={{ color: BRAND.blue, fontWeight: 600 }}>watch {LEAD_MAGNET.shortNoun}</a> first.
            </div>
          </div>
        ) : projects.length === 0 ? (
          <Card>
            {/* Most people seeing this arrived from the guide and have no
                project by definition — so lead with the thing they actually
                came for, and keep "request a video" as the quieter option. */}
            <EmptyState
              icon={<Film size={34} />}
              title="No live projects just yet"
              body={`When a proposal is signed your project appears here with live status, review links and downloads. In the meantime, ${LEAD_MAGNET.shortNoun} is all yours.`}
              action={
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  {/* Prospects already have the sample project offered above
                      in its own card — repeating it here just splits the eye. */}
                  {!isProspect && <a className="btn" href="#/demo">Take the sample project tour</a>}
                  <a className="btn-ghost" href="#/course">Watch {LEAD_MAGNET.shortNoun}</a>
                  <a className="btn-ghost" href="#/request">Request a video</a>
                </div>
              }
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
            badge="10% OFF FUTURE VIDEOS"
            body="Tell us what you need — future videos requested through the portal get an exclusive 10% off the quote."
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
            body="Making videos regularly? Bank monthly credits and spend them at your pace."
            onClick={() => { window.location.hash = '#/partner'; }}
            accent="#7C3AED"
          />
        </div>
      </section>
    </div>
  );
}
