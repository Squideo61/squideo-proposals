import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Plus, X, Search } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { STAGE_COLOURS, PIPELINE_STAGES } from '../../lib/stages.js';

const STAGE_LABEL = Object.fromEntries(PIPELINE_STAGES.map(s => [s.id, s.label]));

// The deal-context panel shown on the right of an open conversation — the
// in-app twin of the Chrome extension's Gmail sidebar. Tells you which deal(s)
// a thread is on (or suggests/lets you attach one) and surfaces the deal's
// stage, value, owner, open tasks and recent activity.
export function DealContextPanel({ gmailThreadId, counterpartyEmail, onOpenDeal }) {
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
    return <LinkedView linked={linked} gmailThreadId={gmailThreadId} counterpartyEmail={counterpartyEmail} onOpenDeal={onOpenDeal} />;
  }
  if (suggested.length) {
    return <SuggestedView suggested={suggested} gmailThreadId={gmailThreadId} counterpartyEmail={counterpartyEmail} onOpenDeal={onOpenDeal} />;
  }
  return <UnlinkedView gmailThreadId={gmailThreadId} counterpartyEmail={counterpartyEmail} />;
}

function LinkedView({ linked, gmailThreadId, counterpartyEmail, onOpenDeal }) {
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
          <DealChip key={d.dealId} title={d.title} stage={d.stage} onRemove={() => detach(d.dealId)} disabled={busy} />
        ))}
      </div>

      {detail && <DealDetailBlock detail={detail} gmailThreadId={gmailThreadId} onOpenDeal={onOpenDeal} />}

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
      <NewDealButton gmailThreadId={gmailThreadId} counterpartyEmail={counterpartyEmail} />
      <Hr />
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
      <NewDealButton gmailThreadId={gmailThreadId} counterpartyEmail={counterpartyEmail} />
      <Hr />
      <AttachPicker gmailThreadId={gmailThreadId} counterpartyEmail={counterpartyEmail} label="Add to deal" alwaysOpen />
    </Wrap>
  );
}

// ---- Deal detail (when linked) ----

