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
  const [toast, setToast] = useState(null);

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
      return data.user;
    } catch {
      setUser(null);
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

  useEffect(() => {
    (async () => {
      await refreshSession();
      setBooting(false);
    })();
  }, [refreshSession]);

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

  const value = useMemo(() => ({
    booting, user, setUser,
    companyId, setActiveCompanyId,
    overview, overviewLoading, refreshOverview, refreshSession,
    logout, toast, showToast,
  }), [booting, user, companyId, setActiveCompanyId, overview, overviewLoading, refreshOverview, refreshSession, logout, toast, showToast]);

  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortal() {
  return useContext(PortalContext);
}
