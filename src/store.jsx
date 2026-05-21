import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PROPOSAL } from './defaults.js';
import { api } from './api.js';
import { permissionsInclude } from './lib/permissions.js';

const StoreContext = createContext(null);

// Persistent slices live in localStorage so they survive page reloads:
//   composerContext — the {dealId, dealTitle, contactEmail, initialDraft?}
//   set when the user clicks Send email. Stays non-null until the user
//   sends, saves as draft, or discards — even across CRM navigation.
//   drafts          — the user's saved drafts list.
const COMPOSER_CONTEXT_KEY = 'sq_composer_context';
const DRAFTS_KEY = 'sq_email_drafts';

function loadLocal(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function saveLocal(key, value) {
  if (typeof window === 'undefined') return;
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch { /* quota / disabled — ignore */ }
}

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
    // Pending scheduled emails, keyed by deal id (for the deal-page card).
    scheduledEmails: {},
    // Reusable email templates (composer "Templates" menu).
    emailTemplates: [],
    // Video revisions (Frame.io-style client revision links)
    revisions: [],
    revisionDetail: {},
    gmailAccount: null,
    triage: [],
    quoteRequests: [],
    emailBodies: {},
    // Emails section. mailbox is keyed by folder id ('deals' | 'inbox' |
    // 'sent' | 'drafts' | 'starred' | 'spam' | 'trash' | 'all') →
    // { rows, next, loading, loaded } where each row is a CONVERSATION summary
    // and `next` is an opaque cursor (a numeric offset for the DB-backed Deals
    // folder, a Gmail pageToken for the live folders). threadCache holds opened
    // conversations keyed by thread id → { subject, messages }; mailboxLabels
    // holds unread/total counts for the sidebar badges.
    mailbox: {},
    threadCache: {},
    mailboxLabels: {},
    // Deal association per email thread (extension-style chips + right panel),
    // gmailThreadId → [{ dealId, title, stage, source }]. source 'explicit' =
    // an email_thread_deals link; 'contact' = the sender matches a deal contact.
    threadDeals: {},
    notificationRecipients: [],
    revisionCallUrl: '',
    extrasBank: [],
    inclusionsBank: [],
    leaderboard: null,
    partnerCreditsList: null,
    partnerCreditDetail: {},
    // In-app notification feed (the bell). notifications: newest-first list,
    // notificationsUnread: server-reported unread count.
    notifications: [],
    notificationsUnread: 0,
    session: null,
    loading: true,
    composerContext: loadLocal(COMPOSER_CONTEXT_KEY, null),
    drafts: loadLocal(DRAFTS_KEY, []),
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
        revisionCallUrl: settings?.revisionCallUrl || '',
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
      api.get('/api/notifications').then((r) => {
        if (cancelled || !r) return;
        setState(s => ({ ...s, notifications: Array.isArray(r.items) ? r.items : [], notificationsUnread: r.unread || 0 }));
      }).catch(() => {});
    };
    refresh(); // prime immediately so the bell badge is populated on load
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);

    // Instant updates on email-driven actions. The one-click Qualify /
    // Disqualify pages broadcast 'squideo:quote-request-actioned' so any
    // already-open CRM tab can refresh without waiting for the 60s poll. We
    // listen on BroadcastChannel (modern browsers) and the localStorage
    // 'storage' event (fallback). The QuoteRequestsView has its own
    // current-filter listener; we only refresh the 'new' slice here, which
    // is what the nav badge reads.
    const onBroadcast = (msg) => {
      if (!msg || msg.type !== 'squideo:quote-request-actioned') return;
      refresh();
      if (msg.action === 'qualify') {
        // A new deal was created — pull it in so it surfaces in the deals
        // list without a manual refresh. Inlined (rather than going through
        // actions.refreshDeals) because `actions` is defined further down
        // this file and the closure timing makes that fragile.
        api.get('/api/crm/deals').then((rows) => {
          if (cancelled) return;
          const map = {};
          for (const d of (Array.isArray(rows) ? rows : [])) map[d.id] = d;
          setState(s => ({ ...s, deals: map }));
        }).catch(() => {});
      }
    };
    let bc = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel('squideo');
        bc.onmessage = (e) => onBroadcast(e.data);
      }
    } catch { /* ignore */ }
    const onStorage = (e) => {
      if (e.key !== 'squideo:event' || !e.newValue) return;
      try { onBroadcast(JSON.parse(e.newValue)); } catch { /* ignore */ }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', onStorage);
      if (bc) { try { bc.close(); } catch { /* ignore */ } }
    };
  }, [state.session]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // Wipe persisted composer + drafts so a shared machine doesn't leak
      // the previous user's in-progress mail to whoever logs in next.
      saveLocal(COMPOSER_CONTEXT_KEY, null);
      saveLocal(DRAFTS_KEY, []);
      setState({ ...emptyStore(), loading: false, composerContext: null, drafts: [] });
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
    // Toggle a proposal's archived flag. PUT replaces the whole data blob, so
    // we send the full proposal (minus client-only metadata) with archived set,
    // optimistically updating state and reverting on failure.
    setProposalArchived(id, archived) {
      let payload = null;
      setState(s => {
        const cur = s.proposals[id];
        if (!cur) return s;
        const next = { ...cur, archived };
        payload = next;
        return { ...s, proposals: { ...s.proposals, [id]: next } };
      });
      if (!payload) return Promise.resolve();
      const body = { ...payload };
      delete body._number; delete body._views; delete body._createdAt;
      return api.put('/api/proposals/' + id, body).catch((err) => {
        // Revert the optimistic flip on failure.
        setState(s => {
          const cur = s.proposals[id];
          if (!cur) return s;
          return { ...s, proposals: { ...s.proposals, [id]: { ...cur, archived: !archived } } };
        });
        throw err;
      });
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
    markMonthPaid(clientKey, subId, input = {}) {
      return api.post('/api/partner/mark-month-paid?id=' + encodeURIComponent(subId), input).then((row) => {
        applyOptimisticAllocationChange(setState, clientKey, (allocations) => [row, ...allocations]);
        return row;
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
    // Toggle a company's manual "customer" flag. Optimistically patches the
    // local row (so the badge flips immediately) then merges the server's
    // canonical response — which also recomputes hasSignedProposal / isCustomer.
    setCompanyCustomerVerified(companyId, verified) {
      return mutate(
        {
          kind: 'company',
          id: companyId,
          patch: {
            customerVerifiedAt: verified ? new Date().toISOString() : null,
            isCustomer: verified || undefined, // server recomputes; optimistic only
          },
          errorMsg: 'Failed to update customer status',
        },
        () => api.patch(
          '/api/crm/companies/' + encodeURIComponent(companyId),
          { customerVerified: !!verified },
        ),
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
      // payload: { to: string|string[], cc?, bcc?, subject, html, text, dealId?, attachments? }
      return api.post('/api/crm/gmail/send', payload);
    },
    // Upload one attachment to the temporary email-attachments blob namespace.
    // Sends the binary raw (not JSON) like uploadDealFile. Returns the ref
    // { filename, mimeType, sizeBytes, blobUrl, blobPathname } the composer
    // stashes and later passes to send/schedule.
    uploadEmailAttachment(file) {
      return fetch('/api/crm/gmail/attachments', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
        body: file,
      }).then(async (res) => {
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Upload failed'); }
        return res.json();
      });
    },
    deleteEmailAttachment(pathname) {
      if (!pathname) return Promise.resolve();
      return api.delete('/api/crm/gmail/attachments?pathname=' + encodeURIComponent(pathname)).catch(() => {});
    },
    // Schedule an email to send at a future time. payload mirrors sendGmail
    // plus { scheduledFor: ISO string }.
    scheduleGmail(payload) {
      return api.post('/api/crm/gmail/schedule', payload);
    },
    loadScheduledEmails(dealId) {
      return api.get('/api/crm/gmail/schedule?dealId=' + encodeURIComponent(dealId))
        .then((rows) => {
          const list = Array.isArray(rows) ? rows : [];
          setState(s => ({ ...s, scheduledEmails: { ...s.scheduledEmails, [dealId]: list } }));
          return list;
        })
        .catch(() => {});
    },
    cancelScheduledEmail(dealId, id) {
      setState(s => {
        const cur = (s.scheduledEmails && s.scheduledEmails[dealId]) || [];
        return { ...s, scheduledEmails: { ...s.scheduledEmails, [dealId]: cur.filter(e => e.id !== id) } };
      });
      return api.delete('/api/crm/gmail/schedule?id=' + encodeURIComponent(id))
        .catch(() => actions.loadScheduledEmails(dealId));
    },

    // ---------- Email templates (composer Templates menu) ----------
    loadEmailTemplates() {
      return api.get('/api/crm/templates')
        .then((rows) => {
          const list = Array.isArray(rows) ? rows : [];
          setState(s => ({ ...s, emailTemplates: list }));
          return list;
        })
        .catch(() => []);
    },
    saveEmailTemplate({ name, subject, bodyHtml, bodyText, visibility = 'team' }) {
      return api.post('/api/crm/templates', { name, subject, bodyHtml, bodyText, visibility })
        .then((tpl) => {
          setState(s => ({ ...s, emailTemplates: [...(s.emailTemplates || []), tpl].sort((a, b) => (a.name || '').localeCompare(b.name || '')) }));
          return tpl;
        });
    },
    // Overwrite an existing template (PATCH). Used by the composer's "overwrite"
    // action so the user can update a saved template with the current email.
    updateEmailTemplate(id, { name, subject, bodyHtml, bodyText }) {
      const payload = {};
      if (name !== undefined) payload.name = name;
      if (subject !== undefined) payload.subject = subject;
      if (bodyHtml !== undefined) payload.bodyHtml = bodyHtml;
      if (bodyText !== undefined) payload.bodyText = bodyText;
      return api.patch('/api/crm/templates/' + encodeURIComponent(id), payload)
        .then((tpl) => {
          setState(s => ({ ...s, emailTemplates: (s.emailTemplates || []).map(t => t.id === id ? tpl : t) }));
          return tpl;
        });
    },
    deleteEmailTemplate(id) {
      setState(s => ({ ...s, emailTemplates: (s.emailTemplates || []).filter(t => t.id !== id) }));
      return api.delete('/api/crm/templates/' + encodeURIComponent(id))
        .catch(() => actions.loadEmailTemplates());
    },
    getGmailSignature() {
      // Returns { signatureHtml, fetchedAt, diagnostics? } from the cached
      // gmail_accounts row. When the cache is null, the server force-refreshes
      // inline (with a 5-minute throttle) and includes diagnostics so the UI
      // can explain why Gmail returned nothing.
      return api.get('/api/crm/gmail/signature');
    },
    refreshGmailSignature() {
      // Force-refresh from Gmail and return the new value + diagnostics.
      return api.post('/api/crm/gmail/signature', {});
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
    // Attach a thread (or a single message) to another deal. The server
    // upserts the join row; idempotent. No optimistic patch — the current
    // deal's email list doesn't change, only the target deal's does, and
    // the toast confirms success.
    linkEmail({ threadId, gmailMessageId = null, dealId, scope = 'thread' }) {
      return api.post(
        '/api/crm/threads/' + encodeURIComponent(threadId) + '/link',
        { dealId, scope, gmailMessageId },
      );
    },
    unlinkEmail({ threadId, gmailMessageId = null, dealId, scope = 'thread' }) {
      const qs = new URLSearchParams({ dealId, scope });
      if (gmailMessageId) qs.set('gmailMessageId', gmailMessageId);
      return api.delete(
        '/api/crm/threads/' + encodeURIComponent(threadId) + '/link?' + qs.toString(),
      );
    },

    // ---------- Email composer + drafts ----------
    // The composer is mounted at App level so it survives CRM navigation —
    // these actions wire up its open/close lifecycle. composerContext stays
    // non-null while the composer is alive, which is what App reads to keep
    // the floating dock visible.
    openComposer({ dealId, dealTitle, contactEmail = null, initialDraft = null } = {}) {
      // sessionId changes every time we (re-)open the composer so the host
      // can use it as a React key — that forces the modal to remount when
      // the user resumes a different draft, even if it's currently open.
      // A no-op open for the same deal would still re-key; the caller
      // should guard against that itself if needed.
      const ctx = {
        dealId: dealId || null,
        dealTitle: dealTitle || null,
        contactEmail,
        initialDraft,
        sessionId: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      };
      saveLocal(COMPOSER_CONTEXT_KEY, ctx);
      setState((s) => ({ ...s, composerContext: ctx }));
    },
    closeComposer() {
      saveLocal(COMPOSER_CONTEXT_KEY, null);
      setState((s) => ({ ...s, composerContext: null }));
    },
    // Snapshot the composer's current form state into the drafts list and
    // close the composer. The composer passes the snapshot in because the
    // form state lives inside it; the store just owns the persistent list.
    saveDraft(snapshot) {
      const draft = {
        id: 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        savedAt: new Date().toISOString(),
        ...snapshot,
      };
      setState((s) => {
        const drafts = [draft, ...(s.drafts || [])];
        saveLocal(DRAFTS_KEY, drafts);
        saveLocal(COMPOSER_CONTEXT_KEY, null);
        return { ...s, drafts, composerContext: null };
      });
      return draft;
    },
    discardDraft(id) {
      setState((s) => {
        const drafts = (s.drafts || []).filter((d) => d.id !== id);
        saveLocal(DRAFTS_KEY, drafts);
        return { ...s, drafts };
      });
    },
    // Re-open the composer with this draft's contents and remove it from
    // the list (so we don't end up with two copies — the user can re-save
    // when they're done).
    resumeDraft(id) {
      setState((s) => {
        const draft = (s.drafts || []).find((d) => d.id === id);
        if (!draft) return s;
        const drafts = (s.drafts || []).filter((d) => d.id !== id);
        const ctx = {
          dealId: draft.dealId || null,
          dealTitle: draft.dealTitle || null,
          contactEmail: draft.contactEmail || null,
          initialDraft: draft,
          sessionId: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        };
        saveLocal(DRAFTS_KEY, drafts);
        saveLocal(COMPOSER_CONTEXT_KEY, ctx);
        return { ...s, drafts, composerContext: ctx };
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

    // ---------- Emails section (mailbox folders) ----------
    // The DB-backed "Deals" folder: emails linked to active deals. Pass a
    // cursor (the previous response's nextCursor) to append the next page.
    loadDealEmails(cursor = null) {
      const append = cursor != null;
      setState(s => ({ ...s, mailbox: { ...s.mailbox, deals: { ...(s.mailbox?.deals || {}), loading: true } } }));
      return api.get('/api/crm/emails' + (append ? '?cursor=' + encodeURIComponent(cursor) : ''))
        .then((data) => {
          const incoming = Array.isArray(data?.rows) ? data.rows : [];
          setState(s => {
            const prev = s.mailbox?.deals || {};
            const rows = append ? [...(prev.rows || []), ...incoming] : incoming;
            return { ...s, mailbox: { ...s.mailbox, deals: { rows, next: data?.nextCursor ?? null, loading: false, loaded: true } } };
          });
          return data;
        })
        .catch((err) => {
          setState(s => ({ ...s, mailbox: { ...s.mailbox, deals: { ...(s.mailbox?.deals || {}), loading: false, loaded: true, error: err?.message || 'Failed to load' } } }));
        });
    },
    // A live Gmail folder. Pass a pageToken to append the next page; pass q to
    // search within the folder (Gmail search syntax).
    loadMailboxFolder(folder, { pageToken = null, q = '' } = {}) {
      const append = pageToken != null;
      setState(s => ({ ...s, mailbox: { ...s.mailbox, [folder]: { ...(s.mailbox?.[folder] || {}), loading: true } } }));
      const params = new URLSearchParams({ label: folder });
      if (pageToken) params.set('pageToken', pageToken);
      if (q) params.set('q', q);
      return api.get('/api/crm/gmail/folder?' + params.toString())
        .then((data) => {
          const incoming = Array.isArray(data?.rows) ? data.rows : [];
          setState(s => {
            const prev = s.mailbox?.[folder] || {};
            const rows = append ? [...(prev.rows || []), ...incoming] : incoming;
            return { ...s, mailbox: { ...s.mailbox, [folder]: { rows, next: data?.nextPageToken ?? null, loading: false, loaded: true } } };
          });
          return data;
        })
        .catch((err) => {
          setState(s => ({ ...s, mailbox: { ...s.mailbox, [folder]: { ...(s.mailbox?.[folder] || {}), loading: false, loaded: true, error: err?.message || 'Failed to load' } } }));
        });
    },
    // Full conversation for a live Gmail thread → { id, subject, messages[] }.
    loadMailboxThread(threadId) {
      return api.get('/api/crm/gmail/thread?id=' + encodeURIComponent(threadId)).then((data) => {
        if (data && data.id) setState(s => ({ ...s, threadCache: { ...s.threadCache, [data.id]: data } }));
        return data;
      });
    },
    // Full conversation for a DB-backed (Deals/Triage) thread, same shape.
    loadDealThread(threadId) {
      return api.get('/api/crm/emails?threadId=' + encodeURIComponent(threadId)).then((data) => {
        if (data && data.id) setState(s => ({ ...s, threadCache: { ...s.threadCache, [data.id]: data } }));
        return data;
      });
    },
    // Apply a Gmail action to one or more message ids, with an optimistic
    // update of the affected folder. Actions that move a message out of the
    // current folder drop the row; flag toggles (read/star) update in place.
    mailboxAction(folder, action, ids) {
      const idList = Array.isArray(ids) ? ids : [ids];
      const idSet = new Set(idList);
      const removesFromFolder = (
        (action === 'archive'  && folder === 'inbox') ||
        (action === 'trash'    && folder !== 'trash') ||
        (action === 'spam'     && folder !== 'spam') ||
        (action === 'unspam'   && folder === 'spam') ||
        (action === 'untrash'  && folder === 'trash') ||
        (action === 'unstar'   && folder === 'starred') ||
        (action === 'markRead' && folder === 'unread')
      );
      setState(s => {
        const f = s.mailbox?.[folder];
        if (!f || !Array.isArray(f.rows)) return s;
        const rows = removesFromFolder
          ? f.rows.filter(r => !idSet.has(r.id))
          : f.rows.map(r => {
              if (!idSet.has(r.id)) return r;
              if (action === 'markRead')   return { ...r, unread: false };
              if (action === 'markUnread') return { ...r, unread: true };
              if (action === 'star')       return { ...r, starred: true };
              if (action === 'unstar')     return { ...r, starred: false };
              return r;
            });
        return { ...s, mailbox: { ...s.mailbox, [folder]: { ...f, rows } } };
      });
      return api.post('/api/crm/gmail/modify', { action, ids: idList })
        .then((r) => { actions.loadMailboxLabels(); return r; }) // keep sidebar counts honest
        .catch((err) => {
          // Re-sync the folder so the optimistic change doesn't stick on error.
          actions.loadMailboxFolder(folder);
          throw err;
        });
    },
    // Unread/total counts for the folder sidebar badges.
    loadMailboxLabels() {
      return api.get('/api/crm/gmail/labels')
        .then((data) => { setState(s => ({ ...s, mailboxLabels: data || {} })); return data; })
        .catch(() => {});
    },

    // ---------- Deal association for email threads (extension chips + panel) ----------
    // Batch-resolve which deal(s) each thread belongs to. items: [{ threadId,
    // senderEmails }]. Mirrors the extension's chip resolver — explicit links
    // win, otherwise sender→contact matches surface as 'contact' suggestions.
    resolveThreadDeals(items) {
      const list = Array.isArray(items) ? items.filter(i => i && i.threadId) : [];
      if (!list.length) return Promise.resolve({});
      return api.post('/api/crm/threads/resolve', { items: list })
        .then((byThread) => {
          const map = (byThread && typeof byThread === 'object') ? byThread : {};
          setState(s => {
            const next = { ...s.threadDeals };
            // Record every requested thread (even empty) so we don't refetch.
            for (const it of list) next[it.threadId] = Array.isArray(map[it.threadId]) ? map[it.threadId] : [];
            return { ...s, threadDeals: next };
          });
          return map;
        })
        .catch(() => ({}));
    },
    // Attach a thread to a deal via the snapshot endpoint (same as the
    // extension) — works whether or not the thread has been synced yet, since
    // it upserts the thread row first. Drops the cached association so it
    // re-resolves with the new link.
    attachThreadToDeal({ gmailThreadId, counterpartyEmail, dealId }) {
      return api.post('/api/crm/threads', {
        gmailThreadId,
        gmailMessageId: gmailThreadId + ':panel-stub',
        dealId,
        fromEmail: counterpartyEmail || null,
        direction: 'inbound',
        sentAt: new Date().toISOString(),
      }).then((r) => {
        setState(s => { const t = { ...s.threadDeals }; delete t[gmailThreadId]; return { ...s, threadDeals: t }; });
        return r;
      });
    },
    detachThreadFromDeal({ gmailThreadId, dealId }) {
      return api.delete('/api/crm/threads/' + encodeURIComponent(gmailThreadId) + '?dealId=' + encodeURIComponent(dealId))
        .then((r) => {
          setState(s => { const t = { ...s.threadDeals }; delete t[gmailThreadId]; return { ...s, threadDeals: t }; });
          return r;
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

    // ---------- Video revisions (client revision links) ----------
    loadRevisions() {
      return api.get('/api/revisions/projects')
        .then((list) => { setState(s => ({ ...s, revisions: list || [] })); return list; })
        .catch(() => {});
    },

    createRevisionProject(payload) {
      return api.post('/api/revisions/projects', payload).then((project) => {
        setState(s => ({ ...s, revisions: [project, ...(s.revisions || [])] }));
        return project;
      });
    },

    deleteRevisionProject(id) {
      setState(s => ({ ...s, revisions: (s.revisions || []).filter(p => p.id !== id) }));
      return api.delete('/api/revisions/projects?id=' + encodeURIComponent(id))
        .catch(() => actions.loadRevisions());
    },

    loadRevisionDetail(id) {
      return api.get('/api/revisions/detail?id=' + encodeURIComponent(id))
        .then((detail) => {
          setState(s => ({ ...s, revisionDetail: { ...s.revisionDetail, [id]: detail } }));
          return detail;
        });
    },

    // Add / remove videos within a project. Both reload the project detail so
    // the nested videos→drafts structure stays in sync.
    createRevisionVideo(projectId, title) {
      return api.post('/api/revisions/videos?projectId=' + encodeURIComponent(projectId), { title })
        .then((video) => actions.loadRevisionDetail(projectId).then(() => video));
    },

    deleteRevisionVideo(projectId, videoId) {
      return api.delete('/api/revisions/videos?id=' + encodeURIComponent(videoId))
        .then(() => actions.loadRevisionDetail(projectId))
        .catch(() => actions.loadRevisionDetail(projectId));
    },

    // Streams a draft straight to Vercel Blob (bypassing the serverless body
    // limit), registers it under a video, then reloads the project detail.
    // `onProgress` receives 0–100.
    async uploadRevisionVersion(projectId, videoId, file, { label = null, onProgress } = {}) {
      const { upload } = await import('@vercel/blob/client');
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = await upload('revision-videos/' + videoId + '/' + safeName, file, {
        access: 'public',
        handleUploadUrl: '/api/revisions/upload-token',
        contentType: file.type || 'video/mp4',
        // Chunk the file into parts. Videos are large; a single-shot PUT to the
        // Blob API fails (server rejects the oversized body with no CORS header,
        // which the browser surfaces as a CORS error and the SDK retries in a
        // loop). Multipart uploads each chunk separately and resumes cleanly.
        multipart: true,
        onUploadProgress: onProgress ? (e) => onProgress(Math.round(e.percentage)) : undefined,
      });
      const version = await api.post(
        '/api/revisions/versions?videoId=' + encodeURIComponent(videoId),
        { blobUrl: blob.url, blobPathname: blob.pathname, filename: file.name,
          mimeType: file.type || null, sizeBytes: file.size, label }
      );
      await actions.loadRevisionDetail(projectId);
      return version;
    },

    deleteRevisionVersion(projectId, versionId) {
      return api.delete('/api/revisions/versions?id=' + encodeURIComponent(versionId))
        .then(() => actions.loadRevisionDetail(projectId))
        .catch(() => actions.loadRevisionDetail(projectId));
    },

    // ---------- Public revision viewer (no auth) ----------
    loadPublicRevision(token) {
      setState(s => ({ ...s, loading: true }));
      return api.get('/api/revisions/public?token=' + encodeURIComponent(token))
        .then((data) => { setState(s => ({ ...s, loading: false })); return data; })
        .catch((err) => { setState(s => ({ ...s, loading: false })); throw err; });
    },

    postRevisionComment(token, payload) {
      return api.post('/api/revisions/comment?token=' + encodeURIComponent(token), payload);
    },

    // Name + email gate: records the viewer before they see the videos.
    recordRevisionViewer(token, { name, email }) {
      return api.post('/api/revisions/viewer?token=' + encodeURIComponent(token), { name, email });
    },

    // Client finalises one video (locks further comments on its drafts).
    approveRevision(token, videoId, approvedBy) {
      return api.post('/api/revisions/approve?token=' + encodeURIComponent(token), { videoId, approvedBy });
    },

    // Records that the viewer opened a specific draft (per-draft view tracking).
    recordRevisionView(token, payload) {
      return api.post('/api/revisions/view?token=' + encodeURIComponent(token), payload).catch(() => {});
    },

    // Workspace-wide booking link for the "Schedule Review Call" button.
    saveRevisionCallUrl(url) {
      setState(s => ({ ...s, revisionCallUrl: url }));
      return api.put('/api/settings', { revisionCallUrl: url }).catch(() => {});
    },

    // Uploads a comment's supporting asset straight to the public revision Blob
    // store (gated by the share token), returning { url, name, type }.
    async uploadRevisionAsset(token, file, { onProgress } = {}) {
      const { upload } = await import('@vercel/blob/client');
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = await upload('revision-assets/' + token + '/' + Date.now() + '-' + safeName, file, {
        access: 'public',
        handleUploadUrl: '/api/revisions/asset-token?token=' + encodeURIComponent(token),
        contentType: file.type || 'application/octet-stream',
        multipart: true,
        onUploadProgress: onProgress ? (e) => onProgress(Math.round(e.percentage)) : undefined,
      });
      return { url: blob.url, name: file.name, type: file.type || null };
    },

    // ---------- Secondary contacts on a deal ----------
    // `payload` is either { contactId } to link an existing CRM contact, or
    // { email, name?, title?, companyId? } to create a new contact and link
    // it in one round-trip. The server upserts so a duplicate is a no-op.
    addDealContact(dealId, payload) {
      return api.post('/api/crm/deals/' + encodeURIComponent(dealId) + '/contacts', payload)
        .then((contact) => {
          if (!contact || !contact.id) return contact;
          setState(s => {
            const detail = s.dealDetail[dealId];
            const contacts = { ...s.contacts, [contact.id]: contact };
            if (!detail) return { ...s, contacts };
            const existing = detail.secondaryContacts || [];
            const next = existing.some(c => c.id === contact.id)
              ? existing
              : [...existing, contact];
            return {
              ...s,
              contacts,
              dealDetail: { ...s.dealDetail, [dealId]: { ...detail, secondaryContacts: next } },
            };
          });
          return contact;
        });
    },
    removeDealContact(dealId, contactId) {
      setState(s => {
        const detail = s.dealDetail[dealId];
        if (!detail) return s;
        return {
          ...s,
          dealDetail: {
            ...s.dealDetail,
            [dealId]: {
              ...detail,
              secondaryContacts: (detail.secondaryContacts || []).filter(c => c.id !== contactId),
            },
          },
        };
      });
      return api.delete('/api/crm/deals/' + encodeURIComponent(dealId) + '/contacts/' + encodeURIComponent(contactId))
        .catch(() => actions.loadDealDetail(dealId));
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

    // ---------- In-app notification feed (the bell) ----------
    loadNotifications() {
      return api.get('/api/notifications').then((r) => {
        setState(s => ({ ...s, notifications: Array.isArray(r?.items) ? r.items : [], notificationsUnread: r?.unread || 0 }));
        return r;
      });
    },
    // Optimistically flag the given ids read and recompute the badge from the
    // loaded list, then persist. Server failure is non-fatal — the next poll
    // reconciles.
    markNotificationsRead(ids) {
      const idset = new Set(ids);
      setState(s => {
        const notifications = s.notifications.map(n => (idset.has(n.id) ? { ...n, read: true } : n));
        return { ...s, notifications, notificationsUnread: notifications.filter(n => !n.read).length };
      });
      return api.post('/api/notifications', { ids }).catch(() => {});
    },
    markAllNotificationsRead() {
      setState(s => ({ ...s, notifications: s.notifications.map(n => ({ ...n, read: true })), notificationsUnread: 0 }));
      return api.post('/api/notifications', { all: true }).catch(() => {});
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
