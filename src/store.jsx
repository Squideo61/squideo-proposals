import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PROPOSAL } from './defaults.js';
import { api } from './api.js';
import { permissionsInclude } from './lib/permissions.js';

const StoreContext = createContext(null);

function emptyStore() {
  return {
    users: {},
    roles: {},
    proposals: {},
    templates: {},
    signatures: {},
    viewSessions: {},
    payments: {},
    // CRM
    deals: {},
    contacts: {},
    companies: {},
    tasks: [],
    dealDetail: {},
    gmailAccount: null,
    triage: [],
    quoteRequests: [],
    emailBodies: {},
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

// Recompute partner-credit totals from raw subscription + allocation data.
// Mirrors the math in api/partner/[action].js clientDetail() — issued comes
// from sub accrual + positive adjustments; used comes from work + the
// magnitude of any negative adjustments.
function computePartnerTotals(subs, allocations) {
  const subIssued  = (subs || []).reduce((s, x) => s + (Number(x.creditsIssuedFromSub) || 0), 0);
  const adjAdded   = (allocations || []).filter(a => a.kind === 'adjustment' && a.creditCost > 0)
                       .reduce((s, a) => s + a.creditCost, 0);
  const adjRemoved = (allocations || []).filter(a => a.kind === 'adjustment' && a.creditCost < 0)
                       .reduce((s, a) => s + (-a.creditCost), 0);
  const workUsed   = (allocations || []).filter(a => a.kind === 'work')
                       .reduce((s, a) => s + a.creditCost, 0);
  const issued = subIssued + adjAdded;
  const used = workUsed + adjRemoved;
  const remaining = issued - used;
  const usagePct = issued > 0 ? Math.min(100, Math.round((used / issued) * 1000) / 10) : 0;
  return { issued, used, remaining, usagePct };
}

// Apply a transformation to the cached allocations for one client and
// recompute totals correctly. Used by logAllocation and deleteAllocation
// for instant optimistic updates without round-tripping the server.
function applyOptimisticAllocationChange(setState, clientKey, transform) {
  setState(s => {
    const detail = s.partnerCreditDetail?.[clientKey];
    if (!detail) return s;
    const allocations = transform(detail.allocations || []);
    return {
      ...s,
      partnerCreditDetail: {
        ...s.partnerCreditDetail,
        [clientKey]: {
          ...detail,
          allocations,
          totals: computePartnerTotals(detail.subscriptions, allocations),
        },
      },
    };
  });
}

// Strip the detail-only nested fields from a deal-detail response so the
// tidier deal record can sit in state.deals (the Kanban list).
function stripDetail(d) {
  if (!d) return d;
  const { proposals, events, tasks, files, comments, ...rest } = d;
  return rest;
}

// Apply a transformation to a task across BOTH state.tasks and any cached
// state.dealDetail[*].tasks that contains it. Returning null from `transform`
// removes the task. Used by completeTask/saveTask/deleteTask so dealDetail
// stays in sync without a network round-trip.
function withTaskUpdate(state, taskId, transform) {
  const updateList = (list) => {
    if (!list) return list;
    const out = [];
    for (const t of list) {
      if (t.id !== taskId) { out.push(t); continue; }
      const u = transform(t);
      if (u !== null && u !== undefined) out.push(u);
    }
    return out;
  };
  const newDealDetail = {};
  for (const k of Object.keys(state.dealDetail || {})) {
    const detail = state.dealDetail[k];
    newDealDetail[k] = detail?.tasks
      ? { ...detail, tasks: updateList(detail.tasks) }
      : detail;
  }
  return { ...state, tasks: updateList(state.tasks), dealDetail: newDealDetail };
}

// Apply one tagged optimistic patch and return the updated state.
// The patch descriptor's `kind` decides which slice(s) of state are touched:
//   { kind:'deal',    id, patch }      → patches state.deals[id] AND state.dealDetail[id] if cached
//   { kind:'deal',    id, delete:true } → removes both
//   { kind:'contact', id, patch }      → patches state.contacts[id]
//   { kind:'contact', id, delete:true } → removes it
//   { kind:'company', id, patch }      → patches state.companies[id]
//   { kind:'company', id, delete:true } → removes it
//   { kind:'task',    id, patch }      → via withTaskUpdate, syncs state.tasks AND every dealDetail.tasks
//   { kind:'task',    id, delete:true } → removes from both
//   { kind:'task',    create:taskObj }  → prepends to state.tasks AND the relevant dealDetail.tasks
// `patch` may be a function (current → next) — used by toggleTask which reads the current doneAt.
// A descriptor with no recognised kind is a no-op (used by createTask to carry an errorMsg only).
function applyOne(state, p) {
  if (!p) return state;
  switch (p.kind) {
    case 'deal': {
      if (p.delete) {
        if (!state.deals[p.id] && !state.dealDetail[p.id]) return state;
        const deals = { ...state.deals }; delete deals[p.id];
        const dealDetail = { ...state.dealDetail }; delete dealDetail[p.id];
        return { ...state, deals, dealDetail };
      }
      const cur = state.deals[p.id];
      if (!cur) return state;
      const detail = state.dealDetail[p.id];
      return {
        ...state,
        deals: { ...state.deals, [p.id]: { ...cur, ...p.patch } },
        dealDetail: detail
          ? { ...state.dealDetail, [p.id]: { ...detail, ...p.patch } }
          : state.dealDetail,
      };
    }
    case 'contact': {
      if (p.delete) {
        if (!state.contacts[p.id]) return state;
        const contacts = { ...state.contacts }; delete contacts[p.id];
        return { ...state, contacts };
      }
      const cur = state.contacts[p.id];
      if (!cur) return state;
      return { ...state, contacts: { ...state.contacts, [p.id]: { ...cur, ...p.patch } } };
    }
    case 'company': {
      if (p.delete) {
        if (!state.companies[p.id]) return state;
        const companies = { ...state.companies }; delete companies[p.id];
        return { ...state, companies };
      }
      const cur = state.companies[p.id];
      if (!cur) return state;
      return { ...state, companies: { ...state.companies, [p.id]: { ...cur, ...p.patch } } };
    }
    case 'task': {
      if (p.create) {
        const t = p.create;
        const tasks = [t, ...state.tasks];
        let dealDetail = state.dealDetail;
        if (t.dealId && state.dealDetail[t.dealId]) {
          dealDetail = {
            ...state.dealDetail,
            [t.dealId]: {
              ...state.dealDetail[t.dealId],
              tasks: [t, ...(state.dealDetail[t.dealId].tasks || [])],
            },
          };
        }
        return { ...state, tasks, dealDetail };
      }
      if (p.delete) return withTaskUpdate(state, p.id, () => null);
      const transform = typeof p.patch === 'function' ? p.patch : (t) => ({ ...t, ...p.patch });
      return withTaskUpdate(state, p.id, transform);
    }
    default:
      return state;
  }
}

function applyPatches(state, patches) {
  if (!patches) return state;
  const list = Array.isArray(patches) ? patches : [patches];
  let s = state;
  for (const p of list) s = applyOne(s, p);
  return s;
}

export function StoreProvider({ children }) {
  // Session is rehydrated from /api/auth/me on mount (the JWT lives in an
  // HttpOnly cookie now). Until that resolves we render with loading: true.
  const [state, setState] = useState(() => ({ ...emptyStore(), session: null }));
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
      api.get('/api/roles').catch(() => []),
      api.get('/api/crm/deals').catch(() => []),
      api.get('/api/crm/contacts').catch(() => []),
      api.get('/api/crm/companies').catch(() => []),
      api.get('/api/crm/tasks?scope=open').catch(() => []),
      api.get('/api/crm/gmail').catch(() => null),
      api.get('/api/crm/triage').catch(() => []),
      api.get('/api/quote-requests-admin?status=new').catch(() => []),
    ]).then(([proposals, templates, settings, users, roles, deals, contacts, companies, tasks, gmailAccount, triage, quoteRequests]) => {
      const dealsMap = {};
      for (const d of (Array.isArray(deals) ? deals : [])) dealsMap[d.id] = d;
      const contactsMap = {};
      for (const c of (Array.isArray(contacts) ? contacts : [])) contactsMap[c.id] = c;
      const companiesMap = {};
      for (const c of (Array.isArray(companies) ? companies : [])) companiesMap[c.id] = c;
      const rolesMap = {};
      for (const r of (Array.isArray(roles) ? roles : [])) rolesMap[r.id] = r;
      const signaturesMap = {};
      const paymentsMap = {};
      for (const [pid, p] of Object.entries(proposals || {})) {
        if (p?._signature) signaturesMap[pid] = p._signature;
        if (p?._payment)   paymentsMap[pid]   = p._payment;
      }
      setState(s => ({
        ...s,
        proposals: proposals || {},
        templates: templates || {},
        users: users || {},
        roles: rolesMap,
        signatures: signaturesMap,
        payments: paymentsMap,
        deals: dealsMap,
        contacts: contactsMap,
        companies: companiesMap,
        tasks: Array.isArray(tasks) ? tasks : [],
        gmailAccount: gmailAccount || null,
        triage: Array.isArray(triage) ? triage : [],
        quoteRequests: Array.isArray(quoteRequests) ? quoteRequests : [],
        extrasBank: settings?.extrasBank?.length ? settings.extrasBank : JSON.parse(JSON.stringify(DEFAULT_PROPOSAL.optionalExtras)),
        inclusionsBank: settings?.inclusionsBank?.length ? settings.inclusionsBank : DEFAULT_PROPOSAL.baseInclusions.map((inc, i) => ({ id: 'incl_default_' + i, title: inc.title, description: inc.description || '' })),
        notificationRecipients: settings?.notificationRecipients || [],
        loading: false,
      }));
    });
  }, []);
  fetchAllRef.current = fetchAll;

  useEffect(() => {
    // Ask the server who we are. If the cookie's missing or expired this 401s
    // and we drop the user on the auth screen; otherwise we hydrate the
    // session and kick off the normal fetchAll.
    api.get('/api/auth/me').then((r) => {
      if (r && r.user) {
        setState(s => ({ ...s, session: {
          email: r.user.email,
          name: r.user.name,
          avatar: r.user.avatar ?? null,
          role: r.user.role || 'member',
          roleName: r.user.roleName || r.user.role || 'Member',
          permissions: Array.isArray(r.user.permissions) ? r.user.permissions : [],
        } }));
        fetchAll();
      } else {
        setState(s => ({ ...s, loading: false }));
      }
    }).catch(() => {
      setState(s => ({ ...s, loading: false }));
    });
  }, [fetchAll]);

  // Keep the inbox-style badge counts fresh without a manual reload. Polls
  // every 60s while the tab is visible, and immediately refreshes when the
  // tab regains focus. Scoped to lists that change from outside the app
  // (quote requests, triage, tasks); the heavier fetchAll is left alone.
  useEffect(() => {
    if (!state.session) return undefined;
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      api.get('/api/quote-requests-admin?status=new').then((rows) => {
        if (cancelled) return;
        setState(s => ({ ...s, quoteRequests: Array.isArray(rows) ? rows : [] }));
      }).catch(() => {});
      api.get('/api/crm/triage').then((rows) => {
        if (cancelled) return;
        setState(s => ({ ...s, triage: Array.isArray(rows) ? rows : [] }));
      }).catch(() => {});
    };
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [state.session]);

  // Live dashboard: poll the proposals list every 20s so new signatures,
  // payments, and view counts surface without a manual refresh. We replace
  // signatures / payments / view counts unconditionally (they only change
  // from outside the app), but we skip overwriting a proposal's editable
  // data if there's a pending debounced save for it — otherwise typing in
  // the builder would race with the poll and the user would see characters
  // disappear. New signs and payments trigger a toast so they're noticed
  // even when the user is on a different view.
  useEffect(() => {
    if (!state.session) return undefined;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      api.get('/api/proposals').then((proposals) => {
        if (cancelled || !proposals || typeof proposals !== 'object') return;
        let newlySigned = [];
        let newlyPaid = [];
        setState(s => {
          // Recompute each time (strict mode invokes the updater twice; we
          // overwrite rather than append so the result is idempotent).
          newlySigned = [];
          newlyPaid = [];
          const nextProposals = { ...s.proposals };
          const nextSignatures = {};
          const nextPayments = {};
          for (const [pid, p] of Object.entries(proposals)) {
            if (p?._signature) nextSignatures[pid] = p._signature;
            if (p?._payment)   nextPayments[pid]   = p._payment;
            if (p?._signature && !s.signatures[pid]) newlySigned.push({ id: pid, sig: p._signature, name: p.clientName || p.contactBusinessName || 'a proposal' });
            if (p?._payment   && !s.payments[pid])   newlyPaid.push({ id: pid, pay: p._payment, name: p.clientName || p.contactBusinessName || 'a proposal' });
            const editing = !!saveTimers.current[pid];
            if (editing && s.proposals[pid]) {
              // Keep the user's in-flight local edits, but still let view counts
              // and dealId tick over so the dashboard reflects external changes.
              nextProposals[pid] = {
                ...s.proposals[pid],
                _views: p._views ?? s.proposals[pid]._views,
                _dealId: p._dealId ?? s.proposals[pid]._dealId,
                _number: p._number ?? s.proposals[pid]._number,
                _hasXeroInvoice: p._hasXeroInvoice,
                _xeroInvoiceId: p._xeroInvoiceId,
                _hasXeroQuote: p._hasXeroQuote,
              };
            } else {
              nextProposals[pid] = p;
            }
          }
          // Proposals deleted on the server should also vanish locally.
          for (const pid of Object.keys(s.proposals)) {
            if (!proposals[pid] && !saveTimers.current[pid]) delete nextProposals[pid];
          }
          return { ...s, proposals: nextProposals, signatures: nextSignatures, payments: nextPayments };
        });
        if (newlySigned.length || newlyPaid.length) {
          const parts = [];
          for (const n of newlySigned) parts.push(`${n.sig.name || 'Someone'} signed ${n.name}`);
          for (const n of newlyPaid)   parts.push(`Payment received for ${n.name}`);
          showMsg(parts.join(' · '));
        }
      }).catch(() => {});
    };
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') tick();
    }, 20_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', tick);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', tick);
    };
  }, [state.session, showMsg]);

  // mutate: the one place CRM-style optimistic actions live.
  // - `patches` is a tagged descriptor (or array). applyOne handles the dual-cache
  //   logic so deals/tasks always stay in sync with dealDetail without each
  //   action having to remember.
  // - On API failure we snapshot-rollback and toast. Snapshot is whole-state for
  //   simplicity — the prior swallow-on-error code lost the bug entirely, so
  //   even an over-aggressive rollback is a strict improvement for the rare
  //   case of two mutations in flight at once.
  // - If `onSuccess` is omitted, the response (assumed to be the server-canonical
  //   record with `id`) is applied as a patch of the same kind. saveDeal etc.
  //   then need no explicit success handler.
  const mutate = useCallback((patches, apiCall, onSuccess) => {
    const first = Array.isArray(patches) ? patches[0] : patches;
    const errorMsg = first?.errorMsg || 'Action failed';
    let snapshot = null;
    setState(s => {
      snapshot = s;
      return applyPatches(s, patches);
    });
    return apiCall().then((resp) => {
      if (onSuccess) {
        setState(s => onSuccess(s, resp) ?? s);
      } else if (resp && resp.id && first && !first.delete && !first.create) {
        if (first.kind === 'deal' || first.kind === 'contact' || first.kind === 'company' || first.kind === 'task') {
          setState(s => applyOne(s, { kind: first.kind, id: resp.id, patch: resp }));
        }
      }
      return resp;
    }).catch(() => {
      if (snapshot) setState(snapshot);
      showMsg(errorMsg);
    });
  }, [showMsg]);

  const actions = useMemo(() => ({
    login(user) {
      // The session cookie was set on the API response that produced this user.
      setState(s => ({ ...s, session: {
        email: user.email,
        name: user.name,
        avatar: user.avatar ?? null,
        role: user.role || 'member',
        roleName: user.roleName || user.role || 'Member',
        permissions: Array.isArray(user.permissions) ? user.permissions : [],
      }, loading: true }));
      // After login, re-fetch /me to pick up the merged permissions/roleName
      // payload (login itself returns the leaner publicUser shape).
      api.get('/api/auth/me').then((r) => {
        if (r && r.user) {
          setState(s => ({ ...s, session: {
            email: r.user.email,
            name: r.user.name,
            avatar: r.user.avatar ?? null,
            role: r.user.role || 'member',
            roleName: r.user.roleName || r.user.role || 'Member',
            permissions: Array.isArray(r.user.permissions) ? r.user.permissions : [],
          } }));
        }
      }).catch(() => {});
      fetchAllRef.current?.();
    },
    logout() {
      // Fire-and-forget the server-side cookie clear; clearing local state
      // first means the auth screen renders instantly even if the network's
      // slow. The cookie is HttpOnly so we can't wipe it from JS.
      api.post('/api/auth/logout', {}).catch(() => {});
      setState({ ...emptyStore(), loading: false });
    },
    signup(user) {
      setState(s => ({ ...s, session: {
        email: user.email,
        name: user.name,
        avatar: null,
        role: user.role || 'member',
        roleName: user.roleName || user.role || 'Member',
        permissions: Array.isArray(user.permissions) ? user.permissions : [],
      }, users: { ...s.users, [user.email]: user }, loading: true }));
      api.get('/api/auth/me').then((r) => {
        if (r && r.user) {
          setState(s => ({ ...s, session: {
            email: r.user.email,
            name: r.user.name,
            avatar: r.user.avatar ?? null,
            role: r.user.role || 'member',
            roleName: r.user.roleName || r.user.role || 'Member',
            permissions: Array.isArray(r.user.permissions) ? r.user.permissions : [],
          } }));
        }
      }).catch(() => {});
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
      // Cancel any pending debounced save — otherwise an in-flight PUT (e.g.
      // user typed in the builder, hit Back, then deleted within 800ms) fires
      // AFTER the DELETE and re-creates the proposal on the server.
      if (saveTimers.current[id]) {
        clearTimeout(saveTimers.current[id]);
        delete saveTimers.current[id];
      }
      let snapshot = null;
      setState(s => {
        snapshot = s;
        const proposals = { ...s.proposals }; delete proposals[id];
        const signatures = { ...s.signatures }; delete signatures[id];
        const payments = { ...s.payments }; delete payments[id];
        const viewSessions = { ...s.viewSessions }; delete viewSessions[id];
        return { ...s, proposals, signatures, payments, viewSessions };
      });
      api.delete('/api/proposals/' + id).catch((err) => {
        // Server refused (most likely 403 — non-admin trying to delete
        // someone else's proposal). Roll back the optimistic remove and
        // surface the error so the user knows why the proposal came back.
        if (snapshot) setState(snapshot);
        showMsg(err?.message || 'Could not delete proposal');
      });
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
    saveInclusionsBank(list, { oldBank = [], proposals = {} } = {}) {
      const removedTitles = new Set(
        oldBank.map(b => b.title).filter(t => !list.some(b => b.title === t))
      );
      const affectedProposals = {};
      if (removedTitles.size > 0) {
        for (const [id, p] of Object.entries(proposals)) {
          const filtered = (p.baseInclusions || []).filter(inc => !removedTitles.has(inc.title));
          if (filtered.length !== (p.baseInclusions || []).length) {
            affectedProposals[id] = { ...p, baseInclusions: filtered };
          }
        }
      }
      setState(s => ({ ...s, inclusionsBank: list, proposals: { ...s.proposals, ...affectedProposals } }));
      api.put('/api/settings', { inclusionsBank: list }).catch(() => {});
      for (const [id, data] of Object.entries(affectedProposals)) {
        clearTimeout(saveTimers.current[id]);
        const payload = { ...data };
        delete payload._number; delete payload._views; delete payload._createdAt;
        api.put('/api/proposals/' + id, payload).catch(() => {});
      }
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
        applyOptimisticAllocationChange(setState, input.clientKey, (allocations) => [row, ...allocations]);
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
    cancelPartnerSubscription(subId) {
      return api.post('/api/partner/cancel-subscription?id=' + encodeURIComponent(subId), {}).then(() => {
        setState(s => ({ ...s, partnerCreditsList: null, partnerCreditDetail: {} }));
      });
    },
    deleteAllocation(clientKey, id) {
      return api.delete('/api/partner/allocations?id=' + encodeURIComponent(id)).then(() => {
        applyOptimisticAllocationChange(setState, clientKey, (allocations) => allocations.filter(a => a.id !== id));
      });
    },

    // ---------- CRM ----------
    refreshDeals() {
      return api.get('/api/crm/deals').then((rows) => {
        const map = {};
        for (const d of (Array.isArray(rows) ? rows : [])) map[d.id] = d;
        setState(s => ({ ...s, deals: map }));
        return map;
      }).catch(() => ({}));
    },
    loadDealDetail(dealId) {
      return api.get('/api/crm/deals/' + encodeURIComponent(dealId)).then((data) => {
        if (!data || data.error) return null;
        setState(s => ({
          ...s,
          dealDetail: { ...s.dealDetail, [dealId]: data },
          deals: { ...s.deals, [dealId]: { ...(s.deals[dealId] || {}), ...stripDetail(data) } },
        }));
        return data;
      }).catch(() => null);
    },
    createDeal(input) {
      return api.post('/api/crm/deals', input).then((deal) => {
        if (deal && deal.id) {
          setState(s => ({ ...s, deals: { ...s.deals, [deal.id]: deal } }));
        }
        return deal;
      });
    },
    saveDeal(dealId, patch) {
      return mutate(
        { kind: 'deal', id: dealId, patch, errorMsg: 'Failed to save deal' },
        () => api.patch('/api/crm/deals/' + encodeURIComponent(dealId), patch),
      );
    },
    moveDealStage(dealId, stage, lostReason) {
      const patch = { stage, stageChangedAt: new Date().toISOString(), lostReason: lostReason || null };
      return mutate(
        { kind: 'deal', id: dealId, patch, errorMsg: 'Failed to move deal' },
        () => api.post('/api/crm/deals/' + encodeURIComponent(dealId) + '/stage', { stage, lostReason }),
        (s, resp) => resp?.deal
          ? applyOne(s, { kind: 'deal', id: resp.deal.id, patch: resp.deal })
          : s,
      );
    },
    deleteDeal(dealId) {
      return mutate(
        { kind: 'deal', id: dealId, delete: true, errorMsg: 'Failed to delete deal' },
        () => api.delete('/api/crm/deals/' + encodeURIComponent(dealId)),
      );
    },
    createContact(input) {
      return api.post('/api/crm/contacts', input).then((c) => {
        if (c && c.id) setState(s => ({ ...s, contacts: { ...s.contacts, [c.id]: c } }));
        return c;
      });
    },
    saveContact(contactId, patch) {
      return mutate(
        { kind: 'contact', id: contactId, patch, errorMsg: 'Failed to save contact' },
        () => api.patch('/api/crm/contacts/' + encodeURIComponent(contactId), patch),
      );
    },
    deleteContact(contactId) {
      return mutate(
        { kind: 'contact', id: contactId, delete: true, errorMsg: 'Failed to delete contact' },
        () => api.delete('/api/crm/contacts/' + encodeURIComponent(contactId)),
      );
    },
    createCompany(input) {
      return api.post('/api/crm/companies', input).then((c) => {
        if (c && c.id) setState(s => ({ ...s, companies: { ...s.companies, [c.id]: c } }));
        return c;
      });
    },
    saveCompany(companyId, patch) {
      return mutate(
        { kind: 'company', id: companyId, patch, errorMsg: 'Failed to save company' },
        () => api.patch('/api/crm/companies/' + encodeURIComponent(companyId), patch),
      );
    },
    deleteCompany(companyId) {
      return mutate(
        { kind: 'company', id: companyId, delete: true, errorMsg: 'Failed to delete company' },
        () => api.delete('/api/crm/companies/' + encodeURIComponent(companyId)),
      );
    },
    refreshTasks(scope = 'open') {
      return api.get('/api/crm/tasks?scope=' + encodeURIComponent(scope)).then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        setState(s => ({ ...s, tasks: list }));
        return list;
      }).catch(() => []);
    },
    createTask(input) {
      // No optimistic insert — id is server-assigned. Use mutate purely for
      // the rollback/toast scaffolding; onSuccess applies the new row to both
      // state.tasks and the relevant dealDetail.tasks via applyOne.
      return mutate(
        { errorMsg: 'Failed to create task' },
        () => api.post('/api/crm/tasks', input),
        (s, t) => (t && t.id) ? applyOne(s, { kind: 'task', create: t }) : s,
      );
    },
    saveTask(taskId, patch) {
      return mutate(
        { kind: 'task', id: taskId, patch, errorMsg: 'Failed to save task' },
        () => api.patch('/api/crm/tasks/' + encodeURIComponent(taskId), patch),
      );
    },
    toggleTask(taskId) {
      // Bidirectional toggle: ticks an open task done, unticks a done task.
      // The patch is a function so it sees the live doneAt at update time.
      // After API success, refetch the deal in the background so its event
      // timeline picks up the new "task completed" entry.
      let dealIdForReload = null;
      return mutate(
        {
          kind: 'task',
          id: taskId,
          patch: (t) => {
            dealIdForReload = t.dealId || null;
            return { ...t, doneAt: t.doneAt ? null : new Date().toISOString() };
          },
          errorMsg: 'Failed to update task',
        },
        () => api.post('/api/crm/tasks/' + encodeURIComponent(taskId) + '/done', {}),
        (s, t) => {
          if (!t || !t.id) return s;
          const dId = t.dealId || dealIdForReload;
          if (dId) {
            api.get('/api/crm/deals/' + encodeURIComponent(dId)).then((data) => {
              if (data && data.id) {
                setState(st => ({ ...st, dealDetail: { ...st.dealDetail, [dId]: data } }));
              }
            }).catch(() => {});
          }
          return withTaskUpdate(s, t.id, () => t);
        },
      );
    },
    deleteTask(taskId) {
      return mutate(
        { kind: 'task', id: taskId, delete: true, errorMsg: 'Failed to delete task' },
        () => api.delete('/api/crm/tasks/' + encodeURIComponent(taskId)),
      );
    },

    // ---------- Deal comments ----------
    createDealComment(dealId, body, parentId, mentions) {
      return api.post('/api/crm/deals/' + encodeURIComponent(dealId) + '/comments', { body, parentId: parentId || null, mentions: mentions || [] })
        .then(comment => {
          setState(s => {
            const detail = s.dealDetail[dealId];
            if (!detail) return s;
            return { ...s, dealDetail: { ...s.dealDetail, [dealId]: { ...detail, comments: [...(detail.comments || []), comment] } } };
          });
          return comment;
        });
    },
    editDealComment(commentId, dealId, body, mentions) {
      return api.patch('/api/crm/comments/' + encodeURIComponent(commentId), { body, mentions: mentions || [] })
        .then(updated => {
          setState(s => {
            const detail = s.dealDetail[dealId];
            if (!detail) return s;
            // Preserve reactions — edit endpoint doesn't touch them.
            return { ...s, dealDetail: { ...s.dealDetail, [dealId]: { ...detail, comments: (detail.comments || []).map(c => c.id === commentId ? { reactions: c.reactions || {}, ...updated } : c) } } };
          });
          return updated;
        });
    },
    deleteDealComment(commentId, dealId) {
      setState(s => {
        const detail = s.dealDetail[dealId];
        if (!detail) return s;
        return { ...s, dealDetail: { ...s.dealDetail, [dealId]: { ...detail, comments: (detail.comments || []).filter(c => c.id !== commentId) } } };
      });
      return api.delete('/api/crm/comments/' + encodeURIComponent(commentId)).catch(() => {});
    },
    reactToDealComment(commentId, dealId, emoji, userEmail) {
      if (!userEmail) return Promise.resolve();
      // Optimistic toggle — capture snapshot inside the updater so we can revert.
      let snapshot = null;
      setState(s => {
        const detail = s.dealDetail[dealId];
        if (!detail) return s;
        snapshot = detail.comments;
        return {
          ...s,
          dealDetail: {
            ...s.dealDetail,
            [dealId]: {
              ...detail,
              comments: (detail.comments || []).map(c => {
                if (c.id !== commentId) return c;
                const reactions = { ...(c.reactions || {}) };
                if (reactions[emoji]) {
                  const users = reactions[emoji].users || [];
                  const alreadyReacted = users.includes(userEmail);
                  const newUsers = alreadyReacted ? users.filter(u => u !== userEmail) : [...users, userEmail];
                  if (newUsers.length === 0) delete reactions[emoji];
                  else reactions[emoji] = { count: newUsers.length, users: newUsers };
                } else {
                  reactions[emoji] = { count: 1, users: [userEmail] };
                }
                return { ...c, reactions };
              }),
            },
          },
        };
      });
      return api.post('/api/crm/comments/' + encodeURIComponent(commentId) + '/react', { emoji })
        .then(({ reactions }) => {
          setState(s => {
            const detail = s.dealDetail[dealId];
            if (!detail) return s;
            return {
              ...s,
              dealDetail: {
                ...s.dealDetail,
                [dealId]: {
                  ...detail,
                  comments: (detail.comments || []).map(c => c.id === commentId ? { ...c, reactions } : c),
                },
              },
            };
          });
        })
        .catch(() => {
          setState(s => {
            const detail = s.dealDetail[dealId];
            if (!detail || !snapshot) return s;
            return { ...s, dealDetail: { ...s.dealDetail, [dealId]: { ...detail, comments: snapshot } } };
          });
        });
    },

    // ---------- Gmail integration ----------
    refreshGmailAccount() {
      return api.get('/api/crm/gmail').then((data) => {
        setState(s => ({ ...s, gmailAccount: data || null }));
        return data;
      }).catch(() => null);
    },
    connectGmail() {
      // Returns a URL the caller should redirect/open to begin OAuth.
      return api.get('/api/crm/gmail/connect').then((data) => data?.url);
    },
    disconnectGmail() {
      setState(s => ({ ...s, gmailAccount: { connected: false } }));
      return api.post('/api/crm/gmail/disconnect', {}).catch(() => {});
    },
    sendGmail(payload) {
      // payload: { to: string|string[], cc?, bcc?, subject, html, text, dealId? }
      return api.post('/api/crm/gmail/send', payload);
    },
    getGmailSignature() {
      // Returns { signatureHtml, fetchedAt } from the cached gmail_accounts row.
      // The server refreshes this from users.settings.sendAs in the background.
      return api.get('/api/crm/gmail/signature');
    },
    backfillGmail() {
      // Re-trigger the 30-day backfill manually. Idempotent on the server —
      // already-ingested messages no-op via ON CONFLICT.
      return api.post('/api/crm/gmail/backfill', {}).then((r) => {
        // Refresh the status so the UI flips into "Backfilling…" state.
        api.get('/api/crm/gmail').then((data) => {
          setState(s => ({ ...s, gmailAccount: data || null }));
        }).catch(() => {});
        return r;
      });
    },

    // ---------- Triage (unmatched email messages) ----------
    refreshTriage() {
      return api.get('/api/crm/triage').then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        setState(s => ({ ...s, triage: list }));
        return list;
      }).catch(() => []);
    },
    triageAssign(gmailThreadId, dealId) {
      // Optimistic: drop every triage row in this thread.
      setState(s => ({ ...s, triage: s.triage.filter(m => m.gmailThreadId !== gmailThreadId) }));
      return api.post('/api/crm/triage/' + encodeURIComponent(gmailThreadId) + '/assign', { dealId })
        .then(() => {
          // Refresh the deal's detail in the background so the newly-attached
          // thread shows up on its timeline next time it's viewed.
          api.get('/api/crm/deals/' + encodeURIComponent(dealId)).then((data) => {
            if (data && data.id) {
              setState(s => s.dealDetail[dealId]
                ? { ...s, dealDetail: { ...s.dealDetail, [dealId]: data } }
                : s);
            }
          }).catch(() => {});
        })
        .catch(() => {});
    },
    triageDismiss(gmailThreadId) {
      setState(s => ({ ...s, triage: s.triage.filter(m => m.gmailThreadId !== gmailThreadId) }));
      return api.post('/api/crm/triage/' + encodeURIComponent(gmailThreadId) + '/dismiss', {})
        .catch(() => {});
    },

    // ---------- Quote requests ----------
    refreshQuoteRequests(status = 'new') {
      const qs = status ? '?status=' + encodeURIComponent(status) : '';
      return api.get('/api/quote-requests-admin' + qs).then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        setState(s => ({ ...s, quoteRequests: list }));
        return list;
      }).catch(() => []);
    },
    reviewQuoteRequest(id) {
      return api.post('/api/quote-requests-admin/' + encodeURIComponent(id) + '/review', {})
        .then((resp) => {
          if (resp && resp.request) {
            setState(s => ({
              ...s,
              quoteRequests: s.quoteRequests.map(r => r.id === id ? resp.request : r),
              // Stash provisional contact so the modal can show it; also cache in
              // state.contacts is unnecessary (Contacts list filters provisional
              // out server-side), so we deliberately skip that.
            }));
          }
          return resp;
        })
        .catch(() => null);
    },
    qualifyQuoteRequest(id) {
      return api.post('/api/quote-requests-admin/' + encodeURIComponent(id) + '/qualify', {})
        .then((resp) => {
          if (resp && resp.request) {
            setState(s => {
              const nextContacts = resp.contact
                ? { ...s.contacts, [resp.contact.id]: resp.contact }
                : s.contacts;
              const nextDeals = resp.deal
                ? { ...s.deals, [resp.deal.id]: resp.deal }
                : s.deals;
              const nextCompanies = resp.company
                ? { ...s.companies, [resp.company.id]: resp.company }
                : s.companies;
              return {
                ...s,
                quoteRequests: s.quoteRequests.map(r => r.id === id ? resp.request : r),
                contacts: nextContacts,
                deals: nextDeals,
                companies: nextCompanies,
              };
            });
          }
          return resp;
        })
        .catch(() => null);
    },
    disqualifyQuoteRequest(id) {
      // Optimistic: drop the row and any provisional contact it linked to.
      let provContactId = null;
      setState(s => {
        const req = s.quoteRequests.find(r => r.id === id);
        provContactId = req?.contactId || null;
        const contacts = provContactId ? { ...s.contacts } : s.contacts;
        if (provContactId) delete contacts[provContactId];
        return {
          ...s,
          quoteRequests: s.quoteRequests.filter(r => r.id !== id),
          contacts,
        };
      });
      return api.delete('/api/quote-requests-admin/' + encodeURIComponent(id))
        .then(() => true)
        .catch(() => {
          // Best-effort refresh on failure so the UI re-syncs with the server.
          fetchAllRef.current?.();
          return false;
        });
    },

    // ---------- Email body lookup (lazy-loaded for the viewer modal) ----------
    loadEmailBody(gmailMessageId) {
      // Cached: re-opens are instant. The cache key is the immutable message
      // id, so we never need to invalidate.
      return api.get('/api/crm/emails/' + encodeURIComponent(gmailMessageId)).then((data) => {
        if (data && data.gmailMessageId) {
          setState(s => ({ ...s, emailBodies: { ...s.emailBodies, [data.gmailMessageId]: data } }));
        }
        return data;
      });
    },

    // ---------- Deal files ----------
    uploadDealFile(dealId, file) {
      // Sends the binary body raw (not JSON), so it can't go through the
      // shared `api` wrapper. credentials: 'include' attaches the session
      // cookie the same way the wrapper does.
      return fetch('/api/crm/deals/' + encodeURIComponent(dealId) + '/files', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
        body: file,
      }).then(async (res) => {
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Upload failed'); }
        const newFile = await res.json();
        setState(s => {
          const detail = s.dealDetail[dealId];
          if (!detail) return s;
          return { ...s, dealDetail: { ...s.dealDetail, [dealId]: { ...detail, files: [newFile, ...(detail.files || [])] } } };
        });
        return newFile;
      });
    },

    deleteDealFile(dealId, fileId) {
      setState(s => {
        const detail = s.dealDetail[dealId];
        if (!detail) return s;
        return { ...s, dealDetail: { ...s.dealDetail, [dealId]: { ...detail, files: (detail.files || []).filter(f => f.id !== fileId) } } };
      });
      return api.delete('/api/crm/deals/' + encodeURIComponent(dealId) + '/files/' + encodeURIComponent(fileId))
        .catch(() => actions.loadDealDetail(dealId));
    },

    getFileDownloadUrl(dealId, fileId) {
      return api.get('/api/crm/deals/' + encodeURIComponent(dealId) + '/files/' + encodeURIComponent(fileId));
    },

    addDealFileFromEmail(dealId, payload) {
      return api.post('/api/crm/deals/' + encodeURIComponent(dealId) + '/files/from-email', payload)
        .then((newFile) => {
          setState(s => {
            const detail = s.dealDetail[dealId];
            if (!detail) return s;
            return { ...s, dealDetail: { ...s.dealDetail, [dealId]: { ...detail, files: [newFile, ...(detail.files || [])] } } };
          });
          return newFile;
        });
    },

    // ---------- Roles ----------
    refreshRoles() {
      return api.get('/api/roles').then((rows) => {
        const map = {};
        for (const r of (Array.isArray(rows) ? rows : [])) map[r.id] = r;
        setState(s => ({ ...s, roles: map }));
        return map;
      }).catch(() => ({}));
    },
    createRole(input) {
      return api.post('/api/roles', input).then((row) => {
        if (row?.id) setState(s => ({ ...s, roles: { ...s.roles, [row.id]: row } }));
        return row;
      });
    },
    saveRole(id, patch) {
      return api.patch('/api/roles?id=' + encodeURIComponent(id), patch).then((row) => {
        if (row?.id) setState(s => ({ ...s, roles: { ...s.roles, [row.id]: row } }));
        // If the caller is the user whose role we just edited, refresh their
        // session so the new permissions take effect immediately without
        // requiring a re-login.
        api.get('/api/auth/me').then((r) => {
          if (r?.user) setState(s => ({ ...s, session: { ...s.session,
            roleName: r.user.roleName || r.user.role,
            permissions: Array.isArray(r.user.permissions) ? r.user.permissions : [],
          } }));
        }).catch(() => {});
        return row;
      });
    },
    deleteRole(id) {
      return api.delete('/api/roles?id=' + encodeURIComponent(id)).then(() => {
        setState(s => {
          const roles = { ...s.roles };
          delete roles[id];
          return { ...s, roles };
        });
      });
    },

    // ---------- Per-user role change (admin action) ----------
    updateUserRole(email, role) {
      return api.patch('/api/users', { email, role }).then((resp) => {
        setState(s => {
          const cur = s.users[email];
          const next = cur
            ? { ...s, users: { ...s.users, [email]: { ...cur, role } } }
            : s;
          // If the edited user is the current session user, also refresh
          // permissions in-place so the UI gates update immediately.
          if ((s.session?.email || '').toLowerCase() === (email || '').toLowerCase()) {
            api.get('/api/auth/me').then((r) => {
              if (r?.user) setState(s2 => ({ ...s2, session: { ...s2.session,
                role: r.user.role,
                roleName: r.user.roleName || r.user.role,
                permissions: Array.isArray(r.user.permissions) ? r.user.permissions : [],
              } }));
            }).catch(() => {});
          }
          return next;
        });
        return resp;
      });
    },

    // ---------- Per-user notification overrides ----------
    getUserNotifications(email) {
      return api.get('/api/users?_kind=notifications&email=' + encodeURIComponent(email));
    },
    saveUserNotifications(email, overrides) {
      return api.put('/api/users?_kind=notifications&email=' + encodeURIComponent(email), { overrides });
    },

    // ---------- Proposal client resolver ----------
    // Used by ClientLinkPanel in the builder. POSTs the typed clientName /
    // businessName to /api/crm/resolve-client, then merges any newly-created
    // contact / company into local state so the rest of the UI sees them
    // immediately. Returns the same envelope the server returns.
    resolveProposalClient({ clientName, businessName, proposalId }) {
      return api.post('/api/crm/resolve-client', { clientName, businessName, proposalId }).then((resp) => {
        setState(s => {
          let contacts = s.contacts;
          let companies = s.companies;
          if (resp?.contact) {
            contacts = { ...s.contacts, [resp.contact.id]: resp.contact };
          }
          if (resp?.company) {
            companies = { ...s.companies, [resp.company.id]: resp.company };
          }
          return { ...s, contacts, companies };
        });
        return resp;
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
