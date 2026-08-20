// Customer portal shell: boot dispatch (invite / magic-link / reset query
// params), hash routing (same convention as the CRM SPA — no router dep) and
// the authenticated chrome (header, org switcher, nav, mobile tab bar).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BRAND } from '../theme.js';
import { SQUIDEO_LOGO } from '../defaults.js';
import { useIsMobile } from '../utils.js';
import { Toast } from '../components/ui.jsx';
import {
  Home, Film, FolderOpen, Sparkles, Users, Settings as SettingsIcon, PlusCircle, LogOut, Wallet, UserPlus, GraduationCap, FileText, Handshake, MoreHorizontal, X as XIcon,
} from 'lucide-react';
import { Eye, PencilLine, FlaskConical } from 'lucide-react';
import { PortalProvider, usePortal } from './PortalContext.jsx';
import ClientLogo from './ClientLogo.jsx';
import NotificationBell from './NotificationBell.jsx';
import { portalApi, setPreviewToken } from './api.js';
import { getDemoState, DEMO_STATES } from './demo/portalDemo.js';
import Login from './pages/Login.jsx';
import AcceptInvite from './pages/AcceptInvite.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ProjectDetail from './pages/ProjectDetail.jsx';
import Library from './pages/Library.jsx';
import Documents from './pages/Documents.jsx';
import Extras from './pages/Extras.jsx';
import Voiceover from './pages/Voiceover.jsx';
import Kickoff from './pages/Kickoff.jsx';
import Script from './pages/Script.jsx';
import RequestVideo from './pages/RequestVideo.jsx';
import Team from './pages/Team.jsx';
import Settings from './pages/Settings.jsx';
import Review from './pages/Review.jsx';
import Storyboard from './pages/Storyboard.jsx';
import VideoCredit from './pages/VideoCredit.jsx';
import Course from './pages/Course.jsx';
import Brief from './pages/Brief.jsx';
import Partner from './pages/Partner.jsx';
import DemoProject from './pages/DemoProject.jsx';
import { sampleSeen, markSampleSeen } from './demo/store.js';
import { LEAD_MAGNET } from '../lib/leadMagnet.js';

const MAX_WIDTH = 1080;
// The left rail, plus the gap to the content. The shell is widened by exactly
// this much so the content column keeps the width every page was designed
// against — otherwise adding the rail would have quietly narrowed every table
// and player in the portal.
// Wide enough for the longest label — "Partner Programme" at 14px — to sit on
// one line. The shell max below grows by the same amount, so widening the rail
// costs the content column nothing.
const SIDEBAR_W = 224;
const SIDEBAR_GAP = 26;
const SHELL_MAX = MAX_WIDTH + SIDEBAR_W + SIDEBAR_GAP;

// #/view/param?a=b — the query is optional and only the review pages use it
// (?item=/?draft= say which video/storyboard/draft a link was sent about), but
// it's parsed centrally so it never leaks into `param`.
function parseHash() {
  const raw = (window.location.hash || '').replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const h = qi === -1 ? raw : raw.slice(0, qi);
  const query = new URLSearchParams(qi === -1 ? '' : raw.slice(qi + 1));
  const [view, ...rest] = h.split('/');
  return { view: view || 'home', param: rest.join('/') || null, query };
}

export function navigate(hash) {
  window.location.hash = hash;
}

