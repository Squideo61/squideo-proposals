// Customer portal shell: boot dispatch (invite / magic-link / reset query
// params), hash routing (same convention as the CRM SPA — no router dep) and
// the authenticated chrome (header, org switcher, nav, mobile tab bar).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BRAND } from '../theme.js';
import { SQUIDEO_LOGO } from '../defaults.js';
import { useIsMobile } from '../utils.js';
import { Toast } from '../components/ui.jsx';
import {
  Home, Film, FolderOpen, Sparkles, Users, Settings as SettingsIcon, PlusCircle, LogOut, Wallet, UserPlus, GraduationCap, FileText,
} from 'lucide-react';
import { Eye, PencilLine } from 'lucide-react';
import { PortalProvider, usePortal } from './PortalContext.jsx';
import ClientLogo from './ClientLogo.jsx';
import NotificationBell from './NotificationBell.jsx';
import { portalApi, setPreviewToken } from './api.js';
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

const MAX_WIDTH = 1080;
// The left rail, plus the gap to the content. The shell is widened by exactly
// this much so the content column keeps the width every page was designed
// against — otherwise adding the rail would have quietly narrowed every table
// and player in the portal.
const SIDEBAR_W = 208;
const SIDEBAR_GAP = 26;
const SHELL_MAX = MAX_WIDTH + SIDEBAR_W + SIDEBAR_GAP;

function parseHash() {
  const h = (window.location.hash || '').replace(/^#\/?/, '');
  const [view, ...rest] = h.split('/');
  return { view: view || 'home', param: rest.join('/') || null };
}

export function navigate(hash) {
  window.location.hash = hash;
}

const NAV = [
  // shortLabel is what the mobile tab bar uses — "Current projects" doesn't fit
  // under an icon at phone width.
  //
  // mobile:false drops an item from the phone tab bar (it stays in the desktop
  // nav). The bar lays items out evenly with no scroll, so past about six they
  // stop being tappable — adding the course meant one had to give, and buying
  // video credit is the least likely thing anyone does on a phone.
  // Crash course sits at the top deliberately. Most people arriving in this
  // portal now come in through the course rather than through a project, and
  // for them an empty "Current projects" is a worse first screen than the
  // thing they actually signed up for.
  { view: 'course', label: 'Crash course', shortLabel: 'Course', hash: '#/course', Icon: GraduationCap },
  { view: 'home', label: 'Current projects', shortLabel: 'Projects', hash: '#/', Icon: Home },
  { view: 'brief', label: 'Brief Builder', shortLabel: 'Brief', hash: '#/brief', Icon: FileText, mobile: false },
  { view: 'library', label: 'Video library', shortLabel: 'Library', hash: '#/library', Icon: Film },
  { view: 'documents', label: 'Documents', hash: '#/documents', Icon: FolderOpen },
  { view: 'video-credit', label: 'Video credit', hash: '#/video-credit', Icon: Wallet, mobile: false },
  { view: 'request', label: 'New video', hash: '#/request', Icon: PlusCircle, highlight: true },
  { view: 'team', label: 'Team', hash: '#/team', Icon: Users },
  { view: 'settings', label: 'Settings', hash: '#/settings', Icon: SettingsIcon },
];

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
  const { user, companyId, setActiveCompanyId, logout } = usePortal();
  const isMobile = useIsMobile();
  const companies = user?.companies || [];
  const activeCompany = companies.find((c) => c.id === companyId) || null;
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
            <a href="#/video-credit" style={HEADER_BTN.secondary}>
              <Wallet size={15} /> Order credit
            </a>
            <a href="#/request" style={HEADER_BTN.primary}>
              <PlusCircle size={15} /> New video
            </a>
          </>
        )}
        <NotificationBell compact={isMobile} />
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
function SideNav({ view }) {
  return (
    <nav style={{
      width: SIDEBAR_W, flexShrink: 0, alignSelf: 'flex-start',
      position: 'sticky', top: 18, padding: '4px 0',
      display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      {NAV.filter((n) => n.view !== 'request').map(({ view: v, label, hash, Icon }) => {
        const active = view === v || (v === 'home' && view === 'project');
        return (
          <a
            key={v}
            href={hash}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 13px', borderRadius: 9, textDecoration: 'none',
              fontSize: 14, fontWeight: active ? 700 : 500,
              color: active ? BRAND.ink : '#61798A',
              background: active ? '#fff' : 'transparent',
              border: `1px solid ${active ? BRAND.border : 'transparent'}`,
              // The active item is the one thing that should read instantly at
              // a glance, so it gets the accent bar as well as the weight.
              boxShadow: active ? `inset 3px 0 0 ${BRAND.blue}` : 'none',
            }}
          >
            <Icon size={17} strokeWidth={active ? 2.3 : 2} /> {label}
          </a>
        );
      })}
    </nav>
  );
}

