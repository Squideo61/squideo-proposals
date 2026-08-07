// Slim portal state — deliberately NOT the CRM's monolithic store.jsx (no
// polling, no CRM slices). Holds the session user, the active organisation and
// a cached overview; everything else is fetched by the page that needs it.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { portalApi } from './api.js';

const PortalContext = createContext(null);
const COMPANY_KEY = 'squideo:portal:companyId';
const LOGO_KEY = 'squideo:portal:logoUrl';

// The sign-in screen has no session and no org, so it can't ask the server
// whose portal it is. Remembering the last org's logo is what lets a returning
// client land on their own branding (a first-ever visit just sees Squideo's).
export function rememberedLogoUrl() {
  try { return localStorage.getItem(LOGO_KEY) || null; } catch { return null; }
}

export function PortalProvider({ children }) {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState(null);
  const [activeCompanyId, setActiveCompanyIdState] = useState(() => {
    try { return localStorage.getItem(COMPANY_KEY) || null; } catch { return null; }
  });
  const [overview, setOverview] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  // { company, manage, staffEmail } when staff is in the client's portal.
  // manage:false is the read-only preview; manage:true means writes are live.
  const [preview, setPreview] = useState(null);
  // Whether the sample project has anything uploaded in it. Resolved server-side
  // so the nav can't advertise a section that opens on "coming shortly".
  const [sampleAvailable, setSampleAvailable] = useState(false);
  const [toast, setToast] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const showToast = useCallback((msg) => {
    setToast(msg);
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const setActiveCompanyId = useCallback((id) => {
    setActiveCompanyIdState(id);
    try { localStorage.setItem(COMPANY_KEY, id || ''); } catch { /* ignore */ }
  }, []);

  // Resolve the effective org: the persisted pick if still a membership,
  // else the first membership.
  const companyId = useMemo(() => {
    const ids = (user?.companies || []).map((c) => c.id);
    if (activeCompanyId && ids.includes(activeCompanyId)) return activeCompanyId;
    return ids[0] || null;
  }, [user, activeCompanyId]);

  const refreshSession = useCallback(async () => {
    try {
      const data = await portalApi.get('me');
      setUser(data.user);
      setPreview(data.preview || null);
      setSampleAvailable(data.sampleProject?.available === true);
      return data.user;
    } catch {
      setUser(null);
      setPreview(null);
      setSampleAvailable(false);
      return null;
    }
  }, []);

  const refreshOverview = useCallback(async (cid) => {
    const target = cid || companyId;
    if (!target) return null;
    setOverviewLoading(true);
    try {
      const data = await portalApi.get(`overview?companyId=${encodeURIComponent(target)}`);
      setOverview(data);
      return data;
    } finally {
      setOverviewLoading(false);
    }
  }, [companyId]);

  const refreshNotifications = useCallback(async () => {
    try {
      const data = await portalApi.get('notifications');
      setNotifications(data.notifications || []);
      setUnreadCount(data.unread || 0);
      return data;
    } catch {
      return null;
    }
  }, []);

  const markRead = useCallback(async (id) => {
    // Optimistic — flip locally, then persist.
    setNotifications((prev) => prev.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
    try { await portalApi.post('notifications', { id }); } catch { /* ignore */ }
  }, []);

  const markAllRead = useCallback(async () => {
    setNotifications((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
    setUnreadCount(0);
    try { await portalApi.post('notifications', { all: true }); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    (async () => {
      await refreshSession();
      setBooting(false);
    })();
  }, [refreshSession]);

  // Poll the notification feed while signed in (the portal is otherwise
  // poll-free; this one lightweight endpoint keeps the bell current).
  useEffect(() => {
    if (!user) { setNotifications([]); setUnreadCount(0); return; }
    refreshNotifications();
    const t = window.setInterval(refreshNotifications, 25_000);
    // Also refresh the moment the client returns to the tab, so a notification
    // that landed while they were elsewhere shows up straight away rather than
    // after the next poll.
    const onActive = () => { if (document.visibilityState !== 'hidden') refreshNotifications(); };
    window.addEventListener('focus', onActive);
    document.addEventListener('visibilitychange', onActive);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', onActive);
      document.removeEventListener('visibilitychange', onActive);
    };
  }, [user, refreshNotifications]);

  useEffect(() => {
    if (user && companyId) refreshOverview(companyId).catch(() => {});
  }, [user, companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the remembered logo in step with the active org — it outlives the
  // session on purpose, so the next sign-in screen is already branded.
  useEffect(() => {
    const active = (user?.companies || []).find((c) => c.id === companyId);
    if (!active) return;
    try {
      if (active.logoUrl) localStorage.setItem(LOGO_KEY, active.logoUrl);
      else localStorage.removeItem(LOGO_KEY);
    } catch { /* ignore */ }
  }, [user, companyId]);

  const logout = useCallback(async () => {
    try { await portalApi.post('auth?op=logout'); } catch { /* ignore */ }
    setUser(null);
    setOverview(null);
  }, []);

  // The active organisation, resolved once. Several pages need to know whether
  // they're talking to a prospect — someone who signed themselves up off a
  // marketing page and has never bought anything — so that they can say
  // "not yet" rather than showing an empty room.
  //
  // `isProspect` defaults to FALSE when the flag is missing, deliberately: an
  // older session payload should read as a paying client and be told nothing,
  // rather than have a real client shown prospect copy about their own account.
  // Same defensive direction as visibleNav's creditVisible check.
  const company = useMemo(
    () => (user?.companies || []).find((c) => c.id === companyId) || null,
    [user, companyId],
  );

  const value = useMemo(() => ({
    booting, user, setUser,
    companyId, setActiveCompanyId, company, isProspect: company?.prospect === true,
    overview, overviewLoading, refreshOverview, refreshSession,
    preview, manageMode: preview?.manage === true, logout, toast, showToast,
    sampleAvailable,
    notifications, unreadCount, refreshNotifications, markRead, markAllRead,
  }), [booting, user, companyId, setActiveCompanyId, company, overview, overviewLoading, refreshOverview, refreshSession, preview, logout, toast, showToast, sampleAvailable, notifications, unreadCount, refreshNotifications, markRead, markAllRead]);

  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortal() {
  return useContext(PortalContext);
}
