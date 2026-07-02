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
// In-progress inline reply drafts, keyed by Gmail thread id. Unlike the dock
// composer (composerContext), the inline thread reply is unmounted when you
// navigate away — so its live content is mirrored here to survive that.
const THREAD_DRAFTS_KEY = 'sq_thread_drafts';

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

// Normalize the /api/notifications response into the per-channel shape the
// bells read. Tolerates the older flat `{ items, unread }` payload (general).
function normalizeNotificationChannels(r) {
  const ch = r?.channels;
  const norm = (c) => ({ items: Array.isArray(c?.items) ? c.items : [], unread: c?.unread || 0 });
  return {
    tracking: norm(ch?.tracking),
    finance: norm(ch?.finance),
    general: norm(ch?.general || { items: r?.items, unread: r?.unread }),
  };
}

function emptyStore() {
  return {
    // CRM-wide undo/redo history. Each entry is { label, undo, redo } where
    // undo/redo re-invoke the real store actions (so server side-effects are
    // correct). Only safely-reversible actions are recorded.
    undoStack: [],
    redoStack: [],
    undoBusy: false,
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
    // Storyboard revisions (Frame.io-style PDF review links)
    storyboards: [],
    storyboardDetail: {},
    // Admin → Storage: Vercel Blob usage + cost estimate
    blobUsage: null,
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
    // Gmail (whole-word, whole-mailbox) search results, kept separate from the
    // folder slices so searching never wipes the open folder's loaded rows.
    // { q, rows, next, loading, error }.
    mailboxSearch: {},
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
    // Marketing → lead attribution reports.
    marketingReports: null,
    marketingLeads: null,
    // Business → Finance / Performance pages.
    financeStats: null,
    performanceStats: null,
    salesStats: null,
    salesFinanceStats: null,
    salesLedger: null,
    trend: null,
    salesHistory: null,
    // Bumped whenever finance data changes (e.g. a PP marked paid) so the
    // Performance panel — which loads its own period — refetches in step.
    financeRefresh: 0,
    pendingPayments: null,
    predictedPayments: null,
    income: null,
    cashflow: null,
    cashflowTargets: null,
    financeTargets: [],
    salesTargets: [],
    costItems: [],
    neonUsage: null,
    costSnapshots: null,
    bankHolidays: null,
    partnerCreditsList: null,
    partnerCreditDetail: {},
    // In-app notification feed (the bells). The feed is split into two channels
    // — 'finance' (the £ bell) and 'general' (the standard bell). Each holds a
    // newest-first `items` list + server-reported `unread` count.
    notificationsByChannel: { tracking: { items: [], unread: 0 }, finance: { items: [], unread: 0 }, general: { items: [], unread: 0 } },
    session: null,
    loading: true,
    composerContext: loadLocal(COMPOSER_CONTEXT_KEY, null),
    drafts: loadLocal(DRAFTS_KEY, []),
    threadDrafts: loadLocal(THREAD_DRAFTS_KEY, {}),
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
  const { proposals, events, tasks, files, comments, videos, ...rest } = d;
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

// Find a task by id in either state.tasks or any cached dealDetail.tasks — used
// to capture its pre-change values when building an undo entry.
function findTaskInState(state, taskId) {
  const t = (state.tasks || []).find((x) => x.id === taskId);
  if (t) return t;
  for (const k of Object.keys(state.dealDetail || {})) {
    const hit = (state.dealDetail[k]?.tasks || []).find((x) => x.id === taskId);
    if (hit) return hit;
  }
  return null;
}

// Build an "edit" undo entry: capture the patch keys' old values from `before`
// and return { label, undo, redo } that re-apply old/new via `apply`. Returns
// null when nothing actually changed (so we don't record a no-op).
function buildEditUndo(before, patch, label, apply) {
  const old = {};
  let changed = false;
  for (const k of Object.keys(patch)) {
    old[k] = before ? (before[k] ?? null) : null;
    if (old[k] !== patch[k]) changed = true;
  }
  if (!changed) return null;
  return { label, undo: () => apply(old), redo: () => apply(patch) };
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
        // Scrub references so the deleted contact can't linger as a deal's
        // primary contact in local state (the server nulls primary_contact_id
        // too). Without this, opening + saving such a deal would re-send a now
        // dead contact id.
        let deals = state.deals;
        if (Object.values(state.deals || {}).some(d => d && d.primaryContactId === p.id)) {
          deals = Object.fromEntries(Object.entries(state.deals).map(([id, d]) =>
            [id, d && d.primaryContactId === p.id ? { ...d, primaryContactId: null } : d]));
        }
        let dealDetail = state.dealDetail;
        if (state.dealDetail && Object.values(state.dealDetail).some(dt => dt &&
            (dt.primaryContact?.id === p.id || dt.primaryContactId === p.id || (dt.secondaryContacts || []).some(c => c.id === p.id)))) {
          dealDetail = Object.fromEntries(Object.entries(state.dealDetail).map(([id, dt]) => {
            if (!dt) return [id, dt];
            return [id, {
              ...dt,
              primaryContact: dt.primaryContact?.id === p.id ? null : dt.primaryContact,
              primaryContactId: dt.primaryContactId === p.id ? null : dt.primaryContactId,
              secondaryContacts: (dt.secondaryContacts || []).filter(c => c.id !== p.id),
            }];
          }));
        }
        return { ...state, contacts, deals, dealDetail };
      }
      const cur = state.contacts[p.id];
      if (!cur) return state;
      return { ...state, contacts: { ...state.contacts, [p.id]: { ...cur, ...p.patch } } };
    }
    case 'company': {
      if (p.delete) {
        if (!state.companies[p.id]) return state;
        const companies = { ...state.companies }; delete companies[p.id];
        // Scrub the company off deals in local state (server nulls company_id
        // too) so a deleted company can't be re-saved onto a deal.
        let deals = state.deals;
        if (Object.values(state.deals || {}).some(d => d && d.companyId === p.id)) {
          deals = Object.fromEntries(Object.entries(state.deals).map(([id, d]) =>
            [id, d && d.companyId === p.id ? { ...d, companyId: null } : d]));
        }
        return { ...state, companies, deals };
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
  // Proposal ids whose signature was just unmarked locally, mapped to an expiry
  // timestamp. The 20s poll (and focus-triggered ticks) must not resurrect a
  // signature from an in-flight /api/proposals read taken before the DELETE
  // committed — the unmark DELETE also voids the Xero invoice, so it's slow.
  const recentlyRemovedSigs = useRef(new Map());

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
        financeTargets: settings?.financeTargets || [],
        salesTargets: settings?.salesTargets || [],
        costItems: settings?.costItems || [],
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
        setState(s => ({ ...s, notificationsByChannel: normalizeNotificationChannels(r) }));
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
          const now = Date.now();
          for (const [pid, p] of Object.entries(proposals)) {
            // Skip a signature the user just unmarked — the server read may
            // predate the DELETE committing. The tombstone expires shortly
            // after the authoritative refetch in removeSignature.
            const tombstoned = (recentlyRemovedSigs.current.get(pid) || 0) > now;
            if (p?._signature && !tombstoned) nextSignatures[pid] = p._signature;
            if (p?._payment)   nextPayments[pid]   = p._payment;
            if (p?._signature && !tombstoned && !s.signatures[pid]) newlySigned.push({ id: pid, sig: p._signature, name: p.clientName || p.contactBusinessName || 'a proposal' });
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
  // True while an undo()/redo() is replaying actions, so the replayed mutations
  // don't push fresh history entries of their own.
  const suppressUndoRef = useRef(false);
  // The canonical undo/redo stacks live in a ref for synchronous reads (useState
  // updaters don't run synchronously); state mirrors it so the buttons re-render.
  const undoRef = useRef({ undo: [], redo: [], busy: false });
  const syncUndoState = useCallback(() => {
    const r = undoRef.current;
    setState(s => ({ ...s, undoStack: r.undo.slice(), redoStack: r.redo.slice(), undoBusy: r.busy }));
  }, []);

  // Push a reversible action onto the undo history (clearing the redo branch).
  // Capped so the stack can't grow without bound. No-op while replaying.
  const recordUndo = useCallback((entry) => {
    if (!entry || suppressUndoRef.current) return;
    undoRef.current.undo = [...undoRef.current.undo, entry].slice(-50);
    undoRef.current.redo = [];
    syncUndoState();
  }, [syncUndoState]);

  // mutate: the one place CRM-style optimistic actions live. Optional 4th arg
  // `buildUndo(snapshot, resp)` returns an undo entry { label, undo, redo } built
  // from the PRE-mutation snapshot — recorded on success (unless we're replaying).
  const mutate = useCallback((patches, apiCall, onSuccess, buildUndo) => {
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
      if (buildUndo && !suppressUndoRef.current) {
        const entry = buildUndo(snapshot, resp);
        if (entry) recordUndo(entry);
      }
      return resp;
    }).catch(() => {
      if (snapshot) setState(snapshot);
      showMsg(errorMsg);
    });
  }, [showMsg, recordUndo]);

  const actions = useMemo(() => ({
    // ---------- Undo / redo (CRM-wide) ----------
    // recordUndo lets non-`mutate` actions (videos, finance) register history.
    recordUndo(entry) { recordUndo(entry); },
    // Restore a recently hard-deleted record (recycle bin), re-inserting it with
    // the same id server-side so a subsequent redo can delete it again.
    restoreRecord(recordId) {
      return api.post('/api/crm/restore/' + encodeURIComponent(recordId));
    },
    async undo() {
      const r = undoRef.current;
      if (r.busy || !r.undo.length) return;
      const entry = r.undo[r.undo.length - 1];
      r.busy = true; syncUndoState();
      suppressUndoRef.current = true;
      try { await entry.undo(); } catch { /* surfaced via the action's own toast */ }
      suppressUndoRef.current = false;
      r.undo = r.undo.slice(0, -1);
      r.redo = [...r.redo, entry];
      r.busy = false; syncUndoState();
      showMsg('Undone: ' + (entry.label || 'action'));
    },
    async redo() {
      const r = undoRef.current;
      if (r.busy || !r.redo.length) return;
      const entry = r.redo[r.redo.length - 1];
      r.busy = true; syncUndoState();
      suppressUndoRef.current = true;
      try { await entry.redo(); } catch { /* surfaced via the action's own toast */ }
      suppressUndoRef.current = false;
      r.redo = r.redo.slice(0, -1);
      r.undo = [...r.undo, entry];
      r.busy = false; syncUndoState();
      showMsg('Redone: ' + (entry.label || 'action'));
    },
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
      saveLocal(THREAD_DRAFTS_KEY, {});
      setState({ ...emptyStore(), loading: false, composerContext: null, drafts: [], threadDrafts: {} });
    },
    // "Sign out everywhere": bump the server-side token version so every active
    // session (including this one) is rejected on its next request, then tear
    // down local state exactly like logout.
    signOutEverywhere() {
      return api.post('/api/auth/signout-all', {}).catch(() => {}).then(() => {
        saveLocal(COMPOSER_CONTEXT_KEY, null);
        saveLocal(DRAFTS_KEY, []);
        saveLocal(THREAD_DRAFTS_KEY, {});
        setState({ ...emptyStore(), loading: false, composerContext: null, drafts: [], threadDrafts: {} });
      });
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
          // Refresh any cached deal detail that carries this proposal, so a
          // deal's VALUE (derived from its latest proposal's price in
          // dealDetail.proposals — see DealContextPanel / the deal page) reflects
          // the edit. Without this the value stays stale until the deal is
          // reloaded for some other reason. Keyed off the cached proposals list
          // rather than _dealId, so it's correct however the link was threaded.
          const staleDealIds = [];
          setState(s => {
            for (const [did, det] of Object.entries(s.dealDetail || {})) {
              if ((det?.proposals || []).some(p => p.id === id)) staleDealIds.push(did);
            }
            if (resp && resp.number) {
              const cur = s.proposals[id];
              if (cur) return { ...s, proposals: { ...s.proposals, [id]: { ...cur, _number: resp.number } } };
            }
            return s;
          });
          staleDealIds.forEach((did) => actions.loadDealDetail(did));
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
    // Link an existing (unassigned) proposal to a deal. The server sets
    // proposals.deal_id and ratchets the deal's stage to the proposal's current
    // state; we then reload the deal so its Proposal card + pipeline bar update.
    linkProposalToDeal(proposalId, dealId) {
      return api.patch('/api/proposals/' + encodeURIComponent(proposalId), { dealId })
        .then((resp) => {
          setState(s => (
            s.proposals[proposalId]
              ? { ...s, proposals: { ...s.proposals, [proposalId]: { ...s.proposals[proposalId], _dealId: dealId || null } } }
              : s
          ));
          if (dealId) return actions.loadDealDetail(dealId).then(() => resp);
          return resp;
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
    // Marketing → aggregated lead-attribution report grouped by source / medium /
    // campaign / keyword / channel over an optional date range (YYYY-MM-DD).
    loadMarketingReports(groupBy, from, to) {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const q = qs.toString();
      const path = '/api/crm/analytics/reports/' + (groupBy || 'campaign') + (q ? '?' + q : '');
      return api.get(path).then((data) => {
        setState(s => ({ ...s, marketingReports: data || null }));
        return data;
      }).catch(() => null);
    },
    // Marketing → the per-lead log with attribution + linked deal + revenue.
    loadMarketingLeads(from, to) {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const q = qs.toString();
      const path = '/api/crm/analytics/leads' + (q ? '?' + q : '');
      return api.get(path).then((data) => {
        setState(s => ({ ...s, marketingLeads: data || null }));
        return data;
      }).catch(() => null);
    },
    // Sales → Sales Insights (pipeline velocity, win rates, forecast, reps…).
    loadSalesInsights(from, to) {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const q = qs.toString();
      return api.get('/api/crm/sales-insights' + (q ? '?' + q : '')).catch(() => null);
    },
    // Marketing → the "show leads from" cutoff date (earlier, incomplete-
    // attribution leads are excluded from the reports). Read + set.
    loadMarketingCutoff() {
      return api.get('/api/crm/analytics/settings').then((d) => {
        setState(s => ({ ...s, marketingCutoff: d?.leadsFrom || null }));
        return d?.leadsFrom || null;
      }).catch(() => null);
    },
    setMarketingCutoff(leadsFrom) {
      setState(s => ({ ...s, marketingCutoff: leadsFrom }));
      return api.post('/api/crm/analytics/settings', { leadsFrom })
        .then((d) => { setState(s => ({ ...s, marketingCutoff: d?.leadsFrom || leadsFrom })); return d; })
        .catch(() => {});
    },
    // Marketing → Search Console organic-search report (Search tab).
    loadMarketingSearch(from, to) {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const q = qs.toString();
      return api.get('/api/crm/analytics/search' + (q ? '?' + q : '')).catch(() => null);
    },
    // Marketing → GA4 sitewide traffic-by-channel report (Traffic tab).
    loadMarketingTraffic(from, to) {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const q = qs.toString();
      return api.get('/api/crm/analytics/traffic' + (q ? '?' + q : '')).catch(() => null);
    },
    // Marketing → setup snippet + Google Ads tracking template (Settings tab).
    loadMarketingSnippet() {
      return api.get('/api/crm/analytics/snippet').catch(() => null);
    },
    // Marketing → trigger all connected Google syncs on demand ("Sync now").
    syncAdSpend() {
      return api.post('/api/crm/analytics/sync', {}).catch((e) => ({ ok: false, error: e?.message || 'Sync failed' }));
    },
    // Business → Finance: all-customer monthly net / VAT-to-save / gross for a year.
    loadFinanceStats(year) {
      const path = '/api/crm/stats/finance' + (year ? '/' + year : '');
      return api.get(path).then((data) => {
        setState(s => ({ ...s, financeStats: data || null }));
        return data;
      }).catch(() => null);
    },
    // Business → Performance (Income): per-day cash (net) for the target graph.
    loadPerformanceStats(period) {
      const path = '/api/crm/stats/performance' + (period ? '/' + period : '');
      return api.get(path).then((data) => {
        setState(s => ({ ...s, performanceStats: data || null }));
        return data;
      }).catch(() => null);
    },
    // Business → Performance (Sales): per-day signed value (net) for the graph.
    loadSalesStats(period) {
      const path = '/api/crm/stats/sales' + (period ? '/' + period : '');
      return api.get(path).then((data) => {
        setState(s => ({ ...s, salesStats: data || null }));
        return data;
      }).catch(() => null);
    },
    // Business → Finance (Sales): all-customer monthly cash generated (signed
    // deals + extras, net/VAT/gross) for a year — mirrors loadFinanceStats.
    loadSalesFinanceStats(year) {
      const path = '/api/crm/stats/sales-finance' + (year ? '/' + year : '');
      return api.get(path).then((data) => {
        setState(s => ({ ...s, salesFinanceStats: data || null }));
        return data;
      }).catch(() => null);
    },
    // Business → Finance (Sales): flat ledger of signings + extras in a period.
    loadSalesLedger(period) {
      const path = '/api/crm/stats/sales-ledger' + (period ? '/' + period : '');
      return api.get(path).then((data) => {
        setState(s => ({ ...s, salesLedger: data || null }));
        return data;
      }).catch(() => null);
    },
    // Signal that finance data changed so period-scoped panels (Performance)
    // refetch even though their own selector hasn't moved.
    bumpFinanceRefresh() {
      setState(s => ({ ...s, financeRefresh: (s.financeRefresh || 0) + 1 }));
    },
    // Business → Finance: rolling last-N-months trend (cash in / generated / PP's).
    loadTrend(months = 12) {
      return api.get('/api/crm/stats/trend/' + months).then((data) => {
        setState(s => ({ ...s, trend: data || null }));
        return data;
      }).catch(() => null);
    },
    // Business → Finance: imported Live Sales Sheet history (per-month overrides).
    loadSalesHistory() {
      return api.get('/api/crm/stats/history').then((data) => {
        setState(s => ({ ...s, salesHistory: data?.rows || [] }));
        return data;
      }).catch(() => null);
    },
    // Bulk import/replace the sheet history; refreshes the trend afterwards.
    importSalesHistory(rows, mode = 'merge') {
      return api.post('/api/crm/stats/history', { rows, mode }).then((data) => {
        setState(s => ({ ...s, salesHistory: data?.rows || [], trend: null }));
        return data;
      });
    },
    // Business → Finance (Income): back-date a ledger payment (caller refreshes).
    setIncomeDate({ source, key, paidAt }) {
      return api.post('/api/crm/stats/income-date', { source, key, paidAt });
    },
    // Business → Finance (Income): flat ledger of payments received in a period.
    loadIncome(period) {
      const path = '/api/crm/stats/income' + (period ? '/' + period : '');
      return api.get(path).then((data) => {
        setState(s => ({ ...s, income: data || null }));
        return data;
      }).catch(() => null);
    },
    // Business → Finance (Cash Flow): costs, monthly profit, CT to set aside and
    // the wage-based revenue targets for a month ('YYYY-MM', default current).
    loadCashflow(month) {
      const path = '/api/crm/stats/cashflow' + (month ? '/' + month : '');
      return api.get(path).then((data) => {
        setState(s => ({ ...s, cashflow: data || null }));
        return data;
      }).catch(() => null);
    },
    // Just the current-month Cash Flow & Targets figures (minimum + £4k/£5k wage
    // targets), so the Income performance graph can mirror them live. Kept in its
    // own slice — independent of the month-specific `cashflow` the tab browses.
    loadCashflowTargets() {
      return api.get('/api/crm/stats/cashflow').then((data) => {
        setState(s => ({ ...s, cashflowTargets: (data && data.targets) || null }));
        return (data && data.targets) || null;
      }).catch(() => null);
    },
    // Add a cost line (recurring overhead or one-off). Caller reloads the month.
    // We mint the id client-side so the action is reversible: undo deletes that
    // row, redo re-inserts the SAME id (server accepts a provided id).
    addCashflowCost(payload) {
      const id = 'cf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const full = { ...payload, id };
      const promise = api.post('/api/crm/stats/cashflow-cost', full);
      if (!suppressUndoRef.current) {
        recordUndo({
          label: `Add “${(payload.label || 'cost').trim()}”`,
          undo: () => api.delete('/api/crm/stats/cashflow-cost/' + id).then(() => actions.bumpFinanceRefresh()),
          redo: () => api.post('/api/crm/stats/cashflow-cost', full).then(() => actions.bumpFinanceRefresh()),
        });
      }
      return promise;
    },
    // Edit a cost line. Pass `before` (the row's pre-edit values for the patched
    // keys) to make the edit undoable.
    updateCashflowCost(id, patch, before) {
      const promise = api.patch('/api/crm/stats/cashflow-cost/' + id, patch);
      if (before && !suppressUndoRef.current) {
        const entry = buildEditUndo(before, patch, `Edit “${before.label || ''}”`, (vals) =>
          api.patch('/api/crm/stats/cashflow-cost/' + id, vals).then(() => actions.bumpFinanceRefresh()));
        if (entry) recordUndo(entry);
      }
      return promise;
    },
    // Remove a cost line. Pass the full `row` so the delete is undoable: the
    // server archives the row (recycle bin) and undo restores it with the same id.
    deleteCashflowCost(id, row) {
      const promise = api.delete('/api/crm/stats/cashflow-cost/' + id);
      if (row && !suppressUndoRef.current) {
        recordUndo({
          label: `Delete “${row.label || ''}”`,
          undo: () => api.post('/api/crm/restore/' + encodeURIComponent(id)).then(() => actions.bumpFinanceRefresh()),
          redo: () => api.delete('/api/crm/stats/cashflow-cost/' + id).then(() => actions.bumpFinanceRefresh()),
        });
      }
      return promise;
    },
    // Move a cost up/down within its category (swaps sort order with its neighbour).
    moveCashflowCost(id, direction) {
      return api.patch('/api/crm/stats/cashflow-cost/' + id, { move: direction });
    },
    // Persist a drag-reordered list of cost ids (sets sort_order = position).
    reorderCashflowCosts(ids) {
      return api.post('/api/crm/stats/cashflow-cost', { reorder: ids });
    },

    // ── Directors expenses (Finance → Performance → Directors) — directors only.
    // Each director's £250/mo allowance with carried-over underspend, an ongoing
    // balancing adjustment, attachable invoices and a month-ZIP for Hubdoc.
    loadDirectorExpenses(month) {
      const path = '/api/crm/stats/director-expenses' + (month ? '/' + month : '');
      return api.get(path).then((data) => {
        setState(s => ({ ...s, directorExpenses: data || null }));
        return data;
      }).catch(() => null);
    },
    addDirectorExpense(payload) {
      const id = 'de_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      return api.post('/api/crm/stats/director-expenses', { ...payload, id }).then(() => id);
    },
    updateDirectorExpense(id, patch) {
      return api.patch('/api/crm/stats/director-expenses/' + id, patch);
    },
    deleteDirectorExpense(id) {
      return api.delete('/api/crm/stats/director-expenses/' + id);
    },
    // Persist a drag-reordered list of expense ids (sort_order = position).
    reorderDirectorExpenses(ids) {
      return api.post('/api/crm/stats/director-expenses', { reorder: ids });
    },
    // Upload (or replace) the invoice/receipt on an expense — raw binary, like
    // uploadDealPoFile.
    async uploadDirectorInvoice(id, file) {
      const mime = file.type || 'application/octet-stream';
      const res = await fetch('/api/crm/stats/director-invoice/' + encodeURIComponent(id), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': mime, 'X-Filename': encodeURIComponent(file.name) },
        body: file,
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Upload failed'); }
      return res.json();
    },
    deleteDirectorInvoice(id) {
      return api.delete('/api/crm/stats/director-invoice/' + encodeURIComponent(id));
    },
    // Balancing amount = a list of grant lines (each with a note) that sum to
    // the director's total standing headroom.
    addDirectorBalanceItem(email, { amount, note, month }) {
      const id = 'db_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      return api.post('/api/crm/stats/director-balance', { email, id, amount, note, month }).then(() => id);
    },
    updateDirectorBalanceItem(id, patch) {
      return api.patch('/api/crm/stats/director-balance/' + encodeURIComponent(id), patch);
    },
    deleteDirectorBalanceItem(id) {
      return api.delete('/api/crm/stats/director-balance/' + encodeURIComponent(id));
    },

    // Savings & balances: named bank accounts (each with an actual cleared
    // balance) holding earmarked "pots" of what's saved for what.
    loadDirectorSavings() {
      return api.get('/api/crm/stats/director-savings').then((data) => {
        setState(s => ({ ...s, directorSavings: data || null }));
        return data;
      }).catch(() => null);
    },
    addSavingsAccount(name, balance) {
      return api.post('/api/crm/stats/director-savings', { type: 'account', name, balance });
    },
    updateSavingsAccount(id, patch) {
      return api.patch('/api/crm/stats/director-savings/' + id, { type: 'account', ...patch });
    },
    deleteSavingsAccount(id) {
      return api.delete('/api/crm/stats/director-savings/' + id + '?type=account');
    },
    addSavingsPot(accountId, payload) {
      return api.post('/api/crm/stats/director-savings', { type: 'pot', accountId, ...payload });
    },
    updateSavingsPot(id, patch) {
      return api.patch('/api/crm/stats/director-savings/' + id, { type: 'pot', ...patch });
    },
    deleteSavingsPot(id) {
      return api.delete('/api/crm/stats/director-savings/' + id + '?type=pot');
    },
    // Persist a drag-reordered list of account or pot ids (sort_order = position).
    reorderSavings(type, ids) {
      return api.post('/api/crm/stats/director-savings', { reorder: ids, type });
    },

    // Tax pay dates: upcoming Personal / VAT / Corp Tax payments with due date,
    // amount and HMRC transfer reference. Drives the director-tax-reminders cron.
    loadDirectorTaxPayments() {
      return api.get('/api/crm/stats/director-tax').then((data) => {
        setState(s => ({ ...s, directorTaxPayments: data || null }));
        return data;
      }).catch(() => null);
    },
    addTaxPayment(payload) {
      return api.post('/api/crm/stats/director-tax', payload);
    },
    updateTaxPayment(id, patch) {
      return api.patch('/api/crm/stats/director-tax/' + id, patch);
    },
    deleteTaxPayment(id) {
      return api.delete('/api/crm/stats/director-tax/' + id);
    },
    reorderTaxPayments(ids) {
      return api.post('/api/crm/stats/director-tax', { reorder: ids });
    },

    // Business → Finance: outstanding balance per signed deal (PO vs normal) +
    // the imported manual pending payments group.
    loadPendingPayments() {
      return api.get('/api/crm/stats/pending').then((data) => {
        setState(s => ({ ...s, pendingPayments: data || null }));
        return data;
      }).catch(() => null);
    },
    // Predicted-this-month payments — the curated shortlist behind the Finance
    // "Predicted <month> Payments" tab. Keyed by an opaque per-row item key and
    // scoped to a 'YYYY-MM' month.
    loadPredictedPayments(month) {
      return api.get('/api/crm/stats/predicted-payments/' + month).then((data) => {
        setState(s => ({ ...s, predictedPayments: data || null }));
        return data;
      }).catch(() => null);
    },
    // Toggle one pending payment on/off the predicted list. Optimistic on the
    // key set so the row + total update instantly; the server reply (with a
    // refreshed banked-net figure) replaces it.
    togglePredictedPayment(month, itemKey, predicted, label = null, amountExVat = 0) {
      setState(s => {
        const cur = s.predictedPayments && s.predictedPayments.month === month
          ? s.predictedPayments
          : { month, keys: [], items: [], bankedNet: 0 };
        const set = new Set(cur.keys || []);
        if (predicted) set.add(itemKey); else set.delete(itemKey);
        return { ...s, predictedPayments: { ...cur, month, keys: [...set] } };
      });
      return api.post('/api/crm/stats/predicted-payments/' + month, { itemKey, predicted, label, amountExVat })
        .then((data) => { if (data) setState(s => ({ ...s, predictedPayments: data })); return data; })
        .catch(() => {});
    },
    // Mark a pending payment predicted in a SPECIFIC month (e.g. the month of an
    // expected pay date), which may differ from the one on screen. Doesn't touch
    // the in-view predicted list unless the server reply is for that same month —
    // so predicting a future month never clobbers the current view.
    predictPaymentInMonth(month, itemKey, label = null, amountExVat = 0) {
      return api.post('/api/crm/stats/predicted-payments/' + month, { itemKey, predicted: true, label, amountExVat })
        .then((data) => {
          setState(s => (data && s.predictedPayments && s.predictedPayments.month === month
            ? { ...s, predictedPayments: data }
            : s));
          return data;
        });
    },
    // Exclude (or re-include) an auto-included item — an active partner or
    // "other" recurring row — from this month's predicted list. Optimistic on
    // the excluded-key set so it drops off / returns instantly.
    excludePredictedPayment(month, itemKey, excluded, label = null, amountExVat = 0) {
      setState(s => {
        const cur = s.predictedPayments && s.predictedPayments.month === month
          ? s.predictedPayments
          : { month, keys: [], items: [], excludedKeys: [], bankedNet: 0 };
        const set = new Set(cur.excludedKeys || []);
        if (excluded) set.add(itemKey); else set.delete(itemKey);
        return { ...s, predictedPayments: { ...cur, month, excludedKeys: [...set] } };
      });
      return api.post('/api/crm/stats/predicted-payments/' + month, { itemKey, excluded, label, amountExVat })
        .then((data) => { if (data) setState(s => ({ ...s, predictedPayments: data })); return data; })
        .catch(() => {});
    },
    // Add / edit / clear a progress note on a predicted payment (catch-up notes).
    // Notes are keyed by item, not month, so they persist. Optimistic.
    setPredictedPaymentNote(month, itemKey, note) {
      const clean = typeof note === 'string' ? note.trim() : '';
      setState(s => {
        const cur = s.predictedPayments || { month, keys: [], items: [], notes: {}, bankedNet: 0 };
        const notes = { ...(cur.notes || {}) };
        if (clean) notes[itemKey] = clean; else delete notes[itemKey];
        return { ...s, predictedPayments: { ...cur, notes } };
      });
      return api.post('/api/crm/stats/predicted-payments/' + month, { itemKey, note: clean })
        .then((data) => { if (data) setState(s => ({ ...s, predictedPayments: data })); return data; })
        .catch(() => {});
    },
    // Import manual pending payments / POs (Live Sales Sheet); refresh after.
    importPendingPayments(rows, mode = 'replace', kind = 'pp') {
      return api.post('/api/crm/stats/pending-manual', { rows, mode, kind }).then((data) => {
        api.get('/api/crm/stats/pending').then((p) => setState(s => ({ ...s, pendingPayments: p || null }))).catch(() => {});
        return data;
      });
    },
    // Remove one imported pending payment (collected/cleared); refresh after.
    deletePendingPayment(id) {
      return api.delete('/api/crm/stats/pending-manual/' + id).then((data) => {
        api.get('/api/crm/stats/pending').then((p) => setState(s => ({ ...s, pendingPayments: p || null }))).catch(() => {});
        return data;
      });
    },
    // Archive an imported pending payment (drops it off the outstanding list but
    // keeps it retrievable), or restore it with archived=false. Refreshes pending.
    markPendingPaymentArchived(id, archived = true) {
      return api.patch('/api/crm/stats/pending-manual/' + id, { archived }).then((data) => {
        api.get('/api/crm/stats/pending').then((p) => setState(s => ({ ...s, pendingPayments: p || null }))).catch(() => {});
        return data;
      });
    },
    // Fetch archived imported pending payments for the archive view.
    getArchivedPendingPayments() {
      return api.get('/api/crm/stats/pending-manual?archived=1').then((d) => (d?.rows || []));
    },
    // Mark an imported pending payment paid (→ income) or back to pending, with
    // how it was paid (stripe/bacs). The caller refreshes pending + income.
    markPendingPaymentPaid(id, paid = true, method = null) {
      return api.patch('/api/crm/stats/pending-manual/' + id, { paid, method });
    },
    // Mark an imported pending payment invoiced (→ the invoiced/awaiting list) or
    // back to pending. The caller refreshes the pending list.
    markPendingPaymentInvoiced(id, invoiced = true) {
      return api.patch('/api/crm/stats/pending-manual/' + id, { invoiced });
    },
    // Link an imported pending payment to a CRM deal (or unlink with null).
    linkPendingPayment(id, dealId) {
      return api.patch('/api/crm/stats/pending-manual/' + id, { dealId: dealId || null });
    },
    // Link an imported pending payment to a customer/company (or unlink with
    // null). Mutually exclusive with the deal link.
    linkPendingPaymentCompany(id, companyId) {
      return api.patch('/api/crm/stats/pending-manual/' + id, { companyId: companyId || null });
    },
    // ── "Other" recurring revenue (Pending Payments → Other). Small ongoing
    // monthly income outside deals/partners (e.g. web hosting); auto-predicted.
    // Mint the id client-side so add is reversible (undo deletes that row, redo
    // re-inserts the SAME id). Each write reloads the pending list.
    addRecurringOther(payload) {
      const id = 'other_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const full = { ...payload, id };
      const promise = api.post('/api/crm/stats/recurring-other', full).then((d) => { actions.loadPendingPayments(); return d; });
      if (!suppressUndoRef.current) {
        recordUndo({
          label: `Add “${(payload.label || 'item').trim()}”`,
          undo: () => api.delete('/api/crm/stats/recurring-other/' + id).then(() => actions.loadPendingPayments()),
          redo: () => api.post('/api/crm/stats/recurring-other', full).then(() => actions.loadPendingPayments()),
        });
      }
      return promise;
    },
    // Edit an Other row. Pass `before` (its pre-edit values for the patched keys)
    // to make the edit undoable.
    updateRecurringOther(id, patch, before) {
      const promise = api.patch('/api/crm/stats/recurring-other/' + id, patch).then((d) => { actions.loadPendingPayments(); return d; });
      if (before && !suppressUndoRef.current) {
        const entry = buildEditUndo(before, patch, `Edit “${before.label || ''}”`, (vals) =>
          api.patch('/api/crm/stats/recurring-other/' + id, vals).then(() => actions.loadPendingPayments()));
        if (entry) recordUndo(entry);
      }
      return promise;
    },
    // Remove an Other row. Pass the full `row` so the delete is undoable: the
    // server archives the row (recycle bin) and undo restores it with the same id.
    deleteRecurringOther(id, row) {
      const promise = api.delete('/api/crm/stats/recurring-other/' + id).then((d) => { actions.loadPendingPayments(); return d; });
      if (row && !suppressUndoRef.current) {
        recordUndo({
          label: `Delete “${row.label || ''}”`,
          undo: () => api.post('/api/crm/restore/' + encodeURIComponent(id)).then(() => actions.loadPendingPayments()),
          redo: () => api.delete('/api/crm/stats/recurring-other/' + id).then(() => actions.loadPendingPayments()),
        });
      }
      return promise;
    },
    // Mark a recurring "Other" line as received for a month → logs it as banked
    // income for that month (shows in the Income ledger + NET REVENUE). Undoable.
    receiveRecurringOther({ id, month, paidAt, net, vat }, label) {
      const promise = api.post('/api/crm/stats/recurring-other', { receive: { id, month, paidAt, net, vat } })
        .then((d) => { actions.loadPendingPayments(); return d; });
      if (!suppressUndoRef.current) {
        recordUndo({
          label: `Mark “${(label || 'recurring').trim()}” received (${month})`,
          undo: () => api.post('/api/crm/stats/recurring-other', { unreceive: { id, month } }).then(() => actions.loadPendingPayments()),
          redo: () => api.post('/api/crm/stats/recurring-other', { receive: { id, month, paidAt, net, vat } }).then(() => actions.loadPendingPayments()),
        });
      }
      return promise;
    },
    unreceiveRecurringOther({ id, month }, label) {
      const promise = api.post('/api/crm/stats/recurring-other', { unreceive: { id, month } })
        .then((d) => { actions.loadPendingPayments(); return d; });
      if (!suppressUndoRef.current) {
        recordUndo({
          label: `Un-mark “${(label || 'recurring').trim()}” (${month})`,
          undo: () => api.post('/api/crm/stats/recurring-other', { receive: { id, month } }).then(() => actions.loadPendingPayments()),
          redo: () => api.post('/api/crm/stats/recurring-other', { unreceive: { id, month } }).then(() => actions.loadPendingPayments()),
        });
      }
      return promise;
    },
    // Signed CRM deals for the "link to deal" picker. [{ dealId, company, title, number, net }].
    loadLinkableDeals() {
      return api.get('/api/crm/stats/linkable-deals')
        .then((d) => (Array.isArray(d?.deals) ? d.deals : []))
        .catch(() => []);
    },
    // Editable monthly targets (shared with the settings row). Optimistic.
    // finance = Income performance; sales = Sales performance.
    saveFinanceTargets(list) {
      setState(s => ({ ...s, financeTargets: list }));
      api.put('/api/settings', { financeTargets: list }).catch(() => {});
    },
    saveSalesTargets(list) {
      setState(s => ({ ...s, salesTargets: list }));
      api.put('/api/settings', { salesTargets: list }).catch(() => {});
    },
    // England & Wales bank holidays (gov.uk feed via our endpoint), for the
    // Performance working-day pacing. Cached in state — load once.
    loadBankHolidays() {
      return api.get('/api/crm/stats/bank-holidays').then((data) => {
        const dates = Array.isArray(data?.dates) ? data.dates : [];
        setState(s => ({ ...s, bankHolidays: dates }));
        return dates;
      }).catch(() => []);
    },
    saveSignature(id, sig) {
      setState(s => ({ ...s, signatures: { ...s.signatures, [id]: sig } }));
      api.post('/api/signatures/' + id, sig).catch(() => {});
    },
    removeSignature(id) {
      // Tombstone so a focus/interval poll doesn't resurrect the signature
      // from a stale /api/proposals read while the DELETE is in flight.
      recentlyRemovedSigs.current.set(id, Date.now() + 25_000);
      setState(s => {
        const signatures = { ...s.signatures };
        delete signatures[id];
        // Keep the cached proposal in sync so nothing re-derives "signed".
        const proposals = s.proposals[id]?._signature
          ? { ...s.proposals, [id]: { ...s.proposals[id], _signature: null } }
          : s.proposals;
        return { ...s, signatures, proposals };
      });
      return api.delete('/api/signatures/' + id)
        .then(() => { fetchAllRef.current?.(); })
        .catch(() => {})
        // Drop the tombstone a moment after the refetch so a genuine re-sign
        // can surface again; on failure the next poll correctly restores it.
        .finally(() => { setTimeout(() => recentlyRemovedSigs.current.delete(id), 3_000); });
    },
    savePayment(id, payment) {
      setState(s => ({ ...s, payments: { ...s.payments, [id]: payment } }));
      api.post('/api/payments/' + id, payment).catch(() => {});
    },
    // Record a manual payment against a signed deal's proposal (e.g. "mark paid
    // — BACS" from the predicted list). Advances the deal to paid + enters
    // production server-side. Caller refreshes the finance figures.
    recordDealPayment(proposalId, amount, method = 'bacs') {
      return api.post('/api/crm/payments', {
        proposalId,
        amount: Number(amount) || 0,
        paymentMethod: method,
        paymentType: 'full',
        paidAt: new Date().toISOString(),
      });
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
    // Set/clear a partner's manual monthly spend (ex-VAT). Feeds the Pending
    // Payments "Partners" figure for clients added before the fee system.
    setPartnerManualFee(clientKey, monthlyNet) {
      return api.post('/api/partner/manual-fee', { clientKey, monthlyNet });
    },
    // Set a partner's VAT rate (fraction, e.g. 0.20) for the VAT-to-save split.
    setPartnerVatRate(clientKey, vatRate) {
      return api.post('/api/partner/manual-fee', { clientKey, vatRate });
    },
    // Mark (or un-mark) a partner's fee as collected → income + VAT. Defaults to
    // this month; pass a 'YYYY-MM' month to back-log (or clear) a past month.
    markPartnerFeePaid(clientKey, paid = true, month) {
      return api.post('/api/partner/mark-fee-paid', { clientKey, paid, ...(month ? { month } : {}) });
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
    // ── Intro Call booking (Google Calendar/Meet) ──────────────────────────
    loadIntroCall(dealId, compute) {
      // compute=true re-runs the (expensive) Google free/busy availability check;
      // the default cheap load just returns the link + bookings from the DB.
      const qs = compute ? '?compute=1' : '';
      return api.get('/api/crm/intro-calls/' + encodeURIComponent(dealId) + qs).catch(() => null);
    },
    generateIntroCallLink(dealId) {
      return api.post('/api/crm/intro-calls/' + encodeURIComponent(dealId) + '/link', {});
    },
    revokeIntroCallLink(dealId) {
      return api.delete('/api/crm/intro-calls/' + encodeURIComponent(dealId) + '/link');
    },
    cancelIntroCallBooking(dealId, bookingId) {
      return api.post('/api/crm/intro-calls/' + encodeURIComponent(dealId) + '/cancel', { bookingId });
    },
    // Partner-client meeting links (no deal — an explicit chosen host list).
    loadPartnerIntroCall(clientKey, compute) {
      const qs = '?clientKey=' + encodeURIComponent(clientKey) + (compute ? '&compute=1' : '');
      return api.get('/api/crm/intro-calls/partner' + qs).catch(() => null);
    },
    savePartnerIntroCallLink(clientKey, clientName, hostEmails) {
      return api.post('/api/crm/intro-calls/partner/link', { clientKey, clientName, hostEmails });
    },
    revokePartnerIntroCallLink(clientKey) {
      return api.delete('/api/crm/intro-calls/partner/link?clientKey=' + encodeURIComponent(clientKey));
    },
    cancelPartnerIntroCallBooking(bookingId) {
      return api.post('/api/crm/intro-calls/partner/cancel', { bookingId });
    },
    loadIntroCallAvailability() {
      return api.get('/api/crm/intro-calls/availability').catch(() => null);
    },
    saveIntroCallAvailability(days) {
      return api.put('/api/crm/intro-calls/availability', { days });
    },
    loadIntroCallRules() {
      return api.get('/api/crm/intro-calls/rules').catch(() => null);
    },
    saveIntroCallRules(rules) {
      return api.put('/api/crm/intro-calls/rules', { rules });
    },
    saveDeal(dealId, patch) {
      return mutate(
        { kind: 'deal', id: dealId, patch, errorMsg: 'Failed to save deal' },
        () => api.patch('/api/crm/deals/' + encodeURIComponent(dealId), patch),
        undefined,
        (snap) => buildEditUndo(
          snap.deals[dealId] || snap.dealDetail[dealId],
          patch,
          `Edit ${snap.deals[dealId]?.title || 'deal'}`,
          (vals) => actions.saveDeal(dealId, vals),
        ),
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
        (snap) => {
          const before = snap.deals[dealId] || {};
          if (!before.stage || before.stage === stage) return null;
          const oldStage = before.stage;
          const oldLost = before.lostReason || null;
          return {
            label: `Move ${before.title || 'deal'} stage`,
            undo: () => actions.moveDealStage(dealId, oldStage, oldLost),
            redo: () => actions.moveDealStage(dealId, stage, lostReason),
          };
        },
      );
    },
    // Toggle the orthogonal "hot" warm-lead flag (independent of stage).
    toggleDealHot(dealId, hot) {
      return mutate(
        { kind: 'deal', id: dealId, patch: { hot }, errorMsg: 'Failed to update deal' },
        () => api.post('/api/crm/deals/' + encodeURIComponent(dealId) + '/hot', { hot }),
        (s, resp) => resp?.deal
          ? applyOne(s, { kind: 'deal', id: resp.deal.id, patch: resp.deal })
          : s,
        (snap) => {
          const before = snap.deals[dealId] || {};
          if (!!before.hot === !!hot) return null;
          return {
            label: `${hot ? 'Flag' : 'Unflag'} ${before.title || 'deal'} as hot`,
            undo: () => actions.toggleDealHot(dealId, !hot),
            redo: () => actions.toggleDealHot(dealId, hot),
          };
        },
      );
    },
    deleteDeal(dealId) {
      return mutate(
        { kind: 'deal', id: dealId, delete: true, errorMsg: 'Failed to delete deal' },
        () => api.delete('/api/crm/deals/' + encodeURIComponent(dealId)),
      );
    },
    // Mark a sold deal "Good to go": move it onto the production board and alert
    // the project managers. One-way (no undo) — the server gates eligibility
    // (signed / paid / PO) and rejects a too-early click; the caller surfaces
    // the error. On success we reload the deal + board so the UI flips to the
    // project (production progress bar) view.
    markDealGoodToGo(dealId) {
      return api.post('/api/crm/deals/' + encodeURIComponent(dealId) + '/good-to-go', {})
        .then((resp) => {
          if (resp?.deal) setState(s => applyOne(s, { kind: 'deal', id: resp.deal.id, patch: resp.deal }));
          return Promise.all([actions.loadDealDetail(dealId), actions.loadProductionVideos()]).then(() => resp);
        });
    },

    // ---------- Production board (videos move through stages) ----------
    // The board + Projects overview both read state.productionVideos (every
    // video joined to its project). The per-video page reads videoDetail.
    loadProductionVideos() {
      return api.get('/api/crm/production')
        .then((list) => { setState(s => ({ ...s, productionVideos: Array.isArray(list) ? list : [] })); return list; })
        .catch(() => {});
    },
    loadVideo(videoId) {
      return api.get('/api/crm/production/video/' + encodeURIComponent(videoId))
        .then((video) => {
          if (!video || video.error) return null;
          setState(s => ({ ...s, videoDetail: { ...s.videoDetail, [videoId]: video } }));
          return video;
        }).catch(() => null);
    },
    // Merge a server video row into every cache that holds it (board list,
    // per-video detail, and the parent deal's nested videos).
    _mergeVideo(video) {
      if (!video || !video.id) return;
      setState(s => {
        const list = s.productionVideos || [];
        const productionVideos = list.some(v => v.id === video.id)
          ? list.map(v => (v.id === video.id ? { ...v, ...video } : v))
          : [...list, video];
        const videoDetail = { ...s.videoDetail, [video.id]: { ...(s.videoDetail?.[video.id] || {}), ...video } };
        let dealDetail = s.dealDetail;
        const detail = video.dealId && s.dealDetail?.[video.dealId];
        if (detail?.videos) {
          dealDetail = { ...s.dealDetail, [video.dealId]: { ...detail, videos: detail.videos.map(v => (v.id === video.id ? { ...v, ...video } : v)) } };
        }
        return { ...s, productionVideos, videoDetail, dealDetail };
      });
    },
    moveVideoStage(videoId, phase, stage) {
      let snapshot = null;
      let before = null;
      setState(s => {
        snapshot = s.productionVideos;
        before = (s.productionVideos || []).find(v => v.id === videoId) || null;
        const productionVideos = (s.productionVideos || []).map(v =>
          v.id === videoId ? { ...v, productionPhase: phase, productionStage: stage, productionStageChangedAt: new Date().toISOString() } : v);
        return { ...s, productionVideos };
      });
      return api.post('/api/crm/production/video/' + encodeURIComponent(videoId) + '/move', { phase, stage })
        .then((video) => {
          actions._mergeVideo(video);
          if (before && (before.productionPhase !== phase || before.productionStage !== stage)) {
            const oldPhase = before.productionPhase, oldStage = before.productionStage;
            actions.recordUndo({
              label: 'Move video stage',
              undo: () => actions.moveVideoStage(videoId, oldPhase, oldStage),
              redo: () => actions.moveVideoStage(videoId, phase, stage),
            });
          }
          return video;
        })
        .catch(() => { setState(s => ({ ...s, productionVideos: snapshot ?? s.productionVideos })); showMsg('Failed to move video'); });
    },
    updateVideo(videoId, fields) {
      let before = null;
      setState(s => { before = s.videoDetail?.[videoId] || (s.productionVideos || []).find(v => v.id === videoId) || null; return s; });
      return api.patch('/api/crm/production/video/' + encodeURIComponent(videoId), fields)
        .then((video) => {
          actions._mergeVideo(video);
          const entry = buildEditUndo(before, fields, 'Edit video', (vals) => actions.updateVideo(videoId, vals));
          if (entry) actions.recordUndo(entry);
          return video;
        })
        .catch((err) => { showMsg('Failed to update video'); throw err; });
    },
    // Create a project (deal) from scratch + its first video.
    createProject(input) {
      return api.post('/api/crm/production', input).then((deal) => {
        if (deal && deal.id) setState(s => ({ ...s, deals: { ...s.deals, [deal.id]: deal } }));
        actions.loadProductionVideos();
        return deal;
      });
    },
    enterProduction(dealId) {
      return api.post('/api/crm/production/' + encodeURIComponent(dealId) + '/enter', {})
        .then((deal) => {
          if (deal && deal.id) setState(s => applyOne(s, { kind: 'deal', id: deal.id, patch: deal }));
          return Promise.all([actions.loadDealDetail(dealId), actions.loadProductionVideos()]);
        });
    },
    addProjectVideo(dealId, title, { fromCredit = false } = {}) {
      return api.post('/api/crm/production/' + encodeURIComponent(dealId) + '/videos', { title, fromCredit })
        .then((video) => Promise.all([actions.loadDealDetail(dealId), actions.loadProductionVideos()]).then(() => video));
    },
    deleteProjectVideo(dealId, videoId) {
      const done = () => Promise.all([dealId ? actions.loadDealDetail(dealId) : null, actions.loadProductionVideos()]);
      return api.delete('/api/crm/production/video/' + encodeURIComponent(videoId)).then(() => {
        // The server archived the video + its children before deleting, so undo
        // restores it (same id) and redo deletes it again.
        actions.recordUndo({
          label: 'Delete video',
          undo: () => api.post('/api/crm/restore/' + encodeURIComponent(videoId)).then(done),
          redo: () => actions.deleteProjectVideo(dealId, videoId),
        });
        return done();
      }).catch(done);
    },
    addProjectCredits(dealId, delta) {
      return api.post('/api/crm/production/' + encodeURIComponent(dealId) + '/credits', { delta })
        .then((resp) => {
          if (resp && typeof resp.productionCredits === 'number') {
            setState(s => applyOne(s, { kind: 'deal', id: dealId, patch: { productionCredits: resp.productionCredits } }));
          }
          return resp;
        });
    },
    useProjectCredit(dealId, title) {
      return actions.addProjectVideo(dealId, title, { fromCredit: true });
    },
    // Read-only fetch of a deal's invoices/payments (used by the signed-proposal
    // preview to show what's actually been paid). Returns the array; never throws.
    loadDealInvoices(dealId) {
      if (!dealId) return Promise.resolve([]);
      return api.get('/api/crm/invoices?dealId=' + encodeURIComponent(dealId))
        .then((rows) => Array.isArray(rows) ? rows : [])
        .catch(() => []);
    },
    sendVideoForReview(dealId, videoId) {
      return api.post('/api/crm/production/video/' + encodeURIComponent(videoId) + '/send-for-review', {})
        .then((resp) => Promise.all([dealId ? actions.loadDealDetail(dealId) : null, actions.loadVideo(videoId)]).then(() => resp));
    },
    // Link this project_video to an existing revision_video on the same deal
    // (the picker on the video page when titles didn't auto-match).
    linkRevisionVideo(dealId, videoId, revisionVideoId) {
      return api.post('/api/crm/production/video/' + encodeURIComponent(videoId) + '/link-revision', { revisionVideoId })
        .then((resp) => Promise.all([dealId ? actions.loadDealDetail(dealId) : null, actions.loadVideo(videoId)]).then(() => resp));
    },
    // Clear the link so this video isn't connected to any revision_video.
    unlinkRevisionVideo(dealId, videoId) {
      return api.post('/api/crm/production/video/' + encodeURIComponent(videoId) + '/unlink-revision', {})
        .then((resp) => Promise.all([dealId ? actions.loadDealDetail(dealId) : null, actions.loadVideo(videoId)]).then(() => resp));
    },
    // Same pair for the storyboard side: pick a storyboard on the same deal
    // (auto-link by title aside) or clear the link entirely.
    linkStoryboard(dealId, videoId, storyboardId) {
      return api.post('/api/crm/production/video/' + encodeURIComponent(videoId) + '/link-storyboard', { storyboardId })
        .then((resp) => Promise.all([dealId ? actions.loadDealDetail(dealId) : null, actions.loadVideo(videoId)]).then(() => resp));
    },
    unlinkStoryboard(dealId, videoId) {
      return api.post('/api/crm/production/video/' + encodeURIComponent(videoId) + '/unlink-storyboard', {})
        .then((resp) => Promise.all([dealId ? actions.loadDealDetail(dealId) : null, actions.loadVideo(videoId)]).then(() => resp));
    },
    // Hand off to the Storyboard Revisions section (lazily links a storyboard to
    // the video) and return its public share link.
    sendStoryboardForReview(dealId, videoId) {
      return api.post('/api/crm/production/video/' + encodeURIComponent(videoId) + '/send-storyboard-for-review', {})
        .then((resp) => Promise.all([dealId ? actions.loadDealDetail(dealId) : null, actions.loadVideo(videoId)]).then(() => resp));
    },

    // ---------- Video script + milestones ----------
    // Approve / un-approve a milestone. Approving advances the card forward on
    // the board (server-side); _mergeVideo reflects the new stage everywhere.
    approveVideoMilestone(videoId, milestone, approved) {
      return api.post('/api/crm/production/video/' + encodeURIComponent(videoId) + '/milestone', { milestone, approved })
        .then((video) => { actions._mergeVideo(video); return video; })
        .catch((err) => { showMsg(err.message || 'Could not update milestone'); throw err; });
    },
    // Upload a script (raw binary body, like uploadDealFile). Returns the
    // refreshed video (with its new `script`).
    async uploadVideoScript(videoId, file) {
      const res = await fetch('/api/crm/production/video/' + encodeURIComponent(videoId) + '/script', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
        body: file,
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Upload failed'); }
      const video = await res.json();
      actions._mergeVideo(video);
      return video;
    },
    deleteVideoScript(videoId, scriptId) {
      return api.delete('/api/crm/production/video/' + encodeURIComponent(videoId) + '/script?scriptId=' + encodeURIComponent(scriptId))
        .then((video) => { actions._mergeVideo(video); return video; })
        .catch(() => actions.loadVideo(videoId));
    },

    // ---------- Per-milestone content uploads ----------
    // Streams a file straight to the public Blob store, registers it under a
    // milestone (server also best-effort syncs it to Drive), returns the video.
    async uploadMilestoneAsset(videoId, milestone, file, { onProgress } = {}) {
      const { upload } = await import('@vercel/blob/client');
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = await upload('milestone-assets/' + videoId + '/' + milestone + '/' + Date.now() + '-' + safeName, file, {
        access: 'public',
        handleUploadUrl: '/api/crm/production/video/' + encodeURIComponent(videoId) + '/milestone-asset',
        contentType: file.type || 'application/octet-stream',
        multipart: true,
        onUploadProgress: onProgress ? (e) => onProgress(Math.round(e.percentage)) : undefined,
      });
      const video = await api.post(
        '/api/crm/production/video/' + encodeURIComponent(videoId) + '/milestone-asset?register=1&milestone=' + encodeURIComponent(milestone),
        { blobUrl: blob.url, blobPathname: blob.pathname, filename: file.name, mimeType: file.type || null, sizeBytes: file.size }
      );
      actions._mergeVideo(video);
      return video;
    },
    // Attach an external link (e.g. a Google Doc script) to a milestone instead
    // of uploading a file. Registers a link-only asset; re-opens the milestone.
    linkMilestoneAsset(videoId, milestone, url, filename) {
      return api.post(
        '/api/crm/production/video/' + encodeURIComponent(videoId) + '/milestone-asset?register=1&milestone=' + encodeURIComponent(milestone),
        { linkUrl: url, filename: filename || null }
      ).then((video) => { actions._mergeVideo(video); return video; });
    },
    deleteMilestoneAsset(videoId, assetId) {
      return api.delete('/api/crm/production/video/' + encodeURIComponent(videoId) + '/milestone-asset?assetId=' + encodeURIComponent(assetId))
        .then((video) => { actions._mergeVideo(video); return video; })
        .catch(() => actions.loadVideo(videoId));
    },

    // ---------- Admin: Blob storage usage / cost ----------
    loadBlobUsage({ refresh = false } = {}) {
      return api.get('/api/blob-usage' + (refresh ? '?refresh=1' : ''))
        .then((data) => { if (data && !data.error) setState(s => ({ ...s, blobUsage: data })); return data; })
        .catch(() => {});
    },

    // ---------- Admin: Neon database usage / cost ----------
    loadNeonUsage({ refresh = false } = {}) {
      return api.get('/api/neon-usage' + (refresh ? '?refresh=1' : ''))
        .then((data) => { if (data) setState(s => ({ ...s, neonUsage: data })); return data; })
        .catch((err) => { setState(s => ({ ...s, neonUsage: { error: err?.message || 'Could not load Neon usage' } })); });
    },

    // Persisted month-end CRM-cost snapshots (Storage tab's month stepper).
    loadCostSnapshots() {
      return api.get('/api/cost-snapshots')
        .then((data) => { const list = data?.snapshots || []; setState(s => ({ ...s, costSnapshots: list })); return list; })
        .catch(() => { setState(s => ({ ...s, costSnapshots: [] })); });
    },

    // Editable fixed monthly CRM cost line items (shared with the settings row).
    // Optimistic; each item: { id, label, amountUsd, note }.
    saveCostItems(list) {
      setState(s => ({ ...s, costItems: list }));
      return api.put('/api/settings', { costItems: list }).catch(() => {});
    },
    createContact(input) {
      return api.post('/api/crm/contacts', input).then((c) => {
        if (c && c.id) setState(s => ({ ...s, contacts: { ...s.contacts, [c.id]: c } }));
        return c;
      });
    },
    // Add a contact to an organisation (additive — the contact keeps any other
    // organisations). Merges the returned contact (incl. companyIds) into cache.
    addContactToCompany(contactId, companyId) {
      return api.post('/api/crm/contacts/' + encodeURIComponent(contactId) + '/companies', { companyId })
        .then((c) => {
          if (c && c.id) setState(s => ({ ...s, contacts: { ...s.contacts, [c.id]: { ...s.contacts[c.id], ...c } } }));
          return c;
        });
    },
    // Remove a contact from one organisation (leaves the contact and its other
    // organisations intact).
    removeContactFromCompany(contactId, companyId) {
      return api.delete('/api/crm/contacts/' + encodeURIComponent(contactId) + '/companies/' + encodeURIComponent(companyId))
        .then((c) => {
          if (c && c.id) setState(s => ({ ...s, contacts: { ...s.contacts, [c.id]: { ...s.contacts[c.id], ...c } } }));
          return c;
        });
    },
    saveContact(contactId, patch) {
      return mutate(
        { kind: 'contact', id: contactId, patch, errorMsg: 'Failed to save contact' },
        () => api.patch('/api/crm/contacts/' + encodeURIComponent(contactId), patch),
        undefined,
        (snap) => buildEditUndo(
          snap.contacts[contactId],
          patch,
          `Edit ${snap.contacts[contactId]?.name || 'contact'}`,
          (vals) => actions.saveContact(contactId, vals),
        ),
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
    // Find-or-create a local organisation from a Xero contact (links xeroContactId).
    importCompanyFromXero(xeroContactId) {
      return api.post('/api/crm/companies/from-xero-contact', { xeroContactId }).then((c) => {
        if (c && c.id) setState(s => ({ ...s, companies: { ...s.companies, [c.id]: c } }));
        return c;
      });
    },
    saveCompany(companyId, patch) {
      return mutate(
        { kind: 'company', id: companyId, patch, errorMsg: 'Failed to save company' },
        () => api.patch('/api/crm/companies/' + encodeURIComponent(companyId), patch),
        undefined,
        (snap) => buildEditUndo(
          snap.companies[companyId],
          patch,
          `Edit ${snap.companies[companyId]?.name || 'company'}`,
          (vals) => actions.saveCompany(companyId, vals),
        ),
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
        undefined,
        (snap) => {
          const before = snap.companies[companyId] || {};
          const wasVerified = !!before.customerVerifiedAt;
          if (wasVerified === !!verified) return null;
          return {
            label: verified ? 'Mark as customer' : 'Unmark customer',
            undo: () => actions.setCompanyCustomerVerified(companyId, wasVerified),
            redo: () => actions.setCompanyCustomerVerified(companyId, verified),
          };
        },
      );
    },
    refreshTasks(scope = 'open') {
      return api.get('/api/crm/tasks?scope=' + encodeURIComponent(scope)).then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        setState(s => ({ ...s, tasks: list }));
        return list;
      }).catch(() => []);
    },
    // Re-pull the open-task set (workspace-wide) and merge it over state.tasks
    // WITHOUT dropping any completed rows already loaded (the full Tasks page
    // keeps done tasks in state.tasks; the header only ever needs open ones).
    // Used by the header Tasks dropdown so it reflects completions made anywhere
    // — deal panel, extension, email link — not just ticks inside the menu.
    syncOpenTasks() {
      return api.get('/api/crm/tasks?scope=open').then((rows) => {
        const open = Array.isArray(rows) ? rows : [];
        setState(s => {
          const doneKept = (s.tasks || []).filter(t => t.doneAt); // open & done are disjoint by id
          return { ...s, tasks: [...open, ...doneKept] };
        });
        return open;
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
        undefined,
        (snap) => buildEditUndo(
          findTaskInState(snap, taskId),
          patch,
          'Edit task',
          (vals) => actions.saveTask(taskId, vals),
        ),
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
        (snap) => {
          const before = findTaskInState(snap, taskId);
          const wasDone = !!(before && before.doneAt);
          // toggleTask is its own inverse — flipping again restores the prior state.
          return {
            label: wasDone ? 'Reopen task' : 'Complete task',
            undo: () => actions.toggleTask(taskId),
            redo: () => actions.toggleTask(taskId),
          };
        },
      );
    },
    deleteTask(taskId) {
      return mutate(
        { kind: 'task', id: taskId, delete: true, errorMsg: 'Failed to delete task' },
        () => api.delete('/api/crm/tasks/' + encodeURIComponent(taskId)),
        undefined,
        (snap) => {
          const before = findTaskInState(snap, taskId);
          if (!before) return null;
          return {
            label: 'Delete task',
            // Restore re-inserts the task (same id) server-side; re-add it locally.
            undo: () => api.post('/api/crm/restore/' + encodeURIComponent(taskId))
              .then(() => { setState(s => applyOne(s, { kind: 'task', create: before })); }),
            redo: () => actions.deleteTask(taskId),
          };
        },
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

    // Mirror an inline thread-reply's live content, keyed by thread id, so it
    // survives navigating away from the conversation (the inline composer is
    // unmounted on navigation, unlike the dock composer). Cleared on send or
    // an explicit Discard. Attachments persist via their blob refs, same as
    // the dock composer's autosave.
    saveThreadDraft(threadId, snapshot) {
      if (!threadId) return;
      setState((s) => {
        const threadDrafts = { ...(s.threadDrafts || {}), [threadId]: { ...snapshot, threadId, savedAt: new Date().toISOString() } };
        saveLocal(THREAD_DRAFTS_KEY, threadDrafts);
        return { ...s, threadDrafts };
      });
    },
    clearThreadDraft(threadId) {
      if (!threadId) return;
      setState((s) => {
        if (!s.threadDrafts || !(threadId in s.threadDrafts)) return s;
        const threadDrafts = { ...s.threadDrafts };
        delete threadDrafts[threadId];
        saveLocal(THREAD_DRAFTS_KEY, threadDrafts);
        return { ...s, threadDrafts };
      });
    },

    // Continuously persist the open composer's live fields into its context, so
    // a refresh or accidental close restores the in-progress draft. Preserves
    // sessionId so the open composer is NOT remounted (no lost focus/caret).
    autosaveComposerDraft(patch) {
      setState((s) => {
        if (!s.composerContext) return s;
        const ctx = {
          ...s.composerContext,
          initialDraft: { ...(s.composerContext.initialDraft || {}), ...patch },
        };
        saveLocal(COMPOSER_CONTEXT_KEY, ctx);
        return { ...s, composerContext: ctx };
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
              // The qualifier owns the new deal. The server already sets this,
              // but stamp it from the session too so the card never shows
              // "unassigned" even if the response omits the owner.
              const dealWithOwner = resp.deal
                ? { ...resp.deal, ownerEmail: resp.deal.ownerEmail || s.session?.email || null }
                : null;
              const nextDeals = dealWithOwner
                ? { ...s.deals, [dealWithOwner.id]: dealWithOwner }
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
    clearQuoteRequest(id) {
      // Neutral "remove from the inbox" — keeps the lead (and its contact/files)
      // and does NOT mark it disqualified, so marketing quality metrics are
      // untouched. Optimistically drop it from the current list (the contact is
      // intentionally left in place, unlike disqualify).
      setState(s => ({ ...s, quoteRequests: s.quoteRequests.filter(r => r.id !== id) }));
      return api.post('/api/quote-requests-admin/' + encodeURIComponent(id) + '/clear', {})
        .then(() => true)
        .catch(() => { fetchAllRef.current?.(); return false; });
    },
    clearNewQuoteRequests() {
      // Bulk: clear every still-"new" request in one call. Optimistically drop
      // them locally; refetch on failure to re-sync.
      setState(s => ({ ...s, quoteRequests: s.quoteRequests.filter(r => r.status !== 'new') }));
      return api.post('/api/quote-requests-admin?_action=clear-new', {})
        .then((r) => (r && Array.isArray(r.clearedIds)) ? r.clearedIds.length : 0)
        .catch(() => { fetchAllRef.current?.(); return -1; });
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
    loadMailboxFolder(folder, { pageToken = null, q = '', unread = false } = {}) {
      const append = pageToken != null;
      setState(s => ({ ...s, mailbox: { ...s.mailbox, [folder]: { ...(s.mailbox?.[folder] || {}), loading: true } } }));
      const params = new URLSearchParams({ label: folder });
      if (pageToken) params.set('pageToken', pageToken);
      if (q) params.set('q', q);
      if (unread) params.set('unread', '1');
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
    // Gmail server search (whole words, whole mailbox), stored apart from the
    // folder slices so the open folder's rows survive. The UI also filters the
    // loaded folder client-side for instant partial-word matches.
    loadMailboxSearch(folder, { pageToken = null, q = '', unread = false } = {}) {
      const append = pageToken != null;
      setState(s => ({ ...s, mailboxSearch: { ...(s.mailboxSearch || {}), q, loading: true, error: null } }));
      const params = new URLSearchParams({ label: folder });
      if (pageToken) params.set('pageToken', pageToken);
      if (q) params.set('q', q);
      if (unread) params.set('unread', '1');
      return api.get('/api/crm/gmail/folder?' + params.toString())
        .then((data) => {
          const incoming = Array.isArray(data?.rows) ? data.rows : [];
          setState(s => {
            // Ignore a stale response whose query no longer matches the box.
            if ((s.mailboxSearch?.q ?? '') !== q) return s;
            const prev = s.mailboxSearch || {};
            const rows = append ? [...(prev.rows || []), ...incoming] : incoming;
            return { ...s, mailboxSearch: { q, rows, next: data?.nextPageToken ?? null, loading: false, error: null } };
          });
          return data;
        })
        .catch((err) => {
          setState(s => ((s.mailboxSearch?.q ?? '') !== q ? s
            : { ...s, mailboxSearch: { ...(s.mailboxSearch || {}), loading: false, error: err?.message || 'Search failed' } }));
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
      // Which sidebar badge this folder drives, and whether it's an unread or a
      // total count. Used to adjust the badge optimistically — Gmail's own
      // label/search counts lag a few seconds after a modify, so we can't rely
      // on an immediate re-fetch (that's what made the pill look stuck).
      const FOLDER_LABEL = {
        inbox:      { key: 'INBOX',               field: 'threadsUnread' },
        unread:     { key: 'UNREAD',              field: 'threadsTotal'  },
        spam:       { key: 'SPAM',                field: 'threadsUnread' },
        social:     { key: 'CATEGORY_SOCIAL',     field: 'threadsUnread' },
        updates:    { key: 'CATEGORY_UPDATES',    field: 'threadsUnread' },
        forums:     { key: 'CATEGORY_FORUMS',     field: 'threadsUnread' },
        promotions: { key: 'CATEGORY_PROMOTIONS', field: 'threadsUnread' },
      };
      // The same optimistic transform applied to any row list: drop the acted
      // rows when the action removes them from this folder, else patch their
      // read/star flags in place.
      const applyToRows = (list) => (removesFromFolder
        ? list.filter(r => !idSet.has(r.id))
        : list.map(r => {
            if (!idSet.has(r.id)) return r;
            if (action === 'markRead')   return { ...r, unread: false };
            if (action === 'markUnread') return { ...r, unread: true };
            if (action === 'star')       return { ...r, starred: true };
            if (action === 'unstar')     return { ...r, starred: false };
            return r;
          }));
      let activeSearchQ = null; // captured for the error-recovery re-sync below
      setState(s => {
        const f = s.mailbox?.[folder];
        if (!f || !Array.isArray(f.rows)) return s;
        const acted = f.rows.filter(r => idSet.has(r.id));
        const actedUnread = acted.filter(r => r.unread).length;
        const actedRead = acted.length - actedUnread;
        const rows = applyToRows(f.rows);

        // While searching, the visible list is (partly) the server search
        // results, not the folder rows — keep that slice in sync too, otherwise
        // a deleted/archived row that came from search lingers on screen until
        // the next refresh.
        const searchSlice = s.mailboxSearch;
        activeSearchQ = searchSlice?.q || null;
        const mailboxSearch = (searchSlice && Array.isArray(searchSlice.rows))
          ? { ...searchSlice, rows: applyToRows(searchSlice.rows) }
          : searchSlice;

        // Optimistic badge maths so the sidebar updates instantly.
        const labels = { ...(s.mailboxLabels || {}) };
        const bump = (key, field, delta) => {
          if (!key || !delta || !labels[key]) return;
          labels[key] = { ...labels[key], [field]: Math.max(0, (labels[key][field] || 0) + delta) };
        };
        const fk = FOLDER_LABEL[folder];
        if (fk?.field === 'threadsUnread') {
          if (action === 'markRead')        bump(fk.key, 'threadsUnread', -actedUnread);
          else if (action === 'markUnread') bump(fk.key, 'threadsUnread', +actedRead);
          else if (removesFromFolder)       bump(fk.key, 'threadsUnread', -actedUnread);
        } else if (fk?.field === 'threadsTotal') { // the dedicated "Unread" folder
          if (action === 'markRead' || removesFromFolder) bump(fk.key, 'threadsTotal', -acted.length);
        }
        // Keep the global "Unread" sidebar count honest too (skip if it's the
        // active folder, already handled above).
        if (folder !== 'unread') {
          if (action === 'markRead')        bump('UNREAD', 'threadsTotal', -actedUnread);
          else if (action === 'markUnread') bump('UNREAD', 'threadsTotal', +actedRead);
          else if (removesFromFolder)       bump('UNREAD', 'threadsTotal', -actedUnread);
        }

        return { ...s, mailbox: { ...s.mailbox, [folder]: { ...f, rows } }, mailboxLabels: labels, mailboxSearch };
      });
      // No immediate label re-fetch: Gmail's counts lag after a modify and
      // would overwrite the (correct) optimistic badge with a stale value.
      // Counts reconcile on folder switch / manual refresh, by which point
      // Gmail has caught up.
      return api.post('/api/crm/gmail/modify', { action, ids: idList })
        .catch((err) => {
          // Re-sync folder + labels so the optimistic changes don't stick on error.
          actions.loadMailboxFolder(folder);
          actions.loadMailboxLabels();
          // Also re-sync the search slice if one was on screen (we mutated it).
          if (activeSearchQ) actions.loadMailboxSearch(folder, { q: activeSearchQ });
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
    async uploadDealFile(dealId, file, onProgress, signal, folderId = null) {
      const addToState = (newFile) => setState(s => {
        const detail = s.dealDetail[dealId];
        if (!detail) return s;
        return { ...s, dealDetail: { ...s.dealDetail, [dealId]: { ...detail, files: [newFile, ...(detail.files || [])] } } };
      });

      const base = '/api/crm/deals/' + encodeURIComponent(dealId) + '/files';
      const mime = file.type || 'application/octet-stream';

      // Chunked Drive upload: the browser streams the file to our server in 4 MB
      // chunks, which we forward into a Drive resumable session. This bypasses
      // the serverless body limit (so large videos work) and avoids the
      // browser→Google CORS that direct uploads hit. Drive off → fall back below.
      const start = file.size > 0
        ? await api.post(base + '/drive-upload-start', { filename: file.name, mimeType: mime, folderId })
        : null;
      if (start && start.enabled !== false && start.uploadUrl) {
        const CHUNK = 4 * 1024 * 1024; // 4 MB — multiple of 256 KB, under the body limit
        const MAX_RETRIES = 6;
        const total = file.size;
        // Subfolder uploads are browsed live from Drive — keep them out of the
        // deal's root file list (detail.files).
        const intoRoot = !start.folderId || !start.rootId || start.folderId === start.rootId;
        const uploadHeaders = {
          'X-Upload-Url': start.uploadUrl,
          'X-Filename': encodeURIComponent(file.name),
          'X-Mime': mime,
          ...(start.folderId ? { 'X-Folder-Id': start.folderId } : {}),
        };
        let offset = 0;
        let result = null;
        let attempt = 0;
        onProgress?.(0, total);
        while (offset < total) {
          if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
          const end = Math.min(offset + CHUNK, total);
          try {
            const res = await fetch(base + '/drive-chunk', {
              method: 'POST',
              credentials: 'include',
              signal,
              headers: { ...uploadHeaders, 'Content-Type': 'application/octet-stream', 'X-Content-Range': `bytes ${offset}-${end - 1}/${total}` },
              body: file.slice(offset, end),
            });
            if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Upload failed'); }
            const j = await res.json();
            attempt = 0;
            if (j.done) { result = j.file; break; }
            offset = end;
            onProgress?.(offset, total);
          } catch (err) {
            // Don't retry a user cancellation — surface it.
            if (signal?.aborted || err.name === 'AbortError') throw err;
            // Resume: a chunk failed — ask Drive how much it has and continue
            // from there, retrying with backoff before giving up.
            attempt += 1;
            if (attempt > MAX_RETRIES) throw err;
            await new Promise((r) => setTimeout(r, 800 * attempt));
            if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
            try {
              const st = await fetch(base + '/drive-status', {
                method: 'POST', credentials: 'include', signal,
                headers: { ...uploadHeaders, 'X-Total': String(total) },
              }).then((r) => r.json());
              if (st.done) { result = st.file; break; }
              offset = Number(st.received) || offset;
              onProgress?.(offset, total);
            } catch (e2) { if (signal?.aborted || e2.name === 'AbortError') throw e2; /* else keep offset; retry */ }
          }
        }
        if (result) { if (intoRoot) addToState(result); return result; }
        throw new Error('Upload did not complete');
      }

      // Fallback (Drive off, or empty file): raw POST to the server (Blob, or a
      // single server-side Drive upload). Raw binary body skips the `api` wrapper.
      const res = await fetch(base, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': mime,
          'X-Filename': encodeURIComponent(file.name),
          ...(folderId ? { 'X-Folder-Id': folderId } : {}),
        },
        body: file,
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Upload failed'); }
      const newFile = await res.json();
      if (!folderId) addToState(newFile); // root upload → reflect in the file list
      return newFile;
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

    // ---------- Purchase orders (PO-route deals) ----------
    // Record the received PO number (requires a non-empty number — the server
    // 400s on blank). Updates the deal-detail PO slice when it's loaded.
    markDealPoReceived(dealId, poNumber) {
      return api.post('/api/crm/deals/' + encodeURIComponent(dealId) + '/po', { poNumber }).then((r) => {
        setState(s => {
          const detail = s.dealDetail[dealId];
          if (!detail) return s;
          const po = { ...(detail.purchaseOrder || {}), number: r.poNumber, receivedAt: r.poReceivedAt };
          return { ...s, dealDetail: { ...s.dealDetail, [dealId]: { ...detail, purchaseOrder: po } } };
        });
        return r;
      });
    },
    clearDealPo(dealId) {
      return api.delete('/api/crm/deals/' + encodeURIComponent(dealId) + '/po').then((r) => {
        setState(s => {
          const detail = s.dealDetail[dealId];
          if (!detail) return s;
          const po = { ...(detail.purchaseOrder || {}), number: null, receivedAt: null };
          return { ...s, dealDetail: { ...s.dealDetail, [dealId]: { ...detail, purchaseOrder: po } } };
        });
        return r;
      });
    },
    // Upload a PO document (raw binary, like the Blob fallback in uploadDealFile).
    async uploadDealPoFile(dealId, file) {
      const mime = file.type || 'application/octet-stream';
      const res = await fetch('/api/crm/deals/' + encodeURIComponent(dealId) + '/po-files', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': mime, 'X-Filename': encodeURIComponent(file.name) },
        body: file,
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Upload failed'); }
      const newFile = await res.json();
      setState(s => {
        const detail = s.dealDetail[dealId];
        if (!detail) return s;
        const po = detail.purchaseOrder || {};
        return { ...s, dealDetail: { ...s.dealDetail, [dealId]: { ...detail, purchaseOrder: { ...po, files: [newFile, ...(po.files || [])] } } } };
      });
      return newFile;
    },
    deleteDealPoFile(dealId, fileId) {
      setState(s => {
        const detail = s.dealDetail[dealId];
        if (!detail) return s;
        const po = detail.purchaseOrder || {};
        return { ...s, dealDetail: { ...s.dealDetail, [dealId]: { ...detail, purchaseOrder: { ...po, files: (po.files || []).filter(f => f.id !== fileId) } } } };
      });
      return api.delete('/api/crm/deals/' + encodeURIComponent(dealId) + '/po-files/' + encodeURIComponent(fileId))
        .catch(() => actions.loadDealDetail(dealId));
    },
    getPoFileDownloadUrl(dealId, fileId) {
      return api.get('/api/crm/deals/' + encodeURIComponent(dealId) + '/po-files/' + encodeURIComponent(fileId));
    },

    // Lay down the standard production subfolder template in the deal's Drive
    // folder (idempotent). Re-pulls the deal so any newly-created folders show.
    setupDealFolders(dealId) {
      return api.post('/api/crm/deals/' + encodeURIComponent(dealId) + '/files/setup-folders', {})
        .then((resp) => actions.loadDealDetail(dealId).then(() => resp));
    },

    // Fetch the deal's Drive subfolder tree (for showing structure in the Files
    // card). Returns { folders: [...] }.
    loadDealFolders(dealId) {
      return api.get('/api/crm/deals/' + encodeURIComponent(dealId) + '/files/folders');
    },

    // List one folder's contents (subfolders + files) for the in-card browser.
    // Omit folderId for the deal's root folder. Returns { rootId, folderId,
    // folders, files }.
    loadDealFolderContents(dealId, folderId = null) {
      const qs = folderId ? '?folderId=' + encodeURIComponent(folderId) : '';
      return api.get('/api/crm/deals/' + encodeURIComponent(dealId) + '/files/contents' + qs);
    },

    // Delete a Drive file (by its Drive id) shown in the folder browser.
    deleteDealDriveFile(dealId, driveFileId) {
      return api.delete('/api/crm/deals/' + encodeURIComponent(dealId) + '/files/drive-delete?fileId=' + encodeURIComponent(driveFileId));
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

    // Link/unlink a project to a CRM deal (its team gets the feedback alerts).
    linkRevisionDeal(projectId, dealId) {
      return api.post('/api/revisions/link-deal?projectId=' + encodeURIComponent(projectId), { dealId: dealId || null })
        .then((resp) => {
          setState(s => ({ ...s, revisions: (s.revisions || []).map(p => p.id === projectId ? { ...p, dealId: resp.dealId } : p) }));
          return resp;
        });
    },

    // Assign the revision project to a producer (or clear with null).
    assignRevisionProject(projectId, assigneeEmail) {
      return api.post('/api/revisions/assign?projectId=' + encodeURIComponent(projectId), { assigneeEmail: assigneeEmail || null })
        .then((resp) => { actions.loadRevisionDetail(projectId); return resp; });
    },
    // Mark a draft complete (or reopen it).
    completeRevisionVersion(projectId, versionId, complete = true) {
      return api.post('/api/revisions/complete-version?id=' + encodeURIComponent(versionId), { complete })
        .then((resp) => { actions.loadRevisionDetail(projectId); return resp; });
    },
    // Tick an individual client comment (revision request) complete / reopen it.
    completeRevisionComment(projectId, commentId, complete = true) {
      return api.post('/api/revisions/complete-comment?id=' + encodeURIComponent(commentId), { complete })
        .then((resp) => { actions.loadRevisionDetail(projectId); return resp; });
    },
    // Set/clear the producer's internal note on a comment (team-only).
    setRevisionCommentNote(projectId, commentId, note) {
      return api.post('/api/revisions/comment-note?id=' + encodeURIComponent(commentId), { note: note || null })
        .then((resp) => { actions.loadRevisionDetail(projectId); return resp; });
    },

    // Engagement analytics for one project (per-viewer rollup + totals).
    loadRevisionAnalytics(id) {
      return api.get('/api/revisions/analytics?id=' + encodeURIComponent(id));
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
    // The endpoint doubles as a presence heartbeat: when viewerEmail is sent
    // along, the server bumps last_seen and returns activeViewers + per-comment
    // `mine` flags. The viewer polls this on a timer for live updates.
    loadPublicRevision(token, viewerEmail) {
      setState(s => ({ ...s, loading: true }));
      const q = new URLSearchParams({ token });
      if (viewerEmail) q.set('viewerEmail', viewerEmail);
      return api.get('/api/revisions/public?' + q.toString())
        .then((data) => { setState(s => ({ ...s, loading: false })); return data; })
        .catch((err) => { setState(s => ({ ...s, loading: false })); throw err; });
    },

    // Silent poll variant — same endpoint, no global loading flash. Used by the
    // viewer's heartbeat to refresh comments + activeViewers + approval state.
    pollPublicRevision(token, viewerEmail) {
      const q = new URLSearchParams({ token });
      if (viewerEmail) q.set('viewerEmail', viewerEmail);
      return api.get('/api/revisions/public?' + q.toString());
    },

    postRevisionComment(token, payload) {
      return api.post('/api/revisions/comment?token=' + encodeURIComponent(token), payload);
    },

    // Client edits the body of their own comment.
    editRevisionComment(token, id, body, viewerEmail) {
      return api.patch(
        '/api/revisions/comment?token=' + encodeURIComponent(token) + '&id=' + encodeURIComponent(id),
        { body, viewerEmail },
      );
    },

    // Client deletes their own comment.
    deleteRevisionComment(token, id, viewerEmail) {
      return api.delete(
        '/api/revisions/comment?token=' + encodeURIComponent(token)
          + '&id=' + encodeURIComponent(id)
          + '&viewerEmail=' + encodeURIComponent(viewerEmail),
      );
    },

    // Name + email gate: records the viewer before they see the videos.
    recordRevisionViewer(token, { name, email }) {
      return api.post('/api/revisions/viewer?token=' + encodeURIComponent(token), { name, email });
    },

    // Client finalises one video (locks further comments on its drafts).
    approveRevision(token, videoId, approvedBy) {
      return api.post('/api/revisions/approve?token=' + encodeURIComponent(token), { videoId, approvedBy });
    },

    // Client submits their feedback for one video — fires one team notification.
    submitRevisionFeedback(token, videoId, name) {
      return api.post('/api/revisions/submit-feedback?token=' + encodeURIComponent(token), { videoId, name });
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

    // ---------- Storyboard revisions (PDF review links) ----------
    loadStoryboards() {
      return api.get('/api/storyboards/projects')
        .then((list) => { setState(s => ({ ...s, storyboards: list || [] })); return list; })
        .catch(() => {});
    },

    createStoryboardProject(payload) {
      return api.post('/api/storyboards/projects', payload).then((project) => {
        setState(s => ({ ...s, storyboards: [project, ...(s.storyboards || [])] }));
        return project;
      });
    },

    deleteStoryboardProject(id) {
      setState(s => ({ ...s, storyboards: (s.storyboards || []).filter(p => p.id !== id) }));
      return api.delete('/api/storyboards/projects?id=' + encodeURIComponent(id))
        .catch(() => actions.loadStoryboards());
    },

    loadStoryboardDetail(id) {
      return api.get('/api/storyboards/detail?id=' + encodeURIComponent(id))
        .then((detail) => {
          setState(s => ({ ...s, storyboardDetail: { ...s.storyboardDetail, [id]: detail } }));
          return detail;
        });
    },

    // Link/unlink a project to a CRM deal (its team gets the feedback alerts).
    linkStoryboardDeal(projectId, dealId) {
      return api.post('/api/storyboards/link-deal?projectId=' + encodeURIComponent(projectId), { dealId: dealId || null })
        .then((resp) => {
          setState(s => ({ ...s, storyboards: (s.storyboards || []).map(p => p.id === projectId ? { ...p, dealId: resp.dealId } : p) }));
          return resp;
        });
    },

    assignStoryboardProject(projectId, assigneeEmail) {
      return api.post('/api/storyboards/assign?projectId=' + encodeURIComponent(projectId), { assigneeEmail: assigneeEmail || null })
        .then((resp) => { actions.loadStoryboardDetail(projectId); return resp; });
    },
    completeStoryboardVersion(projectId, versionId, complete = true) {
      return api.post('/api/storyboards/complete-version?id=' + encodeURIComponent(versionId), { complete })
        .then((resp) => { actions.loadStoryboardDetail(projectId); return resp; });
    },
    completeStoryboardComment(projectId, commentId, complete = true) {
      return api.post('/api/storyboards/complete-comment?id=' + encodeURIComponent(commentId), { complete })
        .then((resp) => { actions.loadStoryboardDetail(projectId); return resp; });
    },
    setStoryboardCommentNote(projectId, commentId, note) {
      return api.post('/api/storyboards/comment-note?id=' + encodeURIComponent(commentId), { note: note || null })
        .then((resp) => { actions.loadStoryboardDetail(projectId); return resp; });
    },

    // Engagement analytics for one project (per-viewer rollup + totals).
    loadStoryboardAnalytics(id) {
      return api.get('/api/storyboards/analytics?id=' + encodeURIComponent(id));
    },

    // Add / remove storyboards within a project. Both reload the project detail
    // so the nested storyboards→drafts structure stays in sync.
    createStoryboard(projectId, title) {
      return api.post('/api/storyboards/storyboards?projectId=' + encodeURIComponent(projectId), { title })
        .then((storyboard) => actions.loadStoryboardDetail(projectId).then(() => storyboard));
    },

    deleteStoryboard(projectId, storyboardId) {
      return api.delete('/api/storyboards/storyboards?id=' + encodeURIComponent(storyboardId))
        .then(() => actions.loadStoryboardDetail(projectId))
        .catch(() => actions.loadStoryboardDetail(projectId));
    },

    // Streams a draft PDF straight to Vercel Blob, reads its page count via
    // pdf.js, registers it under a storyboard, then reloads the project detail.
    async uploadStoryboardVersion(projectId, storyboardId, file, { label = null, onProgress } = {}) {
      const { upload } = await import('@vercel/blob/client');
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = await upload('storyboard-pdfs/' + storyboardId + '/' + safeName, file, {
        access: 'public',
        handleUploadUrl: '/api/storyboards/upload-token',
        contentType: file.type || 'application/pdf',
        multipart: true,
        onUploadProgress: onProgress ? (e) => onProgress(Math.round(e.percentage)) : undefined,
      });
      // Count slides so the version row stores page_count (best-effort: a parse
      // failure just leaves it null).
      let pageCount = null;
      try {
        const { pdfPageCount } = await import('./lib/pdf.js');
        pageCount = await pdfPageCount(blob.url);
      } catch { /* page_count stays null */ }
      const version = await api.post(
        '/api/storyboards/versions?storyboardId=' + encodeURIComponent(storyboardId),
        { blobUrl: blob.url, blobPathname: blob.pathname, filename: file.name,
          mimeType: file.type || null, sizeBytes: file.size, pageCount, label }
      );
      await actions.loadStoryboardDetail(projectId);
      return version;
    },

    deleteStoryboardVersion(projectId, versionId) {
      return api.delete('/api/storyboards/versions?id=' + encodeURIComponent(versionId))
        .then(() => actions.loadStoryboardDetail(projectId))
        .catch(() => actions.loadStoryboardDetail(projectId));
    },

    // ---------- Public storyboard viewer (no auth) ----------
    loadPublicStoryboard(token, viewerEmail) {
      setState(s => ({ ...s, loading: true }));
      const q = new URLSearchParams({ token });
      if (viewerEmail) q.set('viewerEmail', viewerEmail);
      return api.get('/api/storyboards/public?' + q.toString())
        .then((data) => { setState(s => ({ ...s, loading: false })); return data; })
        .catch((err) => { setState(s => ({ ...s, loading: false })); throw err; });
    },
    // Silent poll variant — same endpoint, no global loading flash. Used by
    // StoryboardRevision's heartbeat to refresh comments + activeViewers state.
    pollPublicStoryboard(token, viewerEmail) {
      const q = new URLSearchParams({ token });
      if (viewerEmail) q.set('viewerEmail', viewerEmail);
      return api.get('/api/storyboards/public?' + q.toString());
    },

    postStoryboardComment(token, payload) {
      return api.post('/api/storyboards/comment?token=' + encodeURIComponent(token), payload);
    },

    // Client edits the body of their own storyboard comment.
    editStoryboardComment(token, id, body, viewerEmail) {
      return api.patch(
        '/api/storyboards/comment?token=' + encodeURIComponent(token) + '&id=' + encodeURIComponent(id),
        { body, viewerEmail },
      );
    },

    // Client deletes their own storyboard comment.
    deleteStoryboardComment(token, id, viewerEmail) {
      return api.delete(
        '/api/storyboards/comment?token=' + encodeURIComponent(token)
          + '&id=' + encodeURIComponent(id)
          + '&viewerEmail=' + encodeURIComponent(viewerEmail),
      );
    },

    recordStoryboardViewer(token, { name, email }) {
      return api.post('/api/storyboards/viewer?token=' + encodeURIComponent(token), { name, email });
    },

    // Client finalises one storyboard (locks further comments on its drafts).
    approveStoryboard(token, storyboardId, approvedBy) {
      return api.post('/api/storyboards/approve?token=' + encodeURIComponent(token), { storyboardId, approvedBy });
    },

    // Client submits their feedback for one storyboard — one team notification.
    submitStoryboardFeedback(token, storyboardId, name) {
      return api.post('/api/storyboards/submit-feedback?token=' + encodeURIComponent(token), { storyboardId, name });
    },

    recordStoryboardView(token, payload) {
      return api.post('/api/storyboards/view?token=' + encodeURIComponent(token), payload).catch(() => {});
    },

    // Uploads a comment's supporting asset straight to the public storyboard
    // Blob store (gated by the share token), returning { url, name, type }.
    async uploadStoryboardAsset(token, file, { onProgress } = {}) {
      const { upload } = await import('@vercel/blob/client');
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = await upload('storyboard-assets/' + token + '/' + Date.now() + '-' + safeName, file, {
        access: 'public',
        handleUploadUrl: '/api/storyboards/asset-token?token=' + encodeURIComponent(token),
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

    // ---------- In-app notification feed (the bells) ----------
    // Each action takes a `channel` ('finance' | 'general') so the two bells
    // operate independently. State lives in s.notificationsByChannel[channel].
    loadNotifications() {
      return api.get('/api/notifications').then((r) => {
        setState(s => ({ ...s, notificationsByChannel: normalizeNotificationChannels(r) }));
        return r;
      });
    },
    // Optimistically flag the given ids read in their channel and recompute the
    // badge, then persist. Server failure is non-fatal — the next poll reconciles.
    markNotificationsRead(ids, channel = 'general') {
      const idset = new Set(ids);
      setState(s => {
        const ch = s.notificationsByChannel[channel] || { items: [], unread: 0 };
        const items = ch.items.map(n => (idset.has(n.id) ? { ...n, read: true } : n));
        return { ...s, notificationsByChannel: { ...s.notificationsByChannel, [channel]: { items, unread: items.filter(n => !n.read).length } } };
      });
      return api.post('/api/notifications', { ids }).catch(() => {});
    },
    markAllNotificationsRead(channel = 'general') {
      setState(s => {
        const ch = s.notificationsByChannel[channel] || { items: [], unread: 0 };
        return { ...s, notificationsByChannel: { ...s.notificationsByChannel, [channel]: { items: ch.items.map(n => ({ ...n, read: true })), unread: 0 } } };
      });
      return api.post('/api/notifications', { all: true, channel }).catch(() => {});
    },
    // Remove a single notification from its channel. Optimistic; next poll reconciles.
    dismissNotification(id, channel = 'general') {
      setState(s => {
        const ch = s.notificationsByChannel[channel] || { items: [], unread: 0 };
        const items = ch.items.filter(n => n.id !== id);
        return { ...s, notificationsByChannel: { ...s.notificationsByChannel, [channel]: { items, unread: items.filter(n => !n.read).length } } };
      });
      return api.delete('/api/notifications?id=' + encodeURIComponent(id)).catch(() => {});
    },
    // Clear one channel's feed.
    clearNotifications(channel = 'general') {
      setState(s => ({ ...s, notificationsByChannel: { ...s.notificationsByChannel, [channel]: { items: [], unread: 0 } } }));
      return api.delete('/api/notifications?channel=' + encodeURIComponent(channel)).catch(() => {});
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
