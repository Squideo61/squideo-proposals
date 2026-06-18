import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Plus, X, Search, FileText, ChevronDown, Check, Pencil } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { STAGE_COLOURS, PIPELINE_STAGES } from '../../lib/stages.js';
import { Avatar } from '../Avatar.jsx';
import { TaskFormModal } from './TaskFormModal.jsx';

const STAGE_LABEL = Object.fromEntries(PIPELINE_STAGES.map(s => [s.id, s.label]));

// The deal-context panel shown on the right of an open conversation — the
// in-app twin of the Chrome extension's Gmail sidebar. Tells you which deal(s)
// a thread is on (or suggests/lets you attach one) and surfaces the deal's
// stage, value, owner, open tasks and recent activity.
export function DealContextPanel({ gmailThreadId, counterpartyEmail, onOpenDeal, onOpenProposal }) {
  const { state, actions } = useStore();
  const links = state.threadDeals?.[gmailThreadId]; // undefined = not resolved yet

  // Resolve the thread→deal association on first view (and after attach/detach,
  // which clears the cache entry, flipping this back to undefined).
  useEffect(() => {
    if (links === undefined) {
      actions.resolveThreadDeals([{ threadId: gmailThreadId, senderEmails: counterpartyEmail ? [counterpartyEmail] : [] }]);
    }
  }, [gmailThreadId, links === undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  if (links === undefined) return <Wrap><Muted>Loading deal…</Muted></Wrap>;

  const linked = links.filter(l => l.source !== 'contact');     // explicit email_thread_deals links
  const suggested = links.filter(l => l.source === 'contact');  // sender matches a deal contact

  if (linked.length) {
    return <LinkedView linked={linked} gmailThreadId={gmailThreadId} counterpartyEmail={counterpartyEmail} onOpenDeal={onOpenDeal} onOpenProposal={onOpenProposal} />;
  }
  if (suggested.length) {
    return <SuggestedView suggested={suggested} gmailThreadId={gmailThreadId} counterpartyEmail={counterpartyEmail} onOpenDeal={onOpenDeal} />;
  }
  return <UnlinkedView gmailThreadId={gmailThreadId} counterpartyEmail={counterpartyEmail} />;
}

function LinkedView({ linked, gmailThreadId, counterpartyEmail, onOpenDeal, onOpenProposal }) {
  const { state, actions, showMsg } = useStore();
  const [busy, setBusy] = useState(false);
  const primary = linked[0];
  const detail = primary ? state.dealDetail?.[primary.dealId] : null;

  useEffect(() => {
    if (primary?.dealId) actions.loadDealDetail(primary.dealId);
  }, [primary?.dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const detach = async (dealId) => {
    if (!window.confirm('Remove this thread from the deal?')) return;
    setBusy(true);
    try { await actions.detachThreadFromDeal({ gmailThreadId, dealId }); showMsg('Removed from deal'); }
    finally { setBusy(false); }
  };

  return (
    <Wrap>
      <Label>This thread is on</Label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0 14px' }}>
        {linked.map(d => (
          <DealChip key={d.dealId} title={d.title} stage={state.deals?.[d.dealId]?.stage || d.stage} onRemove={() => detach(d.dealId)} disabled={busy} />
        ))}
      </div>

      {detail && <DealDetailBlock detail={detail} gmailThreadId={gmailThreadId} onOpenDeal={onOpenDeal} onOpenProposal={onOpenProposal} />}

      <AttachPicker
        gmailThreadId={gmailThreadId}
        counterpartyEmail={counterpartyEmail}
        excludeDealIds={linked.map(d => d.dealId)}
        label="Add to another deal"
        collapsedLabel="+ Add to another deal"
      />
    </Wrap>
  );
}

function SuggestedView({ suggested, gmailThreadId, counterpartyEmail, onOpenDeal }) {
  const { actions, showMsg } = useStore();
  const [busy, setBusy] = useState(false);

  const attach = async (dealId) => {
    setBusy(true);
    try { await actions.attachThreadToDeal({ gmailThreadId, counterpartyEmail, dealId }); showMsg('Attached to deal'); }
    finally { setBusy(false); }
  };

  return (
    <Wrap>
      <Label>{suggested.length === 1 ? 'Looks like this is about' : 'Possibly related'}</Label>
      <div style={{ margin: '6px 0 12px' }}>
        {suggested.map(d => (
          <div key={d.dealId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '1px solid ' + BRAND.border }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <button onClick={() => onOpenDeal?.(d.dealId)} style={linkBtn} title="Open deal">{d.title}</button>
              <div style={{ marginTop: 3 }}><StageBadge stage={d.stage} /></div>
            </div>
            <button onClick={() => attach(d.dealId)} disabled={busy} className="btn" style={{ fontSize: 12 }}>Attach</button>
          </div>
        ))}
      </div>
      <AttachPicker gmailThreadId={gmailThreadId} counterpartyEmail={counterpartyEmail} excludeDealIds={suggested.map(d => d.dealId)} label="Or pick a different deal" alwaysOpen />
    </Wrap>
  );
}

function UnlinkedView({ gmailThreadId, counterpartyEmail }) {
  return (
    <Wrap>
      <Label>Not in any deal yet</Label>
      <Muted style={{ margin: '4px 0 12px' }}>
        {counterpartyEmail
          ? <>No match for <strong style={{ color: BRAND.ink }}>{counterpartyEmail}</strong>. Attach this conversation to a deal or create one.</>
          : 'Attach this conversation to a deal or create one.'}
      </Muted>
      <AttachPicker gmailThreadId={gmailThreadId} counterpartyEmail={counterpartyEmail} label="Add to deal" alwaysOpen />
    </Wrap>
  );
}

// ---- Deal detail (when linked) ----

function DealDetailBlock({ detail, gmailThreadId, onOpenDeal, onOpenProposal }) {
  const { state, actions } = useStore();
  const [editingTask, setEditingTask] = useState(null);
  const openTasks = (detail.tasks || []).filter(t => !t.doneAt).slice(0, 3);

  // Quick deal summary that tracks reality: a signed proposal's total is the
  // actual sale value (incl. extras) and wins, so the figure — and the "Signed"
  // marker — update the moment the client signs. Otherwise fall back to a manual
  // deal value, then the latest proposed value. Mirrors the deal page's logic.
  const allProposals = detail.proposals || [];
  const newestProposal = (list) => list.reduce((best, p) => (best && (best.number || 0) >= (p.number || 0) ? best : p), null);
  const valueInfo = useMemo(() => {
    const priced = allProposals.filter(p => (p.totalExVat ?? p.basePrice) != null);
    const signed = newestProposal(priced.filter(p => p.signed));
    if (signed) return { value: signed.totalExVat ?? signed.basePrice, signed: true };
    if (detail.value != null) return { value: detail.value, signed: false };
    const latest = newestProposal(priced);
    if (latest) return { value: latest.totalExVat ?? latest.basePrice, signed: false };
    return { value: null, signed: false };
  }, [allProposals, detail.value]);
  // The proposal the "View proposal" button opens: the signed one if there is
  // one (newest), else the newest proposal overall.
  const viewProposal = useMemo(
    () => newestProposal(allProposals.filter(p => p.signed)) || newestProposal(allProposals),
    [allProposals],
  );
  const timeline = useMemo(() => {
    const events = (detail.events || []).map(e => ({ kind: 'event', when: e.occurredAt, data: e }));
    const emails = (detail.emails || []).map(em => ({ kind: 'email', when: em.sentAt, data: em }));
    return [...events, ...emails].sort((a, b) => new Date(b.when) - new Date(a.when)).slice(0, 5);
  }, [detail]);

  // Cc'd addresses on inbound messages of the currently-viewed thread that
  // aren't already a contact on this deal — drives the "New on this thread"
  // add-as-contact prompt. Mirrors the Chrome extension's sidebar.
  const unknownCcs = useMemo(() => {
    const linked = new Set();
    if (detail.primaryContact?.email) linked.add(detail.primaryContact.email.toLowerCase());
    for (const sc of (detail.secondaryContacts || [])) {
      if (sc.email) linked.add(sc.email.toLowerCase());
    }
    // Our own team is never a "new contact" to add to a deal. Exclude CRM users,
    // the signed-in user and the connected mailbox, plus anyone on our own email
    // domain — that catches team members and internal aliases (enquiries@, etc.)
    // that don't have a CRM account.
    const internal = new Set();
    for (const u of Object.values(state.users || {})) if (u?.email) internal.add(u.email.toLowerCase());
    if (state.session?.email) internal.add(state.session.email.toLowerCase());
    if (state.gmailAccount?.gmailAddress) internal.add(state.gmailAccount.gmailAddress.toLowerCase());
    const sessionEmail = (state.session?.email || '').toLowerCase();
    const at = sessionEmail.lastIndexOf('@');
    const ownDomain = at >= 0 ? sessionEmail.slice(at + 1) : null;
    const seen = new Set();
    const out = [];
    for (const em of (detail.emails || [])) {
      if (gmailThreadId && em.gmailThreadId !== gmailThreadId) continue;
      if (em.direction !== 'inbound') continue;
      for (const raw of (em.ccEmails || [])) {
        if (!raw || typeof raw !== 'string') continue;
        const lower = raw.trim().toLowerCase();
        if (!lower || seen.has(lower) || linked.has(lower) || internal.has(lower)) continue;
        if (ownDomain && lower.endsWith('@' + ownDomain)) continue;
        seen.add(lower);
        out.push(raw.trim());
      }
    }
    return out;
  }, [detail, gmailThreadId, state.users, state.session, state.gmailAccount]);

  return (
    <>
      <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 12, marginBottom: 14 }}>
        <Row><DealMetaKey>Stage</DealMetaKey><StageDropdown dealId={detail.id} stage={detail.stage} /></Row>
        <ValueRow dealId={detail.id} valueInfo={valueInfo} />
        {detail.ownerEmail && (
          <Row>
            <DealMetaKey>Owner</DealMetaKey>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <Avatar email={detail.ownerEmail} size={20} />
              <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={detail.ownerEmail}>
                {state.users?.[detail.ownerEmail]?.name || detail.ownerEmail}
              </span>
            </span>
          </Row>
        )}
        {detail.primaryContact && (
          <Row>
            <DealMetaKey>Contact</DealMetaKey>
            <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 0, maxWidth: 180 }}>
              <span style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }} title={detail.primaryContact.name || detail.primaryContact.email}>
                {detail.primaryContact.name || detail.primaryContact.email}
              </span>
              {detail.primaryContact.name && detail.primaryContact.email && (
                <a href={`mailto:${detail.primaryContact.email}`} style={{ fontSize: 11, color: BRAND.blue, textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }} title={detail.primaryContact.email}>
                  {detail.primaryContact.email}
                </a>
              )}
            </span>
          </Row>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          <button onClick={() => onOpenDeal?.(detail.id)} className="btn" style={{ fontSize: 12 }}>
            Open deal <ExternalLink size={13} />
          </button>
          {viewProposal && (
            <button onClick={() => onOpenProposal?.(viewProposal.id, viewProposal.signed)} className="btn-ghost" style={{ fontSize: 12 }}>
              <FileText size={13} /> View proposal
            </button>
          )}
        </div>
      </div>

      {detail.leadSource && <LeadSourceMini src={detail.leadSource} />}

      {unknownCcs.length > 0 && (
        <CcSuggestions dealId={detail.id} addresses={unknownCcs} defaultCompanyId={detail.companyId || null} />
      )}

      <Label>Open tasks</Label>
      <div style={{ margin: '6px 0 6px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {openTasks.length === 0 ? <Muted>No open tasks.</Muted> : openTasks.map(t => (
          <div key={t.id} style={{ display: 'flex', gap: 6, fontSize: 12.5 }}>
            <button
              onClick={() => actions.toggleTask(t.id)}
              title="Mark done"
              aria-label="Mark done"
              style={{ flexShrink: 0, width: 14, height: 14, marginTop: 1, padding: 0, border: '1.5px solid ' + BRAND.muted, borderRadius: 3, background: 'white', cursor: 'pointer' }}
            />
            <button
              onClick={() => setEditingTask(t)}
              title="Edit task — change the due date to postpone"
              style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: BRAND.ink }}
            >
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
              {t.dueAt && <div style={{ fontSize: 11, color: BRAND.muted }}>Due {new Date(t.dueAt).toLocaleDateString('en-GB')}</div>}
            </button>
          </div>
        ))}
      </div>
      <div style={{ marginBottom: 14 }}>
        <AddTaskForm dealId={detail.id} />
      </div>

      {editingTask && (
        <TaskFormModal
          task={editingTask}
          defaults={{ dealId: detail.id }}
          onClose={() => setEditingTask(null)}
          onSaved={() => setEditingTask(null)}
        />
      )}

      {timeline.length > 0 && (
        <>
          <Label>Recent activity</Label>
          <div style={{ margin: '6px 0 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {timeline.map((item, i) => item.kind === 'email'
              ? <TimelineEmail key={'em' + i} email={item.data} />
              : <TimelineEvent key={'ev' + i} event={item.data} />)}
          </div>
        </>
      )}
    </>
  );
}

