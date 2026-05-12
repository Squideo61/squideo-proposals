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
    // CRM
    deals: {},
    contacts: {},
    companies: {},
    tasks: [],
    dealDetail: {},
    gmailAccount: null,
    triage: [],
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
      api.get('/api/crm/deals').catch(() => []),
      api.get('/api/crm/contacts').catch(() => []),
      api.get('/api/crm/companies').catch(() => []),
      api.get('/api/crm/tasks?scope=open').catch(() => []),
      api.get('/api/crm/gmail').catch(() => null),
      api.get('/api/crm/triage').catch(() => []),
    ]).then(([proposals, templates, settings, users, deals, contacts, companies, tasks, gmailAccount, triage]) => {
      const dealsMap = {};
      for (const d of (Array.isArray(deals) ? deals : [])) dealsMap[d.id] = d;
      const contactsMap = {};
      for (const c of (Array.isArray(contacts) ? contacts : [])) contactsMap[c.id] = c;
      const companiesMap = {};
      for (const c of (Array.isArray(companies) ? companies : [])) companiesMap[c.id] = c;
      setState(s => ({
        ...s,
        proposals: proposals || {},
        templates: templates || {},
        users: users || {},
        deals: dealsMap,
        contacts: contactsMap,
        companies: companiesMap,
        tasks: Array.isArray(tasks) ? tasks : [],
        gmailAccount: gmailAccount || null,
        triage: Array.isArray(triage) ? triage : [],
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
      // Optimistic merge — Kanban drag-and-edit feels instant.
      setState(s => {
        const cur = s.deals[dealId];
        if (!cur) return s;
        return { ...s, deals: { ...s.deals, [dealId]: { ...cur, ...patch } } };
      });
      return api.patch('/api/crm/deals/' + encodeURIComponent(dealId), patch).then((deal) => {
        if (deal && deal.id) {
          setState(s => ({ ...s, deals: { ...s.deals, [deal.id]: deal } }));
        }
        return deal;
      }).catch(() => {});
    },
    moveDealStage(dealId, stage, lostReason) {
      setState(s => {
        const cur = s.deals[dealId];
        if (!cur) return s;
        const patch = { stage, stageChangedAt: new Date().toISOString(), lostReason: lostReason || null };
        const existingDetail = s.dealDetail[dealId];
        return {
          ...s,
          deals: { ...s.deals, [dealId]: { ...cur, ...patch } },
          dealDetail: existingDetail
            ? { ...s.dealDetail, [dealId]: { ...existingDetail, ...patch } }
            : s.dealDetail,
        };
      });
      return api.post('/api/crm/deals/' + encodeURIComponent(dealId) + '/stage', { stage, lostReason }).then((resp) => {
        if (resp?.deal) {
          setState(s => ({ ...s, deals: { ...s.deals, [dealId]: resp.deal } }));
        }
        return resp;
      }).catch(() => {});
    },
    deleteDeal(dealId) {
      setState(s => {
        const deals = { ...s.deals }; delete deals[dealId];
        const dealDetail = { ...s.dealDetail }; delete dealDetail[dealId];
        return { ...s, deals, dealDetail };
      });
      return api.delete('/api/crm/deals/' + encodeURIComponent(dealId)).catch(() => {});
    },
    createContact(input) {
      return api.post('/api/crm/contacts', input).then((c) => {
        if (c && c.id) setState(s => ({ ...s, contacts: { ...s.contacts, [c.id]: c } }));
        return c;
      });
    },
    saveContact(contactId, patch) {
      setState(s => {
        const cur = s.contacts[contactId];
        if (!cur) return s;
        return { ...s, contacts: { ...s.contacts, [contactId]: { ...cur, ...patch } } };
      });
      return api.patch('/api/crm/contacts/' + encodeURIComponent(contactId), patch).then((c) => {
        if (c && c.id) setState(s => ({ ...s, contacts: { ...s.contacts, [c.id]: c } }));
        return c;
      }).catch(() => {});
    },
    deleteContact(contactId) {
      setState(s => {
        const contacts = { ...s.contacts }; delete contacts[contactId];
        return { ...s, contacts };
      });
      return api.delete('/api/crm/contacts/' + encodeURIComponent(contactId)).catch(() => {});
    },
    createCompany(input) {
      return api.post('/api/crm/companies', input).then((c) => {
        if (c && c.id) setState(s => ({ ...s, companies: { ...s.companies, [c.id]: c } }));
        return c;
      });
    },
    saveCompany(companyId, patch) {
      setState(s => {
        const cur = s.companies[companyId];
        if (!cur) return s;
        return { ...s, companies: { ...s.companies, [companyId]: { ...cur, ...patch } } };
      });
      return api.patch('/api/crm/companies/' + encodeURIComponent(companyId), patch).then((c) => {
        if (c && c.id) setState(s => ({ ...s, companies: { ...s.companies, [c.id]: c } }));
        return c;
      }).catch(() => {});
    },
    deleteCompany(companyId) {
      setState(s => {
        const companies = { ...s.companies }; delete companies[companyId];
        return { ...s, companies };
      });
      return api.delete('/api/crm/companies/' + encodeURIComponent(companyId)).catch(() => {});
    },
    refreshTasks(scope = 'open') {
      return api.get('/api/crm/tasks?scope=' + encodeURIComponent(scope)).then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        setState(s => ({ ...s, tasks: list }));
        return list;
      }).catch(() => []);
    },
    createTask(input) {
      return api.post('/api/crm/tasks', input).then((t) => {
        if (t && t.id) {
          setState(s => {
            const next = { ...s, tasks: [t, ...s.tasks] };
            if (t.dealId && s.dealDetail[t.dealId]) {
              next.dealDetail = {
                ...s.dealDetail,
                [t.dealId]: {
                  ...s.dealDetail[t.dealId],
                  tasks: [t, ...(s.dealDetail[t.dealId].tasks || [])],
                },
              };
            }
            return next;
          });
        }
        return t;
      });
    },
    saveTask(taskId, patch) {
      setState(s => withTaskUpdate(s, taskId, (t) => ({ ...t, ...patch })));
      return api.patch('/api/crm/tasks/' + encodeURIComponent(taskId), patch).then((t) => {
        if (t && t.id) setState(s => withTaskUpdate(s, t.id, () => t));
        return t;
      }).catch(() => {});
    },
    toggleTask(taskId) {
      // Bidirectional toggle: ticks an open task done, unticks a done task.
      // Optimistic update, then API call (atomic on the server), then a
      // background reload of the affected deal to refresh its timeline.
      let dealIdForReload = null;
      setState(s => {
        const cur = s.tasks.find(t => t.id === taskId)
          || Object.values(s.dealDetail || {}).flatMap(d => d?.tasks || []).find(t => t.id === taskId);
        if (!cur) return s;
        dealIdForReload = cur.dealId || null;
        const nextDoneAt = cur.doneAt ? null : new Date().toISOString();
        return withTaskUpdate(s, taskId, (t) => ({ ...t, doneAt: nextDoneAt }));
      });
      return api.post('/api/crm/tasks/' + encodeURIComponent(taskId) + '/done', {}).then((t) => {
        if (t && t.id) {
          setState(s => withTaskUpdate(s, t.id, () => t));
          const dId = t.dealId || dealIdForReload;
          if (dId) {
            api.get('/api/crm/deals/' + encodeURIComponent(dId)).then((data) => {
              if (data && data.id) {
                setState(s => ({ ...s, dealDetail: { ...s.dealDetail, [dId]: data } }));
              }
            }).catch(() => {});
          }
        }
        return t;
      }).catch(() => {});
    },
    deleteTask(taskId) {
      setState(s => withTaskUpdate(s, taskId, () => null));
      return api.delete('/api/crm/tasks/' + encodeURIComponent(taskId)).catch(() => {});
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
            return { ...s, dealDetail: { ...s.dealDetail, [dealId]: { ...detail, comments: (detail.comments || []).map(c => c.id === commentId ? updated : c) } } };
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
      const token = getToken();
      return fetch('/api/crm/deals/' + encodeURIComponent(dealId) + '/files', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
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