const NAV = [
  // shortLabel is what the mobile tab bar uses — "Current projects" doesn't fit
  // under an icon at phone width.
  //
  // mobilePrimary:true earns an item its own tab in the phone bar. The bar lays
  // items out evenly with no scroll, so past about six they stop being tappable
  // — everything else goes behind "More" rather than being dropped. The old
  // mobile:false hid three sections from phones outright, which meant they were
  // reachable only by typing a hash: the portal is an installable PWA, so every
  // section has to be reachable at phone width.
  //
  // The five primaries cover both arrivals: a prospect lives in Course and
  // Brief, a client in Projects, Library and New video.
  // Ordered for the way people now ARRIVE, not for how a long-standing client
  // uses it. Most new accounts come in through the course, so the course and
  // then the brief sit above Current projects — for a prospect that page is
  // empty, and an empty first screen is a bad first impression. A client with
  // live work reaches their projects in one more glance; a prospect who lands
  // on nothing may not come back at all.
  // Named from LEAD_MAGNET so the rail, the landing page and the button on
  // squideo.com can't drift apart. "Free" is dropped in here: they've already
  // got it, and still selling it to someone who owns it reads badly.
  { view: 'course', label: LEAD_MAGNET.navLabel, shortLabel: LEAD_MAGNET.navShort, hash: '#/course', Icon: GraduationCap, mobilePrimary: true },
  { view: 'brief', label: 'Brief Builder', shortLabel: 'Brief', hash: '#/brief', Icon: FileText, mobilePrimary: true },
  // Shown to everyone, badged until they've opened it once. It was prospect-only
  // and buried in an empty state, which meant the best thing in the portal was
  // invisible to most of the people in it — including every client waiting on a
  // first draft, who is exactly the person wondering what reviewing one is like.
  // Sits directly under the brief because that's the order the funnel runs in:
  // read the course, describe the job, then see what working with us feels like.
  { view: 'demo', label: 'Sample project', shortLabel: 'Sample', hash: '#/demo', Icon: Sparkles, needsSample: true },
  { view: 'home', label: 'Current projects', shortLabel: 'Projects', hash: '#/', Icon: Home, mobilePrimary: true },
  { view: 'library', label: 'Your Video Library', shortLabel: 'Library', hash: '#/library', Icon: Film, mobilePrimary: true },
  { view: 'video-credit', label: 'Video credit', hash: '#/video-credit', Icon: Wallet },
  // Sits under Video credit because it's the same idea committed to monthly.
  // Unlike Video credit it shows no rate — the plan is scoped on a call — so
  // it needs no prospect gate.
  { view: 'partner', label: 'Partner Programme', shortLabel: 'Partner', hash: '#/partner', Icon: Handshake },
  { view: 'documents', label: 'Documents', hash: '#/documents', Icon: FolderOpen },
  { view: 'request', label: 'New video', hash: '#/request', Icon: PlusCircle, highlight: true, mobilePrimary: true },
  // shortLabel matters here now the full labels are possessive — "Your Video
  // Library" under a phone tab-bar icon would wrap to three lines.
  { view: 'team', label: 'Your Team', shortLabel: 'Team', hash: '#/team', Icon: Users },
  { view: 'settings', label: 'Settings', hash: '#/settings', Icon: SettingsIcon },
];

// One filter, used by both the rail and the phone tab bar, so a section can't
// end up hidden in one and visible in the other.
//
// `video-credit` is the rate card, and it belongs to clients: credit is the rung
// AFTER a first project, when a style exists to repeat. A video-guide signup
// has a `prospect` org and shouldn't be shown £/min before we've scoped
// anything — that number would anchor every quote they get afterwards. The
// real enforcement is CLIENT_ONLY in api/portal.js; this is the door.
function visibleNav(company, sampleAvailable = false) {
  // `creditVisible` is resolved server-side from the company's override plus
  // the default rule, so the nav can't disagree with the API guard. Undefined
  // (an older session payload) falls through to visible rather than hiding a
  // paying client's own balance.
  const hideCredit = company?.creditVisible === false;
  // The sample project appears for everyone, but only once there's something in
  // it — see the `sampleProject` flag on /api/portal/me.
  return NAV.filter((n) => !(hideCredit && n.view === 'video-credit'))
    .filter((n) => !(n.needsSample && !sampleAvailable));
}