// Inline "+ Add task" — the in-app twin of the extension's quick task form.
// createTask threads the new row into state.dealDetail[dealId].tasks, so the
// open-tasks list above refreshes without a manual reload.
function AddTaskForm({ dealId }) {
  const { actions, showMsg } = useStore();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await actions.createTask({ dealId, title: title.trim(), dueAt: dueAt ? new Date(dueAt).toISOString() : undefined });
      setTitle(''); setDueAt(''); setOpen(false);
    } catch (err) {
      showMsg(err?.message || 'Could not add task');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <button onClick={() => setOpen(true)} className="btn-ghost" style={{ fontSize: 12 }}>+ Add task</button>;
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input autoFocus className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="Task title" required style={{ fontSize: 12 }} />
      <input type="date" className="input" value={dueAt} onChange={e => setDueAt(e.target.value)} style={{ fontSize: 12 }} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="submit" disabled={busy || !title.trim()} className="btn" style={{ flex: 1, fontSize: 12, justifyContent: 'center' }}>{busy ? 'Adding…' : 'Add'}</button>
        <button type="button" onClick={() => { setOpen(false); setTitle(''); setDueAt(''); }} className="btn-ghost" style={{ fontSize: 12 }}>Cancel</button>
      </div>
    </form>
  );
}

