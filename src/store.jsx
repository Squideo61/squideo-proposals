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
    income: null,
    financeTargets: [],
    salesTargets: [],
    bankHolidays: null,
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
    // Business → Finance: outstanding balance per signed deal (PO vs normal) +
    // the imported manual pending payments group.
    loadPendingPayments() {
      return api.get('/api/crm/stats/pending').then((data) => {
        setState(s => ({ ...s, pendingPayments: data || null }));
        return data;
      }).catch(() => null);
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
    deleteDeal(dealId) {
      return mutate(
        { kind: 'deal', id: dealId, delete: true, errorMsg: 'Failed to delete deal' },
        () => api.delete('/api/crm/deals/' + encodeURIComponent(dealId)),
      );
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
      return api.delete('/api/crm/production/video/' + encodeURIComponent(videoId)).then(done).catch(done);
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
    sendVideoForReview(dealId, videoId) {
      return api.post('/api/crm/production/video/' + encodeURIComponent(videoId) + '/send-for-review', {})
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
      setState(s => {
        const f = s.mailbox?.[folder];
        if (!f || !Array.isArray(f.rows)) return s;
        const acted = f.rows.filter(r => idSet.has(r.id));
        const actedUnread = acted.filter(r => r.unread).length;
        const actedRead = acted.length - actedUnread;
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

        return { ...s, mailbox: { ...s.mailbox, [folder]: { ...f, rows } }, mailboxLabels: labels };
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
    loadPublicStoryboard(token) {
      setState(s => ({ ...s, loading: true }));
      return api.get('/api/storyboards/public?token=' + encodeURIComponent(token))
        .then((data) => { setState(s => ({ ...s, loading: false })); return data; })
        .catch((err) => { setState(s => ({ ...s, loading: false })); throw err; });
    },

    postStoryboardComment(token, payload) {
      return api.post('/api/storyboards/comment?token=' + encodeURIComponent(token), payload);
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