function MobileTabBar({ view }) {
  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 40,
      background: '#fff', borderTop: `1px solid ${BRAND.border}`,
      display: 'flex', justifyContent: 'space-around',
      paddingBottom: 'env(safe-area-inset-bottom)',
    }}>
      {NAV.filter((n) => n.mobile !== false).map(({ view: v, label, shortLabel, hash, Icon, highlight }) => {
        const active = view === v || (v === 'home' && view === 'project');
        return (
          <a key={v} href={hash} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            padding: '9px 6px 7px', textDecoration: 'none', minWidth: 52,
            color: highlight ? BRAND.blue : active ? BRAND.ink : BRAND.muted,
          }}>
            <Icon size={20} strokeWidth={active || highlight ? 2.4 : 2} />
            <span style={{ fontSize: 10, fontWeight: active ? 700 : 500 }}>{shortLabel || label}</span>
          </a>
        );
      })}
    </nav>
  );
}

function AuthedApp() {
  const { toast, companyId, preview } = usePortal();
  const isMobile = useIsMobile();
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    const onHash = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

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
    case 'review': page = <Review token={route.param} />; break;
    case 'storyboard': page = <Storyboard token={route.param} />; break;
    case 'course': page = <Course slug={route.param} />; break;
    case 'brief': page = <Brief />; break;
    case 'library': page = <Library />; break;
    case 'documents': page = <Documents />; break;
    case 'extras': page = <Extras dealId={route.param} />; break;
    case 'voiceover': page = <Voiceover dealId={route.param} />; break;
    case 'kickoff': page = <Kickoff dealId={route.param} />; break;
    case 'script': page = <Script dealId={route.param} />; break;
    case 'request': page = <RequestVideo />; break;
    case 'video-credit': page = <VideoCredit />; break;
    case 'team': page = <Team />; break;
    case 'settings': page = <Settings />; break;
    default: page = <Dashboard />;
  }

  // The review surfaces (video/storyboard) are their own full-height apps with a
  // fixed comment sidebar — squeezing them into the 1080px content column made
  // the player narrow while its height stayed tall, letterboxing the video with
  // huge dark bands. Render them full-bleed and let them fill the space under
  // the nav instead.
  const fullBleed = route.view === 'review' || route.view === 'storyboard';

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
          {!isMobile && <SideNav view={route.view} />}
          {/* minWidth:0 matters — without it a wide table or a long unbroken
              string inside the page pushes the whole flex row wider than the
              shell and the rail slides off to the left. */}
          <main style={{ flex: 1, minWidth: 0 }}>
            {page}
          </main>
        </div>
      )}
      {isMobile && <MobileTabBar view={route.view} />}
      {toast && <Toast msg={toast} />}
    </div>
  );
}

// Persistent bar shown only when staff are inside a client's portal. Read-only
// preview is purple and says so; manage mode is amber — the warning colour —
// because everything done from there is real and lands on the client's account.
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