// "New on this thread" — Cc'd addresses not yet on the deal, with a one-tap
// add (and optional name). addDealContact upserts and updates secondaryContacts
// in place, so an added address drops out of this list automatically.
function CcSuggestions({ dealId, addresses, defaultCompanyId }) {
  const { actions, showMsg } = useStore();
  const [expanded, setExpanded] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(null);

  const add = async (email, withName = null) => {
    setBusy(email);
    try {
      await actions.addDealContact(dealId, { email, name: withName || null, companyId: defaultCompanyId || null });
      setExpanded(null); setName('');
    } catch (e) {
      showMsg(e?.message || 'Could not add contact');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Label>New on this thread</Label>
      <Muted style={{ margin: '4px 0 8px' }}>Cc'd in a reply but not yet a contact on this deal.</Muted>
      <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {addresses.map((email) => {
          const isOpen = expanded === email;
          if (!isOpen) {
            return (
              <div key={email} style={ccRow}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</span>
                <button onClick={() => setExpanded(email)} disabled={busy === email} className="btn" style={{ fontSize: 11, padding: '3px 8px' }} title="Add as a contact on this deal">+ Add</button>
              </div>
            );
          }
          return (
            <div key={email} style={{ ...ccRow, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{email}</div>
              <input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" style={{ fontSize: 12 }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => add(email, name.trim() || null)} disabled={busy === email} className="btn" style={{ flex: 1, fontSize: 12, justifyContent: 'center' }}>{busy === email ? 'Adding…' : 'Add to deal'}</button>
                <button onClick={() => { setExpanded(null); setName(''); }} disabled={busy === email} className="btn-ghost" style={{ fontSize: 12 }}>Cancel</button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function TimelineEvent({ event }) {
  return (
    <div style={{ fontSize: 12, color: BRAND.ink }}>
      <span style={{ display: 'inline-block', width: 4, height: 4, borderRadius: '50%', background: BRAND.blue, marginRight: 6, verticalAlign: 'middle' }} />
      {describeEvent(event)}
      <span style={{ color: BRAND.muted, fontSize: 11 }}> · {timeAgo(event.occurredAt)}</span>
    </div>
  );
}

function TimelineEmail({ email }) {
  const inbound = email.direction === 'inbound';
  return (
    <div style={{ fontSize: 12 }}>
      <span style={{ display: 'inline-block', padding: '0 4px', borderRadius: 3, background: (inbound ? '#16A34A' : '#2BB8E6') + '22', color: inbound ? '#16A34A' : '#2BB8E6', fontSize: 9, fontWeight: 700, marginRight: 6, verticalAlign: 'middle' }}>{inbound ? 'IN' : 'OUT'}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: 180, verticalAlign: 'middle' }}>{email.subject || '(no subject)'}</span>
      <span style={{ color: BRAND.muted, fontSize: 11 }}> · {timeAgo(email.sentAt)}</span>
    </div>
  );
}

// ---- Actions ----

function AttachPicker({ gmailThreadId, counterpartyEmail, excludeDealIds = [], label, collapsedLabel, alwaysOpen = false, allowCreate = true }) {
  const { state, actions, showMsg } = useStore();
  const [open, setOpen] = useState(alwaysOpen);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const q = query.trim();
  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    const exclude = new Set(excludeDealIds);
    return Object.values(state.deals || {})
      .filter(d => d && !exclude.has(d.id) && d.stage !== 'lost')
      .filter(d => !needle || (d.title || '').toLowerCase().includes(needle))
      .sort((a, b) => new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0))
      .slice(0, 8);
  }, [state.deals, q, excludeDealIds]);

  // Offer "create" when there's something typed and no deal already has that
  // exact title — so you can spin up a new deal named after what you typed,
  // rather than via a separate button.
  const exactExists = useMemo(
    () => !!q && Object.values(state.deals || {}).some(d => d && (d.title || '').toLowerCase() === q.toLowerCase()),
    [state.deals, q]
  );
  const canCreate = allowCreate && !!q && !exactExists;

  const attach = async (dealId) => {
    setBusy(true);
    try { await actions.attachThreadToDeal({ gmailThreadId, counterpartyEmail, dealId }); showMsg('Attached to deal'); }
    finally { setBusy(false); }
  };

  const createAndAttach = async () => {
    if (!q) return;
    setBusy(true);
    try {
      const deal = await actions.createDeal({ title: q });
      if (deal?.id) await actions.attachThreadToDeal({ gmailThreadId, counterpartyEmail, dealId: deal.id });
      showMsg('Deal created');
      setQuery('');
    } catch (e) { showMsg(e?.message || 'Could not create deal'); }
    finally { setBusy(false); }
  };

  if (!open) {
    return <button onClick={() => setOpen(true)} className="btn-ghost" style={{ fontSize: 12 }}>{collapsedLabel || label}</button>;
  }

  return (
    <div>
      <Label>{label}</Label>
      <div style={{ position: 'relative', margin: '6px 0' }}>
        <Search size={13} color={BRAND.muted} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }} />
        <input
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) { e.preventDefault(); createAndAttach(); } }}
          placeholder={allowCreate ? 'Search or type a new deal name…' : 'Search deals…'}
          style={{ paddingLeft: 30, fontSize: 12 }}
        />
      </div>
      {filtered.map(d => (
        <button key={d.id} onClick={() => attach(d.id)} disabled={busy} style={pickerRow}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
          <StageBadge stage={d.stage} compact />
        </button>
      ))}
      {filtered.length === 0 && !canCreate && <Muted>{q ? 'No matching deals.' : 'No deals yet.'}</Muted>}
      {canCreate && (
        <button onClick={createAndAttach} disabled={busy} style={createRow} title="Create a new deal with this name and attach the thread">
          <Plus size={13} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {busy ? 'Creating…' : <>Create new deal “<strong>{q}</strong>”</>}
          </span>
        </button>
      )}
    </div>
  );
}

