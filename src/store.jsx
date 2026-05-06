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
    viewSessions: {},
    payments: {},
    notificationRecipients: [],
    extrasBank: [],
    inclusionsBank: [],
    leaderboard: null,
    partnerCreditsList: null,
    partnerCreditDetail: {},
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
    return { email: payload.email, name: payload.name, role: payload.role || 'member' };
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
      setState(s => ({ ...s, session: { email: user.email, name: user.name, avatar: user.avatar ?? null, role: user.role || 'member' }, loading: true }));
      fetchAllRef.current?.();
    },
    logout() {
      clearToken();
      setState({ ...emptyStore(), loading: false });
    },
    signup(user, token) {
      if (token) setToken(token);
      setState(s => ({ ...s, session: { email: user.email, name: user.name, avatar: null, role: user.role || 'member' }, users: { ...s.users, [user.email]: user }, loading: true }));
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
      api.delete('/api/users?email=' + encodeURIComponent(email)).catch(() => {});
    },
    saveProposal(id, data) {
      setState(s => {
        const existing = s.proposals[id];
        // Preserve server-assigned metadata (_number, _views, _createdAt) across local edits
        const merged = {
          ...data,
          _number: existing && existing._number ? existing._number : (data._number || null),
          _views:  existing && existing._views  ? existing._views  : (data._views  || { opens: 0, duration: 0, lastActiveAt: null }),
          _createdAt: existing && existing._createdAt ? existing._createdAt : data._createdAt,
        };
        return { ...s, proposals: { ...s.proposals, [id]: merged } };
      });
      // Debounce writes — builder calls this on every keystroke
      clearTimeout(saveTimers.current[id]);
      saveTimers.current[id] = setTimeout(() => {
        // Strip client-only metadata before sending
        const payload = { ...data };
        delete payload._number;
        delete payload._views;
        delete payload._createdAt;
        api.put('/api/proposals/' + id, payload).then((resp) => {
          if (resp && resp.number) {
            setState(s => {
              const cur = s.proposals[id];
              if (!cur) return s;
              return { ...s, proposals: { ...s.proposals, [id]: { ...cur, _number: resp.number } } };
            });
          }
        }).catch(() => {});
      }, 800);
    },
    deleteProposal(id) {
      setState(s => {
        const proposals = { ...s.proposals }; delete proposals[id];
        const signatures = { ...s.signatures }; delete signatures[id];
        const payments = { ...s.payments }; delete payments[id];
        const viewSessions = { ...s.viewSessions }; delete viewSessions[id];
        return { ...s, proposals, signatures, payments, viewSessions };
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
    loadViewSessions(id) {
      return api.get('/api/views/' + id).then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        setState(s => ({ ...s, viewSessions: { ...s.viewSessions, [id]: list } }));
        return list;
      }).catch(() => []);
    },
    loadLeaderboard(range = 'month') {
      const r = ['month', 'year', 'all'].includes(range) ? range : 'month';
      return api.get('/api/proposals?view=leaderboard&range=' + r).then((data) => {
        const board = data || { totals: [], createdTrend: [], signedTrend: [], range: r, grain: r === 'month' ? 'day' : 'month', periodLabel: '' };
        setState(s => ({ ...s, leaderboard: board }));
        return board;
      }).catch(() => ({ totals: [], createdTrend: [], signedTrend: [], range: r, grain: 'day', periodLabel: '' }));
    },
    saveSignature(id, sig) {
      setState(s => ({ ...s, signatures: { ...s.signatures, [id]: sig } }));
      api.post('/api/signatures/' + id, sig).catch(() => {});
    },
    removeSignature(id) {
      setState(s => {
        const signatures = { ...s.signatures };
        delete signatures[id];
        return { ...s, signatures };
      });
      return api.delete('/api/signatures/' + id).catch(() => {});
    },
    savePayment(id, payment) {
      setState(s => ({ ...s, payments: { ...s.payments, [id]: payment } }));
      api.post('/api/payments/' + id, payment).catch(() => {});
    },
    markAsPaid(id, amount, paymentType = 'manual') {
      const payment = {
        amount: Number(amount) || 0,
        paymentType,
        paidAt: new Date().toISOString(),
        stripeSessionId: null,
        customerEmail: null,
      };
      setState(s => ({ ...s, payments: { ...s.payments, [id]: payment } }));
      return api.post('/api/payments/' + id, payment).catch(() => {});
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
    fetchPartnerCreditsList() {
      return api.get('/api/partner/credits').then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        setState(s => ({ ...s, partnerCreditsList: list }));
        return list;
      }).catch(() => []);
    },
    fetchPartnerCreditDetail(clientKey) {
      return api.get('/api/partner/clients?key=' + encodeURIComponent(clientKey))
        .then((data) => {
          setState(s => ({
            ...s,
            partnerCreditDetail: { ...(s.partnerCreditDetail || {}), [clientKey]: data },
          }));
          return data;
        });
    },
    logAllocation(input) {
      return api.post('/api/partner/allocations', input).then((row) => {
        const key = input.clientKey;
        setState(s => {
          const detail = s.partnerCreditDetail?.[key];
          if (!detail) return s;
          const allocations = [row, ...(detail.allocations || [])];
          const used = allocations.reduce((acc, a) => acc + (Number(a.creditCost) || 0), 0);
          const issued = detail.totals.issued;
          return {
            ...s,
            partnerCreditDetail: {
              ...s.partnerCreditDetail,
              [key]: {
                ...detail,
                allocations,
                totals: {
                  ...detail.totals,
                  used,
                  remaining: issued - used,
                  usagePct: issued > 0 ? Math.min(100, Math.round((used / issued) * 1000) / 10) : 0,
                },
              },
            },
          };
        });
        return row;
      });
    },
    createManualSubscription(input) {
      return api.post('/api/partner/subscriptions', input).then((row) => {
        setState(s => ({ ...s, partnerCreditsList: null, partnerCreditDetail: {} }));
        return row;
      });
    },
    patchManualSubscription(subId, patch) {
      return api.patch('/api/partner/subscriptions?id=' + encodeURIComponent(subId), patch).then((row) => {
        setState(s => ({ ...s, partnerCreditsList: null, partnerCreditDetail: {} }));
        return row;
      });
    },
    deleteManualSubscription(subId) {
      return api.delete('/api/partner/subscriptions?id=' + encodeURIComponent(subId)).then(() => {
        setState(s => ({ ...s, partnerCreditsList: null, partnerCreditDetail: {} }));
      });
    },
    deleteAllocation(clientKey, id) {
      return api.delete('/api/partner/allocations?id=' + encodeURIComponent(id)).then(() => {
        setState(s => {
          const detail = s.partnerCreditDetail?.[clientKey];
          if (!detail) return s;
          const allocations = (detail.allocations || []).filter(a => a.id !== id);
          const used = allocations.reduce((acc, a) => acc + (Number(a.creditCost) || 0), 0);
          const issued = detail.totals.issued;
          return {
            ...s,
            partnerCreditDetail: {
              ...s.partnerCreditDetail,
              [clientKey]: {
                ...detail,
                allocations,
                totals: {
                  ...detail.totals,
                  used,
                  remaining: issued - used,
                  usagePct: issued > 0 ? Math.min(100, Math.round((used / issued) * 1000) / 10) : 0,
                },
              },
            },
          };
        });
      });
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