// Header actions. The primary is the blue call-to-action; secondaries are
// outlined so they read as buttons against the navy chrome without competing.
const HEADER_BTN = {
  primary: {
    display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap',
    padding: '8px 15px', borderRadius: 8, textDecoration: 'none',
    fontSize: 13.5, fontWeight: 700, color: '#0F2A3D', background: BRAND.blue,
  },
  secondary: {
    display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap',
    padding: '7px 13px', borderRadius: 8, textDecoration: 'none',
    fontSize: 13, fontWeight: 600, color: '#DCEEF7',
    background: '#1B3A50', border: '1px solid #2E546E',
  },
};

function Header() {
  const { user, companyId, setActiveCompanyId, logout, company: activeCompany } = usePortal();
  const isMobile = useIsMobile();
  const companies = user?.companies || [];
  return (
    <header style={{
      background: BRAND.ink,
      padding: isMobile ? '10px 16px' : '12px 24px',
      position: 'sticky', top: 0, zIndex: 40,
    }}>
      {/* Wraps rather than overflows: three action buttons plus the org
          switcher and account controls is a lot for one row on a laptop. */}
      <div style={{
        maxWidth: SHELL_MAX, margin: '0 auto',
        display: 'flex', alignItems: 'center', gap: 10, rowGap: 8, flexWrap: 'wrap',
      }}>
        <a href="#/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
          <img src={SQUIDEO_LOGO} alt="Squideo" style={{ height: isMobile ? 26 : 30, display: 'block' }} />
          {!isMobile && (
            <span style={{ color: '#9FDFF5', fontSize: 13, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' }}>
              Client Portal
            </span>
          )}
        </a>
        {activeCompany?.logoUrl && (
          <>
            <span style={{ width: 1, height: isMobile ? 20 : 26, background: '#2E546E' }} />
            <ClientLogo
              src={activeCompany.logoUrl}
              alt={activeCompany.name}
              height={isMobile ? 18 : 22}
              maxWidth={isMobile ? 90 : 150}
            />
          </>
        )}
        <div style={{ flex: 1 }} />
        {companies.length > 1 && (
          <select
            className="input"
            value={companyId || ''}
            onChange={(e) => setActiveCompanyId(e.target.value)}
            style={{ maxWidth: 180, background: '#1B3A50', color: '#fff', border: '1px solid #2E546E', borderRadius: 8, padding: '6px 8px', fontSize: 13 }}
          >
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        {/* The three things a client most often comes here to DO. Secondary
            styling on the two supporting actions keeps "New video" the primary.
            Mobile reaches all three through the tab bar instead — the header
            has no room for them at that width. */}
        {!isMobile && (
          <>
            <a href="#/team" style={HEADER_BTN.secondary}>
              <UserPlus size={15} /> Invite team
            </a>
            {/* Prospects don't see the rate card — see CLIENT_ONLY in
                api/portal.js for why, and for the check that actually enforces
                it. This just keeps the door out of sight. */}
            {activeCompany?.creditVisible !== false && (
              <a href="#/video-credit" style={HEADER_BTN.secondary}>
                <Wallet size={15} /> Order credit
              </a>
            )}
            <a href="#/request" style={HEADER_BTN.primary}>
              <PlusCircle size={15} /> New video
            </a>
          </>
        )}
        {/* Two bells, the CRM's own arrangement: the specialised feed to the
            left of the standard one. Tasks hides itself when there's nothing
            outstanding, so most clients most of the time see just the bell. */}
        <NotificationBell channel="tasks" compact={isMobile} />
        <NotificationBell channel="updates" compact={isMobile} />
        {!isMobile && (
          <span style={{ color: '#B9CBD6', fontSize: 13 }}>{user?.name || user?.email}</span>
        )}
        <button
          onClick={logout}
          title="Sign out"
          style={{ background: 'none', border: 'none', color: '#B9CBD6', cursor: 'pointer', padding: 6, display: 'flex' }}
        >
          <LogOut size={17} />
        </button>
      </div>
    </header>
  );
}

// The desktop navigation, as a left rail rather than a row under the header.
//
// A row forced every item onto one line, which capped how many there could be
// and made each new one a fight for horizontal space. A rail grows downwards,
// so the labels can stay full words ("Brief Builder", not "Brief") and adding
// a section later costs nothing. Light on the paper background rather than a
// second dark band — one navy area at the top reads as the chrome; two starts
// to feel like the content is boxed in.
//
// Phones keep the bottom tab bar; a rail at that width would eat a third of
// the screen.
// The unread-style count on a nav item. Deliberately the same red pill the
// notification bell uses: a client already reads that shape as "something here
// wants me", and inventing a second visual language for the same idea would
// just be a second thing to learn.
function NavBadge({ count, style }) {
  if (!count) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999,
      background: '#DC2626', color: '#fff', fontSize: 11, fontWeight: 800,
      lineHeight: 1, flexShrink: 0, ...style,
    }}>
      {count}
    </span>
  );
}

function SideNav({ view, company, sampleAvailable, sampleBadge }) {
  return (
    <nav style={{
      width: SIDEBAR_W, flexShrink: 0, alignSelf: 'flex-start',
      position: 'sticky', top: 18, padding: '4px 0',
      display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      {visibleNav(company, sampleAvailable).filter((n) => n.view !== 'request').map(({ view: v, label, hash, Icon }) => {
        const active = view === v || (v === 'home' && view === 'project');
        const badge = v === 'demo' ? sampleBadge : 0;
        return (
          <a
            key={v}
            href={hash}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 13px', borderRadius: 9, textDecoration: 'none',
              // A label that outgrows the rail on some font stack wraps to a
              // second line rather than spilling out of its own background.
              lineHeight: 1.3,
              fontSize: 14, fontWeight: active ? 700 : 500,
              color: active ? BRAND.ink : '#61798A',
              background: active ? '#fff' : 'transparent',
              border: `1px solid ${active ? BRAND.border : 'transparent'}`,
              // The active item is the one thing that should read instantly at
              // a glance, so it gets the accent bar as well as the weight.
              boxShadow: active ? `inset 3px 0 0 ${BRAND.blue}` : 'none',
            }}
          >
            {/* flexShrink:0 — a two-line label must squash the text box, never
                the icon, or the row's icons stop lining up with each other. */}
            <Icon size={17} strokeWidth={active ? 2.3 : 2} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
            <NavBadge count={badge} />
          </a>
        );
      })}
    </nav>
  );
}

const tabStyle = (active, highlight) => ({
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
  padding: '9px 6px 7px', textDecoration: 'none', minWidth: 52,
  color: highlight ? BRAND.blue : active ? BRAND.ink : BRAND.muted,
});

function MobileTabBar({ view, company, sampleAvailable, sampleBadge }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const items = visibleNav(company, sampleAvailable);
  const primary = items.filter((n) => n.mobilePrimary);
  const overflow = items.filter((n) => !n.mobilePrimary);
  // "More" lights up when the section you're actually in lives behind it —
  // otherwise the bar would show nothing selected and you'd have no idea where
  // you were.
  const inOverflow = overflow.some((n) => n.view === view);

  // Close on navigation. The sheet is rendered by the shell, not the page, so
  // it survives a hash change and would otherwise stay open over the new page.
  useEffect(() => { setMoreOpen(false); }, [view]);

  return (
    <>
      {moreOpen && (
        <>
          {/* Deliberately not click-to-close: consistent with the rest of the
              app's dialogs. There are three ways out — the X, tapping More
              again, and picking anything in the list. */}
          <div style={{
            position: 'fixed', inset: 0, zIndex: 45, background: 'rgba(15,42,61,.45)',
          }} />
          <div style={{
            position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 46,
            background: '#fff', borderRadius: '16px 16px 0 0',
            padding: '8px 8px calc(12px + env(safe-area-inset-bottom))',
            boxShadow: '0 -8px 30px rgba(15,42,61,.18)',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 10px 10px',
            }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink }}>More</span>
              <button
                type="button" aria-label="Close" onClick={() => setMoreOpen(false)}
                style={{
                  background: 'none', border: 'none', padding: 8, cursor: 'pointer',
                  color: BRAND.muted, display: 'flex',
                }}
              ><XIcon size={18} /></button>
            </div>
            {overflow.map(({ view: v, label, hash, Icon }) => {
              const active = view === v;
              return (
                <a key={v} href={hash} onClick={() => setMoreOpen(false)} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '13px 12px', textDecoration: 'none', borderRadius: 10,
                  color: active ? BRAND.ink : '#5A7382',
                  background: active ? '#EAF7FD' : 'transparent',
                  fontSize: 15, fontWeight: active ? 700 : 500,
                }}>
                  <Icon size={19} strokeWidth={active ? 2.4 : 2} />
                  <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
                  <NavBadge count={v === 'demo' ? sampleBadge : 0} />
                </a>
              );
            })}
          </div>
        </>
      )}

      <nav style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 47,
        background: '#fff', borderTop: `1px solid ${BRAND.border}`,
        display: 'flex', justifyContent: 'space-around',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        {primary.map(({ view: v, label, shortLabel, hash, Icon, highlight }) => {
          const active = view === v || (v === 'home' && view === 'project');
          return (
            <a key={v} href={hash} style={tabStyle(active, highlight)}>
              <Icon size={20} strokeWidth={active || highlight ? 2.4 : 2} />
              <span style={{ fontSize: 10, fontWeight: active ? 700 : 500 }}>{shortLabel || label}</span>
            </a>
          );
        })}
        {overflow.length > 0 && (
          <button
            type="button"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((o) => !o)}
            style={{
              ...tabStyle(moreOpen || inOverflow, false),
              background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              position: 'relative',
            }}
          >
            <MoreHorizontal size={20} strokeWidth={moreOpen || inOverflow ? 2.4 : 2} />
            {/* The badged section lives behind this button, so without a mark
                here the nudge is invisible on a phone — which is where most of
                this portal is actually read. */}
            {sampleBadge > 0 && overflow.some((n) => n.view === 'demo') && (
              <NavBadge count={sampleBadge} style={{ position: 'absolute', top: 4, right: 8 }} />
            )}
            <span style={{ fontSize: 10, fontWeight: moreOpen || inOverflow ? 700 : 500 }}>More</span>
          </button>
        )}
      </nav>
    </>
  );
}