// ---- Lead source (marketing attribution) ----

export const CHANNEL_BADGE = {
  paid_search: { label: 'Paid search', bg: '#E0F2FE', fg: '#0369A1' },
  social:      { label: 'Social',      bg: '#F3E8FF', fg: '#7C3AED' },
  organic:     { label: 'Organic',     bg: '#DCFCE7', fg: '#166534' },
  referral:    { label: 'Referral',    bg: '#FEF3C7', fg: '#92400E' },
  direct:      { label: 'Direct',      bg: '#F1F5F9', fg: '#475569' },
};
export const channelBadge = (c) => CHANNEL_BADGE[c] || { label: c || 'Unknown', bg: '#F1F5F9', fg: '#475569' };

function LeadSourceMini({ src }) {
  const ch = channelBadge(src.channel);
  const rows = [
    ['Campaign', src.campaign],
    ['Keyword', src.keyword],
    ['Source', src.source && src.medium ? `${src.source} / ${src.medium}` : (src.source || src.medium)],
  ].filter(([, v]) => v);
  return (
    <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 12, marginBottom: 14 }}>
      <Label>Lead source</Label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', margin: '6px 0 8px' }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.3, padding: '2px 8px', borderRadius: 999, background: ch.bg, color: ch.fg }}>
          {ch.label}
        </span>
        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: '2px 6px', borderRadius: 999, background: src.returningClient ? '#FEF3C7' : '#ECFDF5', color: src.returningClient ? '#92400E' : '#166534' }}>
          {src.returningClient ? 'Returning client' : 'New'}
        </span>
      </div>
      {rows.map(([k, v]) => (
        <Row key={k}>
          <DealMetaKey>{k}</DealMetaKey>
          <span style={{ fontSize: 12, textAlign: 'right', maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v}>{v}</span>
        </Row>
      ))}
    </div>
  );
}

