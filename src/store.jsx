import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PROPOSAL } from './defaults.js';
import { api, clearToken, getToken, setToken } from './api.js';

const StoreContext = createContext(null);

function emptyStore() {
  return {
    users: {},
    proposals: {},
    templates: {},
    signatures: {},
    views: {},
    payments: {},
    notificationRecipients: [],
    extrasBank: [],
    inclusionsBank: [],
    session: null,
    loading: true,
  };
}

function sessionFromToken() {
  try {
    const token = getToken();
    if (!token) return null;
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp && payload.exp < Date.now() / 1000) { clearToken(); return null; }
    return { email: payload.email, name: payload.name };
  } catch {
    return null;
  }
}

export function StoreProvider({ children }) {
  const [state, setState] = useState(() => ({ ...emptyStore(), session: sessionFromToken() }));
  const [toast, setToast] = useState(null);
  const saveTimers = useRef({});
  const fetchAllRef = useRef(null);

  const showMsg = useCallback((m) => {
    setToast(m);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const fetchAll = useCallback(() => {
    Promise.all([
      api.get('/api/proposals').catch(() => ({})),
      api.get('/api/templates').catch(() => ({})),
      api.get('/api/settings').catch(() => ({})),
      api.get('/api/users').catch(() => ({})),
    ]).then(([proposals, templates, settings, users]) => {
      setState(s => ({
        ...s,
        proposals: proposals || {},
        templates: templates || {},
        users: users || {},
        extrasBank: settings?.extrasBank?.length ? settings.extrasBank : JSON.parse(JSON.stringify(DEFAULT_PROPOSAL.optionalExtras)),
        inclusionsBank: settings?.inclusionsBank?.length ? settings.inclusionsBank : DEFAULT_PROPOSAL.baseInclusions.map((inc, i) => ({ id: 'incl_default_' + i, title: inc.title, description: inc.description || '' })),
        notificationRecipients: settings?.notificationRecipients || [],
        loading: false,
      }));
      Object.keys(proposals || {}).forEach(id => {
        api.get('/api/signatures/' + id).then(sig => {
          if (sig) setState(s => ({ ...s, signatures: { ...s.signatures, [id]: sig } }));
        }).catch(() => {});
        api.get('/api/payments/' + id).then(pay => {
          if (pay) setState(s => ({ ...s, payments: { ...s.payments, [id]: pay } }));
        }).catch(() => {});
      });
    });
  }, []);
  fetchAllRef.current = fetchAll;

  useEffect(() => {
    if (!getToken()) {
      setState(s => ({ ...s, loading: false }));
      return;
    }
    fetchAll();
  }, [fetchAll]);

  const actions = useMemo(() => ({
    login(user, token) {
      if (token) setToken(token);
      setState(s => ({ ...s, session: { email: user.email, name: user.name, avatar: user.avatar ?? null }, loading: true }));
      fetchAllRef.current?.();
    },
    logout() {
      clearToken();
      setState({ ...emptyStore(), loading: false });
    },
    signup(user, token) {
      if (token) setToken(token);
      setState(s => ({ ...s, session: { email: user.email, name: user.name, avatar: null }, users: { ...s.users, [user.email]: user }, loading: true }));
      fetchAllRef.current?.();
    },
    updateAvatar(avatar) {
      setState(s => ({
        ...s,
        session: { ...s.session, avatar },
        users: { ...s.users, [s.session.email]: { ...s.users[s.session.email], avatar } },
      }));
      return api.patch('/api/users', { avatar });
    },
    updatePassword(currentPassword, newPassword) {
      return api.patch('/api/users', { current_password: currentPassword, new_password: newPassword });
    },
    removeUser(email) {
      setState(s => {
        const users = { ...s.users };
        delete users[email];
        return { ...s, users };
      });
      api.delete('/api/users/' + encodeURIComponent(email)).catch(() => {});
    },
    saveProposal(id, data) {
      setState(s => ({ ...s, proposals: { ...s.proposals, [id]: data } }));
      // Debounce writes — builder calls this on every keystroke
      clearTimeout(saveTimers.current[id]);
      saveTimers.current[id] = setTimeout(() => {
        api.put('/api/proposals/' + id, data).catch(() => {});
      }, 800);
    },
    deleteProposal(id) {
      setState(s => {
        const proposals = { ...s.proposals }; delete proposals[id];
        const signatures = { ...s.signatures }; delete signatures[id];
        const payments = { ...s.payments }; delete payments[id];
        return { ...s, proposals, signatures, payments };
      });
      api.delete('/api/proposals/' + id).catch(() => {});
    },
    saveTemplate(id, tpl) {
      setState(s => ({ ...s, templates: { ...s.templates, [id]: tpl } }));
      api.put('/api/templates/' + id, tpl).catch(() => {});
    },
    deleteTemplate(id) {
      setState(s => {
        const templates = { ...s.templates };
        delete templates[id];
        return { ...s, templates };
      });
      api.delete('/api/templates/' + id).catch(() => {});
    },
    recordView(id) {
      setState(s => s.views[id] ? s : ({ ...s, views: { ...s.views, [id]: new Date().toISOString() } }));
      api.post('/api/views/' + id).catch(() => {});
    },
    saveSignature(id, sig) {
      setState(s => ({ ...s, signatures: { ...s.signatures, [id]: sig } }));
      api.post('/api/signatures/' + id, sig).catch(() => {});
    },
    savePayment(id, payment) {
      setState(s => ({ ...s, payments: { ...s.payments, [id]: payment } }));
      api.post('/api/payments/' + id, payment).catch(() => {});
    },
    loadPublicProposal(id) {
      setState(s => ({ ...s, loading: true }));
      Promise.all([
        api.get('/api/proposals/' + id).catch(() => null),
        api.get('/api/signatures/' + id).catch(() => null),
        api.get('/api/payments/' + id).catch(() => null),
      ]).then(([proposal, sig, payment]) => {
        setState(s => ({
          ...s,
          loading: false,
          proposals: proposal ? { ...s.proposals, [id]: proposal } : s.proposals,
          signatures: sig     ? { ...s.signatures, [id]: sig }     : s.signatures,
          payments:   payment ? { ...s.payments,   [id]: payment } : s.payments,
        }));
      }).catch(() => setState(s => ({ ...s, loading: false })));
    },
    setNotificationRecipients(list) {
      setState(s => ({ ...s, notificationRecipients: list }));
      api.put('/api/settings', { notificationRecipients: list }).catch(() => {});
    },
    saveExtrasBank(list) {
      setState(s => ({ ...s, extrasBank: list }));
      api.put('/api/settings', { extrasBank: list }).catch(() => {});
    },
    saveInclusionsBank(list) {
      setState(s => ({ ...s, inclusionsBank: list }));
      api.put('/api/settings', { inclusionsBank: list }).catch(() => {});
    },
  }), []);

  const value = useMemo(
    () => ({ state, actions, showMsg, toast }),
    [state, actions, showMsg, toast]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside <StoreProvider>');
  return ctx;
}