function DealDetailBlock({ detail, gmailThreadId, onOpenDeal }) {
  const openTasks = (detail.tasks || []).filter(t => !t.doneAt).slice(0, 3);
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
    const seen = new Set();
    const out = [];
    for (const em of (detail.emails || [])) {
      if (gmailThreadId && em.gmailThreadId !== gmailThreadId) continue;
      if (em.direction !== 'inbound') continue;
      for (const raw of (em.ccEmails || [])) {
        if (!raw || typeof raw !== 'string') continue;
        const lower = raw.trim().toLowerCase();
        if (!lower || seen.has(lower) || linked.has(lower)) continue;
        seen.add(lower);
        out.push(raw.trim());
      }
    }
    return out;
  }, [detail, gmailThreadId]);

  const proposals = (detail.proposals || []).slice(0, 3);

  return (
    <>
      <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 12, marginBottom: 14 }}>
        <Row><DealMetaKey>Stage</DealMetaKey><StageBadge stage={detail.stage} /></Row>
        {detail.value != null && <Row><DealMetaKey>Value</DealMetaKey><span style={{ fontSize: 13, fontWeight: 600 }}>£{Number(detail.value).toLocaleString('en-GB')}</span></Row>}
        {detail.ownerEmail && <Row><DealMetaKey>Owner</DealMetaKey><span style={{ fontSize: 12 }}>{detail.ownerEmail}</span></Row>}
        <button onClick={() => onOpenDeal?.(detail.id)} className="btn" style={{ marginTop: 10, fontSize: 12 }}>
          Open deal <ExternalLink size={13} />
        </button>
      </div>

      {unknownCcs.length > 0 && (
        <CcSuggestions dealId={detail.id} addresses={unknownCcs} defaultCompanyId={detail.companyId || null} />
      )}

      <Label>Open tasks</Label>
      <div style={{ margin: '6px 0 6px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {openTasks.length === 0 ? <Muted>No open tasks.</Muted> : openTasks.map(t => (
          <div key={t.id} style={{ display: 'flex', gap: 6, fontSize: 12.5 }}>
            <span style={{ flexShrink: 0, width: 12, height: 12, marginTop: 2, border: '1.5px solid ' + BRAND.muted, borderRadius: 3 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
              {t.dueAt && <div style={{ fontSize: 11, color: BRAND.muted }}>Due {new Date(t.dueAt).toLocaleDateString('en-GB')}</div>}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginBottom: 14 }}>
        <AddTaskForm dealId={detail.id} />
      </div>

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

      {proposals.length > 0 && (
        <>
          <Label>Linked proposals</Label>
          <div style={{ margin: '6px 0 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {proposals.map(p => (
              <div key={p.id} style={{ fontSize: 12 }}>
                {p.contactBusinessName || p.clientName || '(untitled)'}
                {p.basePrice != null && <span style={{ color: BRAND.muted }}> — £{Number(p.basePrice).toLocaleString('en-GB')}</span>}
              </div>
            ))}
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

function NewDealButton({ gmailThreadId, counterpartyEmail }) {
  const { actions, showMsg } = useStore();
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      let title = 'New deal';
      if (counterpartyEmail) {
        const local = counterpartyEmail.split('@')[0].replace(/[._-]+/g, ' ');
        title = local.charAt(0).toUpperCase() + local.slice(1);
      }
      const deal = await actions.createDeal({ title });
      if (deal?.id) await actions.attachThreadToDeal({ gmailThreadId, counterpartyEmail, dealId: deal.id });
      showMsg('Deal created');
    } catch (e) { showMsg(e?.message || 'Could not create deal'); }
    finally { setBusy(false); }
  };
  return (
    <button onClick={create} disabled={busy} className="btn" style={{ width: '100%', justifyContent: 'center' }}>
      <Plus size={14} /> {busy ? 'Creating…' : 'New deal from this thread'}
    </button>
  );
}

function AttachPicker({ gmailThreadId, counterpartyEmail, excludeDealIds = [], label, collapsedLabel, alwaysOpen = false }) {
  const { state, actions, showMsg } = useStore();
  const [open, setOpen] = useState(alwaysOpen);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const exclude = new Set(excludeDealIds);
    return Object.values(state.deals || {})
      .filter(d => d && !exclude.has(d.id) && d.stage !== 'lost')
      .filter(d => !q || (d.title || '').toLowerCase().includes(q))
      .sort((a, b) => new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0))
      .slice(0, 8);
  }, [state.deals, query, excludeDealIds]);

  const attach = async (dealId) => {
    setBusy(true);
    try { await actions.attachThreadToDeal({ gmailThreadId, counterpartyEmail, dealId }); showMsg('Attached to deal'); }
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
        <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search deals…" style={{ paddingLeft: 30, fontSize: 12 }} />
      </div>
      {filtered.length === 0 ? <Muted>No matching deals.</Muted> : filtered.map(d => (
        <button key={d.id} onClick={() => attach(d.id)} disabled={busy} style={pickerRow}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
          <StageBadge stage={d.stage} compact />
        </button>
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

const Wrap = ({ children }) => <div style={{ fontSize: 13, color: BRAND.ink }}>{children}</div>;
const Label = ({ children }) => <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{children}</div>;
const Muted = ({ children, style }) => <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.4, ...(style || {}) }}>{children}</div>;
const Row = ({ children }) => <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>{children}</div>;
const DealMetaKey = ({ children }) => <span style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>{children}</span>;
const Hr = () => <div style={{ borderTop: '1px solid ' + BRAND.border, margin: '12px 0' }} />;

const pickerRow = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', marginTop: 4, width: '100%',
  background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, fontSize: 12,
  cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', color: BRAND.ink,
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