// ---- Building blocks ----

export function DealChip({ title, stage, onRemove, disabled }) {
  const c = STAGE_COLOURS[stage] || STAGE_COLOURS.lead;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: onRemove ? '3px 6px 3px 8px' : '3px 8px', borderRadius: 999, background: c.bg, color: c.fg, fontSize: 11, fontWeight: 600, maxWidth: 220 }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      {onRemove && (
        <button onClick={onRemove} disabled={disabled} title="Remove from deal" style={{ background: 'transparent', border: 'none', color: c.fg, cursor: 'pointer', padding: 0, lineHeight: 1, display: 'flex', opacity: 0.6 }}>
          <X size={12} />
        </button>
      )}
    </span>
  );
}

function StageBadge({ stage, compact }) {
  const c = STAGE_COLOURS[stage] || STAGE_COLOURS.lead;
  return (
    <span style={{ display: 'inline-block', padding: compact ? '1px 6px' : '2px 8px', borderRadius: 4, background: c.bg, color: c.fg, fontSize: compact ? 10 : 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>
      {STAGE_LABEL[stage] || stage}
    </span>
  );
}

// Editable deal value. A signed proposal is the authoritative figure, so it's
// shown read-only with a SIGNED badge; otherwise the manual deal value can be
// edited inline (and an unsigned proposal's value still flows through via the
// caller's valueInfo precedence). Saves to the deal's `value` field.
function ValueRow({ dealId, valueInfo }) {
  const { actions, showMsg } = useStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const savingRef = useRef(false);

  const start = () => {
    setDraft(valueInfo.value != null ? String(valueInfo.value) : '');
    setEditing(true);
  };

  const commit = async (persist) => {
    if (savingRef.current) return;
    if (!persist) { setEditing(false); return; }
    const raw = draft.trim().replace(/[£,\s]/g, '');
    const num = raw === '' ? null : Number(raw);
    if (raw !== '' && !Number.isFinite(num)) { showMsg('Enter a valid number'); return; }
    savingRef.current = true;
    try {
      await actions.saveDeal(dealId, { value: num });
      setEditing(false);
    } catch (e) {
      showMsg(e?.message || 'Could not save value');
    } finally {
      savingRef.current = false;
    }
  };

  if (valueInfo.signed) {
    return (
      <Row>
        <DealMetaKey>Value</DealMetaKey>
        <span style={{ fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          £{Number(valueInfo.value).toLocaleString('en-GB')}
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, color: '#16A34A' }}>SIGNED</span>
        </span>
      </Row>
    );
  }

  if (editing) {
    return (
      <Row>
        <DealMetaKey>Value</DealMetaKey>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <span style={{ fontSize: 13, color: BRAND.muted }}>£</span>
          <input
            autoFocus
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(true); } if (e.key === 'Escape') { e.preventDefault(); commit(false); } }}
            onBlur={() => commit(true)}
            inputMode="decimal"
            placeholder="0"
            style={{ width: 90, fontSize: 12, padding: '2px 6px', textAlign: 'right' }}
          />
        </span>
      </Row>
    );
  }

  return (
    <Row>
      <DealMetaKey>Value</DealMetaKey>
      <button
        onClick={start}
        title="Click to edit deal value"
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 5, color: BRAND.ink }}
      >
        {valueInfo.value != null
          ? <span style={{ fontSize: 13, fontWeight: 600 }}>£{Number(valueInfo.value).toLocaleString('en-GB')}</span>
          : <span style={{ fontSize: 12, color: BRAND.muted }}>Add value</span>}
        <Pencil size={11} style={{ opacity: 0.5 }} />
      </button>
    </Row>
  );
}