function AuthedApp() {
  const {
    toast, companyId, preview, user, company: activeCompany, sampleAvailable, refreshNotifications,
  } = usePortal();
  const isMobile = useIsMobile();
  const [route, setRoute] = useState(parseHash);
  // The badge is a one-time "there's something here you haven't seen", so it
  // clears the moment they land on the section — not when they finish the tour.
  // Its job is to get them to look once, and it has done that job by then.
  const [sampleBadge, setSampleBadge] = useState(() => (sampleSeen() ? 0 : 1));

  useEffect(() => {
    if (route.view !== 'demo') return;
    markSampleSeen();
    setSampleBadge(0);
  }, [route.view]);

  useEffect(() => {
    const onHash = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Re-derive the bell's task list when they move between sections. The pages
  // that COMPLETE a task (documents, script, kick-off, voiceover) are the ones
  // they navigate away from afterwards, and a task they've just finished still
  // sitting in the bell is precisely the staleness that keeping tasks out of
  // the stored feed was meant to avoid. Skips the first run — the provider has
  // already fetched them on mount.
  const navigatedOnce = React.useRef(false);
  useEffect(() => {
    if (!navigatedOnce.current) { navigatedOnce.current = true; return; }
    refreshNotifications?.({ withTasks: true }).catch(() => {});
  }, [route.view]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the team what the client is looking at. Silent and best-effort — this
  // must never interrupt them. Staff sessions are skipped outright so browsing
  // a client's portal doesn't show up as the client browsing it.
  useEffect(() => {
    if (preview) return;
    portalApi.post('track', {
      view: route.view,
      companyId,
      dealId: ['project', 'extras', 'voiceover', 'kickoff', 'script'].includes(route.view) ? route.param : null,
    }).catch(() => {});
  }, [route.view, route.param, companyId, preview]);

  let page;
  switch (route.view) {
    case 'project': page = <ProjectDetail dealId={route.param} />; break;
    case 'review': page = <Review token={route.param} itemId={route.query?.get('item') || null} draftId={route.query?.get('draft') || null} />; break;
    case 'storyboard': page = <Storyboard token={route.param} itemId={route.query?.get('item') || null} draftId={route.query?.get('draft') || null} />; break;
    case 'course': page = <Course slug={route.param} />; break;
    case 'brief': page = <Brief briefId={route.param} />; break;
    case 'demo': page = <DemoProject stage={route.param} />; break;
    case 'library': page = <Library />; break;
    case 'documents': page = <Documents />; break;
    case 'extras': page = <Extras dealId={route.param} />; break;
    case 'voiceover': page = <Voiceover dealId={route.param} />; break;
    case 'kickoff': page = <Kickoff dealId={route.param} />; break;
    case 'script': page = <Script dealId={route.param} />; break;
    case 'request': page = <RequestVideo />; break;
    case 'video-credit': page = <VideoCredit />; break;
    case 'partner': page = <Partner />; break;
    case 'team': page = <Team />; break;
    case 'settings': page = <Settings />; break;
    default: page = <Dashboard />;
  }

  // The review surfaces (video/storyboard) are their own full-height apps with a
  // fixed comment sidebar — squeezing them into the 1080px content column made
  // the player narrow while its height stayed tall, letterboxing the video with
  // huge dark bands. Render them full-bleed and let them fill the space under
  // the nav instead.
  // The sample project's OVERVIEW is an ordinary portal page and scrolls; only
  // its two review stages (#/demo/storyboard, #/demo/video) take over the
  // screen. Full-bleeding the overview too would clip it at the viewport.
  const fullBleed = route.view === 'review' || route.view === 'storyboard'
    || (route.view === 'demo' && !!route.param);

  return (
    // On review routes the shell is pinned to exactly the viewport height (and
    // clips overflow) so the player has a BOUNDED height to scale down into —
    // with the normal minHeight:100vh the shell just grows with a tall video and
    // the player runs off the bottom of the screen. Other routes keep the normal
    // grow-and-scroll behaviour.
    <div style={{
      ...(fullBleed ? { height: '100vh', overflow: 'hidden' } : { minHeight: '100vh' }),
      background: BRAND.paper, display: 'flex', flexDirection: 'column',
    }}>
      <DemoBanner />
      <PreviewBanner />
      <Header />
      {fullBleed ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {page}
        </div>
      ) : (
        <div style={{
          maxWidth: SHELL_MAX, margin: '0 auto', width: '100%',
          display: 'flex', gap: isMobile ? 0 : SIDEBAR_GAP,
          padding: isMobile ? '18px 16px 90px' : '22px 24px 60px',
          boxSizing: 'border-box', alignItems: 'flex-start',
        }}>
          {!isMobile && (
            <SideNav
              view={route.view}
              company={activeCompany}
              sampleAvailable={sampleAvailable}
              sampleBadge={sampleBadge}
            />
          )}
          {/* minWidth:0 matters — without it a wide table or a long unbroken
              string inside the page pushes the whole flex row wider than the
              shell and the rail slides off to the left. */}
          <main style={{ flex: 1, minWidth: 0 }}>
            {page}
          </main>
        </div>
      )}
      {isMobile && (
        <MobileTabBar
          view={route.view}
          company={activeCompany}
          sampleAvailable={sampleAvailable}
          sampleBadge={sampleBadge}
        />
      )}
      {toast && <Toast msg={toast} />}
    </div>
  );
}

// Persistent bar shown only when staff are inside a client's portal. Read-only
// preview is purple and says so; manage mode is amber — the warning colour —
// because everything done from there is real and lands on the client's account.
// Demo mode says so, loudly and permanently. Everything on screen is
// invented (see demo/portalDemo.js) and none of it can reach the database —
// but a portal that LOOKS real and is not is exactly the thing that must
// never be mistaken for a customer's own, so it is labelled on every page
// rather than only where it was opened from.
function DemoBanner() {
  const state = getDemoState();
  if (!state) return null;
  const meta = DEMO_STATES.find((x) => x.id === state);
  return (
    <div style={{
      background: '#0F2A3D', color: '#fff', padding: '8px 16px',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      fontSize: 13, fontWeight: 600, flexWrap: 'wrap', textAlign: 'center',
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        <FlaskConical size={15} />
        Demo portal — nothing here is real.
        <span style={{ fontWeight: 500, opacity: 0.85 }}>
          Showing a client {meta ? meta.label.toLowerCase() : 'in progress'}.
        </span>
      </span>
    </div>
  );
}

function PreviewBanner() {
  const { preview, showToast } = usePortal();
  const [switching, setSwitching] = useState(false);
  if (!preview) return null;
  const manage = preview.manage === true;
  const exit = () => {
    setPreviewToken(null);
    // Closing the tab is the natural exit; if it can't self-close (not
    // script-opened), fall back to a neutral page.
    window.close();
    window.setTimeout(() => { window.location.href = 'about:blank'; }, 150);
  };

  // Flip between read-only and manage without going back to the CRM. The new
  // token is minted by the CRM endpoint, which re-checks the staff session
  // (HttpOnly sq_session cookie, same origin) and their portal-admin
  // permission — so this is a request to be upgraded, never a self-grant.
  const switchMode = async () => {
    setSwitching(true);
    try {
      const res = await fetch('/api/crm/portal-admin?op=preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ companyId: preview.company?.id, manage: !manage }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || 'Could not switch mode');
      const token = new URL(json.url, window.location.origin).searchParams.get('preview');
      if (!token) throw new Error('Could not switch mode');
      // Swap the per-tab token and reload in place, so we stay on this page.
      setPreviewToken(token);
      window.location.reload();
    } catch (err) {
      showToast(
        err.message === 'Unauthorised' || err.message === 'Session expired'
          ? 'Sign in to the CRM in this browser first, then try again.'
          : err.message
      );
      setSwitching(false);
    }
  };

  const who = preview.company?.name || 'this client';
  const btn = {
    background: 'rgba(255,255,255,0.2)', color: '#fff', border: 'none', borderRadius: 6,
    padding: '4px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
  };
  return (
    <div style={{
      background: manage ? '#B45309' : '#7C3AED', color: '#fff', padding: '8px 16px',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      fontSize: 13, fontWeight: 600, flexWrap: 'wrap', textAlign: 'center',
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        {manage ? <PencilLine size={15} /> : <Eye size={15} />}
        {manage
          ? <>Manage mode — you’re editing {who}’s portal for real. Payments, extras and their account settings stay locked.</>
          : <>Preview — you’re viewing {who}’s portal as they’d see it. Changes are disabled.</>}
      </span>
      <button onClick={switchMode} disabled={switching} style={{ ...btn, background: manage ? 'rgba(255,255,255,0.2)' : '#fff', color: manage ? '#fff' : '#5B21B6' }}>
        {switching ? 'Switching…' : manage ? 'Back to read-only' : 'Switch to manage mode'}
      </button>
      <button onClick={exit} style={btn}>
        {manage ? 'Exit manage mode' : 'Exit preview'}
      </button>
    </div>
  );
}

// A shared preview link opened by someone the server wouldn't issue a preview
// to — usually not signed in to the CRM in this browser, sometimes a role
// without portal.preview. Says which, and offers the way forward.
function PreviewLinkError({ message }) {
  const needsSignIn = /unauthoris|session expired/i.test(message);
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: BRAND.paper, padding: 20 }}>
      <div style={{
        maxWidth: 440, background: '#fff', border: `1px solid ${BRAND.border}`,
        borderRadius: 14, padding: 28, textAlign: 'center',
      }}>
        <div style={{ width: 46, height: 46, borderRadius: 12, background: '#F3E8FF', color: '#7C3AED', display: 'grid', placeItems: 'center', margin: '0 auto 14px' }}>
          <Eye size={22} />
        </div>
        <h1 style={{ margin: '0 0 8px', fontSize: 19, fontWeight: 800, color: BRAND.ink }}>
          {needsSignIn ? 'Sign in to view this preview' : 'Preview unavailable'}
        </h1>
        <p style={{ margin: '0 0 18px', fontSize: 13.5, color: BRAND.muted, lineHeight: 1.55 }}>
          {needsSignIn
            ? 'This link shows a client’s portal to Squideo team members. Sign in to the CRM in this browser, then open the link again.'
            : message}
        </p>
        {needsSignIn && (
          <a href="/" className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
            Go to the Squideo CRM
          </a>
        )}
      </div>
    </div>
  );
}

function Boot() {
  const { booting, user, refreshSession, showToast } = usePortal();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const inviteToken = params.get('invite');
  const magicToken = params.get('login');
  const resetToken = params.get('reset');
  // A shared preview link: ?previewOf=<companyId>, carrying no credential of
  // its own. Whoever opens it gets a preview only if THEY are signed in to the
  // CRM with the right role.
  const previewOf = params.get('previewOf');
  const [magicState, setMagicState] = useState(magicToken ? 'pending' : null);
  const [previewState, setPreviewState] = useState(previewOf ? 'pending' : null);

  const clearQuery = useCallback(() => {
    window.history.replaceState(null, '', window.location.pathname + (window.location.hash || ''));
  }, []);

  // Magic-link consume: one shot on load, then drop the token from the URL.
  useEffect(() => {
    if (!magicToken) return;
    (async () => {
      try {
        await portalApi.post('auth?op=magic-consume', { token: magicToken });
        await refreshSession();
        showToast('Signed in ✓');
        setMagicState('done');
      } catch (err) {
        setMagicState('failed:' + (err.message || 'This link has expired.'));
      } finally {
        clearQuery();
      }
    })();
  }, [magicToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve a shared preview link against the viewer's own CRM session. The
  // endpoint re-checks their role, so the link grants nothing by itself.
  useEffect(() => {
    if (!previewOf) return;
    (async () => {
      try {
        const res = await fetch('/api/crm/portal-admin?op=preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ companyId: previewOf }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || 'Preview unavailable');
        const token = new URL(json.url, window.location.origin).searchParams.get('preview');
        if (!token) throw new Error('Preview unavailable');
        setPreviewToken(token);
        clearQuery();
        await refreshSession();
        setPreviewState('done');
      } catch (err) {
        setPreviewState('failed:' + (err.message || 'Preview unavailable'));
      }
    })();
  }, [previewOf]); // eslint-disable-line react-hooks/exhaustive-deps

  if (booting || magicState === 'pending' || previewState === 'pending') {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: BRAND.paper }}>
        <div style={{ color: BRAND.muted, fontSize: 14 }}>
          {previewState === 'pending' ? 'Opening the client’s portal…' : 'Loading your portal…'}
        </div>
      </div>
    );
  }

  if (typeof previewState === 'string' && previewState.startsWith('failed:')) {
    return <PreviewLinkError message={previewState.slice(7)} />;
  }
  // An authenticated session wins over a stale ?invite= / ?reset= token: those
  // are read once at boot, so after accepting an invite (which signs you in)
  // this is what takes you into the portal instead of leaving you looking at
  // the consumed invite form.
  if (user) return <AuthedApp />;
  if (inviteToken) return <AcceptInvite token={inviteToken} onDone={clearQuery} />;
  if (resetToken) return <ResetPassword token={resetToken} onDone={clearQuery} />;

  const magicError = typeof magicState === 'string' && magicState.startsWith('failed:')
    ? magicState.slice(7) : null;
  return <Login initialError={magicError} />;
}

export default function PortalApp() {
  return (
    <PortalProvider>
      <Boot />
    </PortalProvider>
  );
}
