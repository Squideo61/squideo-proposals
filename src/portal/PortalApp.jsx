// Customer portal shell: boot dispatch (invite / magic-link / reset query
// params), hash routing (same convention as the CRM SPA — no router dep) and
// the authenticated chrome (header, org switcher, nav, mobile tab bar).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BRAND } from '../theme.js';
import { SQUIDEO_LOGO } from '../defaults.js';
import { useIsMobile } from '../utils.js';
import { Toast } from '../components/ui.jsx';
import {
  Home, Film, FolderOpen, Sparkles, Users, Settings as SettingsIcon, PlusCircle, LogOut,
} from 'lucide-react';
import { Eye } from 'lucide-react';
import { PortalProvider, usePortal } from './PortalContext.jsx';
import ClientLogo from './ClientLogo.jsx';
import { portalApi, setPreviewToken } from './api.js';
import Login from './pages/Login.jsx';
import AcceptInvite from './pages/AcceptInvite.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ProjectDetail from './pages/ProjectDetail.jsx';
import Library from './pages/Library.jsx';
import Documents from './pages/Documents.jsx';
import Extras from './pages/Extras.jsx';
import RequestVideo from './pages/RequestVideo.jsx';
import Team from './pages/Team.jsx';
import Settings from './pages/Settings.jsx';

const MAX_WIDTH = 1080;

function parseHash() {
  const h = (window.location.hash || '').replace(/^#\/?/, '');
  const [view, ...rest] = h.split('/');
  return { view: view || 'home', param: rest.join('/') || null };
}

export function navigate(hash) {
  window.location.hash = hash;
}

const NAV = [
  { view: 'home', label: 'Home', hash: '#/', Icon: Home },
  { view: 'library', label: 'Library', hash: '#/library', Icon: Film },
  { view: 'documents', label: 'Documents', hash: '#/documents', Icon: FolderOpen },
  { view: 'request', label: 'New video', hash: '#/request', Icon: PlusCircle, highlight: true },
  { view: 'team', label: 'Team', hash: '#/team', Icon: Users },
  { view: 'settings', label: 'Settings', hash: '#/settings', Icon: SettingsIcon },
];

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
      <div style={{
        maxWidth: MAX_WIDTH, margin: '0 auto',
        display: 'flex', alignItems: 'center', gap: 16,
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
      {!isMobile && (
        <nav style={{ maxWidth: MAX_WIDTH, margin: '10px auto 0', display: 'flex', gap: 4 }}>
          {NAV.map(({ view, label, hash, Icon, highlight }) => {
            const active = parseHash().view === view || (view === 'home' && parseHash().view === 'project');
            return (
              <a
                key={view}
                href={hash}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '7px 14px', borderRadius: 8, textDecoration: 'none',
                  fontSize: 13.5, fontWeight: 600,
                  color: highlight ? '#0F2A3D' : active ? '#fff' : '#B9CBD6',
                  background: highlight ? BRAND.blue : active ? '#1B3A50' : 'transparent',
                }}
              >
                <Icon size={15} /> {label}
              </a>
            );
          })}
        </nav>
      )}
    </header>
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
      {NAV.map(({ view: v, label, hash, Icon, highlight }) => {
        const active = view === v || (v === 'home' && view === 'project');
        return (
          <a key={v} href={hash} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            padding: '9px 6px 7px', textDecoration: 'none', minWidth: 52,
            color: highlight ? BRAND.blue : active ? BRAND.ink : BRAND.muted,
          }}>
            <Icon size={20} strokeWidth={active || highlight ? 2.4 : 2} />
            <span style={{ fontSize: 10, fontWeight: active ? 700 : 500 }}>{label}</span>
          </a>
        );
      })}
    </nav>
  );
}

function AuthedApp() {
  const { toast } = usePortal();
  const isMobile = useIsMobile();
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    const onHash = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  let page;
  switch (route.view) {
    case 'project': page = <ProjectDetail dealId={route.param} />; break;
    case 'library': page = <Library />; break;
    case 'documents': page = <Documents />; break;
    case 'extras': page = <Extras dealId={route.param} />; break;
    case 'request': page = <RequestVideo />; break;
    case 'team': page = <Team />; break;
    case 'settings': page = <Settings />; break;
    default: page = <Dashboard />;
  }

  return (
    <div style={{ minHeight: '100vh', background: BRAND.paper }}>
      <PreviewBanner />
      <Header />
      <main style={{
        maxWidth: MAX_WIDTH, margin: '0 auto',
        padding: isMobile ? '18px 16px 90px' : '26px 24px 60px',
      }}>
        {page}
      </main>
      {isMobile && <MobileTabBar view={route.view} />}
      {toast && <Toast msg={toast} />}
    </div>
  );
}

// Persistent bar shown only when staff are previewing a client's portal. Makes
// it unmistakable this isn't the real thing and that actions are disabled.
function PreviewBanner() {
  const { preview } = usePortal();
  if (!preview) return null;
  const exit = () => {
    setPreviewToken(null);
    // Closing the preview tab is the natural exit; if it can't self-close
    // (not script-opened), fall back to a neutral page.
    window.close();
    window.setTimeout(() => { window.location.href = 'about:blank'; }, 150);
  };
  return (
    <div style={{
      background: '#7C3AED', color: '#fff', padding: '8px 16px',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
      fontSize: 13, fontWeight: 600, flexWrap: 'wrap', textAlign: 'center',
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        <Eye size={15} />
        Preview — you’re viewing {preview.company?.name || 'this client'}’s portal as they’d see it. Changes are disabled.
      </span>
      <button
        onClick={exit}
        style={{ background: 'rgba(255,255,255,0.2)', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}
      >
        Exit preview
      </button>
    </div>
  );
}

function Boot() {
  const { booting, user, refreshSession, showToast } = usePortal();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const inviteToken = params.get('invite');
  const magicToken = params.get('login');
  const resetToken = params.get('reset');
  const [magicState, setMagicState] = useState(magicToken ? 'pending' : null);

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

  if (booting || magicState === 'pending') {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: BRAND.paper }}>
        <div style={{ color: BRAND.muted, fontSize: 14 }}>Loading your portal…</div>
      </div>
    );
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