// Streak-style coloured stage marker — a small right-pointing flag in the
// stage's accent colour, used in the stage dropdown.
function StageMark({ color }) {
  return (
    <span style={{
      flexShrink: 0, width: 0, height: 0,
      borderTop: '5px solid transparent', borderBottom: '5px solid transparent',
      borderLeft: `7px solid ${color}`,
    }} />
  );
}

// Clickable stage pill that opens a Streak-like dropdown of every stage (each
// with its coloured marker), so the deal's stage can be changed straight from
// the email thread's deal panel. moveDealStage patches state.deals AND the
// cached dealDetail, so the pill + chip update instantly.
function StageDropdown({ dealId, stage }) {
  const { actions, showMsg } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const c = STAGE_COLOURS[stage] || STAGE_COLOURS.lead;
  const current = PIPELINE_STAGES.find((s) => s.id === stage);

  const choose = (next) => {
    setOpen(false);
    if (next === stage) return;
    actions.moveDealStage(dealId, next);
    showMsg(`Stage: ${STAGE_LABEL[next] || next}`);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Change stage"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 6px 2px 8px', borderRadius: 4,
          background: c.bg, color: c.fg, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4,
          border: 'none', cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <StageMark color={(current && current.color) || c.fg} />
        {STAGE_LABEL[stage] || stage}
        <ChevronDown size={12} style={{ opacity: 0.7 }} />
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 60,
            background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8,
            boxShadow: '0 8px 24px rgba(15, 42, 61, 0.14)', padding: 4, minWidth: 210,
            maxHeight: 300, overflowY: 'auto',
          }}
        >
          {PIPELINE_STAGES.map((s) => {
            const selected = s.id === stage;
            return (
              <button
                key={s.id}
                role="option"
                aria-selected={selected}
                onClick={() => choose(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 8px',
                  background: selected ? '#F1F5F9' : 'transparent', border: 'none', borderRadius: 6,
                  cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: BRAND.ink, textAlign: 'left',
                }}
                onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = '#F8FAFC'; }}
                onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
              >
                <StageMark color={s.color} />
                <span style={{ flex: 1, minWidth: 0 }}>{s.label}</span>
                {selected && <Check size={14} color={BRAND.blue} style={{ flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const Wrap = ({ children }) => <div style={{ fontSize: 13, color: BRAND.ink }}>{children}</div>;
const Label = ({ children }) => <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{children}</div>;
const Muted = ({ children, style }) => <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.4, ...(style || {}) }}>{children}</div>;
const Row = ({ children }) => <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>{children}</div>;
const DealMetaKey = ({ children }) => <span style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>{children}</span>;

const pickerRow = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', marginTop: 4, width: '100%',
  background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, fontSize: 12,
  cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', color: BRAND.ink,
};
const createRow = {
  ...pickerRow,
  background: BRAND.blue + '12', border: '1px solid ' + BRAND.blue + '55', color: BRAND.blue, fontWeight: 600,
};
const ccRow = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
  background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 6,
};
const linkBtn = {
  background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: BRAND.ink, textAlign: 'left',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%',
};

function describeEvent(e) {
  const p = e.payload || {};
  switch (e.eventType) {
    case 'deal_created':  return 'Deal created';
    case 'stage_change':  return `Stage: ${p.from} → ${p.to}`;
    case 'task_created':  return `Task: ${p.title || ''}`;
    case 'task_done':     return `Task done: ${p.title || ''}`;
    case 'email_sent':    return 'Email sent';
    case 'email_scheduled': return 'Email scheduled';
    case 'email_linked':  return 'Email linked';
    case 'revision_draft_uploaded': return `Revised video uploaded${p.draft ? ` (draft ${p.draft})` : ''}`;
    case 'revision_completed':   return `Revision complete${p.draft ? ` (draft ${p.draft})` : ''}`;
    case 'revision_reopened':    return `Revision reopened${p.draft ? ` (draft ${p.draft})` : ''}`;
    case 'revision_assigned':    return `Revisions assigned${p.assignee ? ` to ${p.assignee}` : ''}`;
    case 'storyboard_draft_uploaded': return `Revised storyboard uploaded${p.draft ? ` (draft ${p.draft})` : ''}`;
    case 'storyboard_revision_completed': return `Storyboard revision complete${p.draft ? ` (draft ${p.draft})` : ''}`;
    case 'storyboard_revision_reopened':  return `Storyboard revision reopened${p.draft ? ` (draft ${p.draft})` : ''}`;
    case 'storyboard_revision_assigned':  return `Storyboard revisions assigned${p.assignee ? ` to ${p.assignee}` : ''}`;
    default:              return e.eventType;
  }
}

function timeAgo(iso) {
  if (!iso) return '';
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString('en-GB');
}
