import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';

// Brand palette mirrored from src/theme.js so the in-Gmail sidebar feels
// like the web app. Kept inline (not imported) to avoid pulling the whole
// theme module into the content bundle.
const BRAND = {
  blue:   '#2BB8E6',
  ink:    '#0F2A3D',
  paper:  '#FAFBFC',
  border: '#E5E9EE',
  muted:  '#6B7785',
};
const STAGE_COLOURS = {
  lead:     { bg: '#F1F5F9', fg: '#475569' },
  qualified:{ bg: '#FEF3C7', fg: '#92400E' },
  quoting:  { bg: '#DBEAFE', fg: '#1E40AF' },
  sent:     { bg: '#E0F2FE', fg: '#075985' },
  viewed:   { bg: '#CFFAFE', fg: '#0E7490' },
  signed:   { bg: '#DCFCE7', fg: '#166534' },
  paid:     { bg: '#D1FAE5', fg: '#065F46' },
  lost:     { bg: '#FEE2E2', fg: '#991B1B' },
};

export function Sidebar({ gmailThreadId, counterpartyEmail }) {
  const [state, setState] = useState({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    loadInitial({ gmailThreadId, counterpartyEmail })
      .then(next => { if (!cancelled) setState(next); })
      .catch(err => { if (!cancelled) setState({ phase: 'error', message: err?.message || 'Failed to load' }); });
    return () => { cancelled = true; };
  }, [gmailThreadId, counterpartyEmail]);

  if (state.phase === 'loading') return <Box><Muted>Loading…</Muted></Box>;
  if (state.phase === 'error') return <Box><Err msg={state.message} /></Box>;

  // Reload helper passed to action handlers so the sidebar re-fetches itself
  // after attach/detach/create operations.
  const reload = () => {
    setState({ phase: 'loading' });
    loadInitial({ gmailThreadId, counterpartyEmail })
      .then(setState)
      .catch(err => setState({ phase: 'error', message: err?.message || 'Failed' }));
  };

  if (state.phase === 'linked') {
    return (
      <LinkedView
        deals={state.deals}
        gmailThreadId={gmailThreadId}
        counterpartyEmail={counterpartyEmail}
        onChanged={reload}
      />
    );
  }
  if (state.phase === 'suggested') {
    return (
      <SuggestedView
        suggestions={state.suggestions}
        gmailThreadId={gmailThreadId}
        counterpartyEmail={counterpartyEmail}
        onChanged={reload}
      />
    );
  }
  return (
    <UnlinkedView
      gmailThreadId={gmailThreadId}
      counterpartyEmail={counterpartyEmail}
      onChanged={reload}
    />
  );
}

// -------------------- Data loading --------------------

async function loadInitial({ gmailThreadId, counterpartyEmail }) {
  // 1. Is this thread already linked to one or more deals?
  const linkResp = await api.get('/api/crm/threads/by-thread-ids?ids=' + encodeURIComponent(gmailThreadId));
  const links = Array.isArray(linkResp[gmailThreadId]) ? linkResp[gmailThreadId] : [];

  if (links.length) {
    // Fetch full detail for the first linked deal so we can show timeline +
    // tasks + value etc. The "primary" deal is just the first one returned;
    // additional links render as chips at the top.
    const detail = await api.get('/api/crm/deals/' + encodeURIComponent(links[0].dealId));
    return { phase: 'linked', deals: links, primary: detail };
  }

  // 2. Not linked yet — see if the sender's email matches any deal we know about.
  if (counterpartyEmail) {
    const suggestions = await api.get('/api/crm/threads/by-contact?email=' + encodeURIComponent(counterpartyEmail));
    if (Array.isArray(suggestions) && suggestions.length) {
      return { phase: 'suggested', suggestions };
    }
  }

  // 3. Nothing matches — show the picker.
  return { phase: 'unlinked' };
}

// -------------------- States --------------------

function LinkedView({ deals, gmailThreadId, counterpartyEmail, onChanged }) {
  // Re-fetch primary deal detail whenever the linked deal set changes.
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const primaryDealId = deals[0]?.dealId;

  useEffect(() => {
    if (!primaryDealId) return;
    let cancelled = false;
    api.get('/api/crm/deals/' + encodeURIComponent(primaryDealId))
      .then(d => { if (!cancelled) setDetail(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [primaryDealId]);

  const detach = async (dealId) => {
    if (!confirm('Remove this thread from the deal?')) return;
    setBusy(true);
    try {
      await api.delete('/api/crm/threads/' + encodeURIComponent(gmailThreadId) + '?dealId=' + encodeURIComponent(dealId));
      onChanged();
    } finally { setBusy(false); }
  };

  return (
    <Box>
      <Section>
        <Label>This thread is on</Label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {deals.map(d => (
            <DealChip key={d.dealId} title={d.title} stage={d.stage} onRemove={() => detach(d.dealId)} disabled={busy} />
          ))}
        </div>
      </Section>

      {detail && <DealDetail detail={detail} gmailThreadId={gmailThreadId} />}

      <AddAnotherDeal
        gmailThreadId={gmailThreadId}
        counterpartyEmail={counterpartyEmail}
        excludeDealIds={deals.map(d => d.dealId)}
        onAttached={onChanged}
      />
    </Box>
  );
}

function SuggestedView({ suggestions, gmailThreadId, counterpartyEmail, onChanged }) {
  const [busy, setBusy] = useState(false);

  const attach = async (dealId) => {
    setBusy(true);
    try {
      await api.post('/api/crm/threads', buildSnapshot({ gmailThreadId, counterpartyEmail, dealId }));
      onChanged();
    } finally { setBusy(false); }
  };

  return (
    <Box>
      <Section>
        <Label>{suggestions.length === 1 ? 'Looks like this is about' : 'Possibly related'}</Label>
        <div style={{ marginTop: 8 }}>
          {suggestions.map(d => (
            <SuggestionRow key={d.id} deal={d} onAttach={() => attach(d.id)} disabled={busy} />
          ))}
        </div>
      </Section>

      <NewDealButton
        gmailThreadId={gmailThreadId}
        counterpartyEmail={counterpartyEmail}
        onCreated={onChanged}
      />
      <Hr />
      <DealPicker
        gmailThreadId={gmailThreadId}
        counterpartyEmail={counterpartyEmail}
        onAttached={onChanged}
        excludeDealIds={suggestions.map(d => d.id)}
        label="Or pick a different deal"
      />
    </Box>
  );
}

function UnlinkedView({ gmailThreadId, counterpartyEmail, onChanged }) {
  return (
    <Box>
      <Section>
        <Label>Not in any deal yet</Label>
        <Muted style={{ marginTop: 4 }}>
          {counterpartyEmail
            ? <>No match for <strong>{counterpartyEmail}</strong>. Attach this thread to a deal or create a new one.</>
            : 'Attach this thread to a deal or create a new one.'}
        </Muted>
      </Section>

      <NewDealButton
        gmailThreadId={gmailThreadId}
        counterpartyEmail={counterpartyEmail}
        onCreated={onChanged}
      />
      <Hr />
      <DealPicker
        gmailThreadId={gmailThreadId}
        counterpartyEmail={counterpartyEmail}
        onAttached={onChanged}
      />
    </Box>
  );
}

// -------------------- Deal detail panel (when linked) --------------------

function DealDetail({ detail, gmailThreadId }) {
  // Recent activity = last 5 items from events + emails merged.
  const timeline = useMemo(() => {
    const events = (detail.events || []).map(e => ({ kind: 'event', when: e.occurredAt, data: e }));
    const emails = (detail.emails || []).map(em => ({ kind: 'email', when: em.sentAt, data: em }));
    return [...events, ...emails]
      .sort((a, b) => new Date(b.when) - new Date(a.when))
      .slice(0, 5);
  }, [detail]);

  const openTasks = (detail.tasks || []).filter(t => !t.doneAt).slice(0, 3);

  return (
    <>
      <Section>
        <Row>
          <span style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>Stage</span>
          <StageBadge stage={detail.stage} />
        </Row>
        {detail.value != null && (
          <Row>
            <span style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>Value</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>£{Number(detail.value).toLocaleString('en-GB')}</span>
          </Row>
        )}
        {detail.ownerEmail && (
          <Row>
            <span style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>Owner</span>
            <span style={{ fontSize: 12 }}>{detail.ownerEmail}</span>
          </Row>
        )}
        <a
          href={`https://squideo-proposals-tu96.vercel.app/?deal=${encodeURIComponent(detail.id)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-block', marginTop: 10,
            background: BRAND.blue, color: 'white',
            padding: '6px 12px', borderRadius: 6,
            fontSize: 12, fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Open in Squideo →
        </a>
      </Section>

      {openTasks.length > 0 && (
        <Section>
          <Label>Open tasks</Label>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {openTasks.map(t => <TaskRow key={t.id} task={t} />)}
          </div>
        </Section>
      )}

      {timeline.length > 0 && (
        <Section>
          <Label>Recent activity</Label>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {timeline.map((item, i) => item.kind === 'email'
              ? <TimelineEmail key={'em' + i} email={item.data} />
              : <TimelineEvent key={'ev' + i} event={item.data} />
            )}
          </div>
        </Section>
      )}

      {(detail.proposals || []).length > 0 && (
        <Section>
          <Label>Linked proposals</Label>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {detail.proposals.slice(0, 3).map(p => (
              <div key={p.id} style={{ fontSize: 12 }}>
                {p.contactBusinessName || p.clientName || '(untitled)'}
                {p.basePrice != null && <span style={{ color: BRAND.muted }}> — £{Number(p.basePrice).toLocaleString('en-GB')}</span>}
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function TaskRow({ task }) {
  return (
    <div style={{ display: 'flex', gap: 6, fontSize: 12 }}>
      <input type="checkbox" disabled checked={false} style={{ marginTop: 2, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
        {task.dueAt && <div style={{ fontSize: 11, color: BRAND.muted }}>Due {new Date(task.dueAt).toLocaleDateString('en-GB')}</div>}
      </div>
    </div>
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
      <span style={{
        display: 'inline-block', width: 12, height: 12, borderRadius: 3,
        background: (inbound ? '#16A34A' : '#2BB8E6') + '22',
        color: inbound ? '#16A34A' : '#2BB8E6',
        fontSize: 9, fontWeight: 700, textAlign: 'center', lineHeight: '12px',
        marginRight: 6, verticalAlign: 'middle',
      }}>{inbound ? '↓' : '↑'}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: 200, verticalAlign: 'middle' }}>
        {email.subject || '(no subject)'}
      </span>
      <span style={{ color: BRAND.muted, fontSize: 11 }}> · {timeAgo(email.sentAt)}</span>
    </div>
  );
}

// -------------------- Action UI --------------------

function NewDealButton({ gmailThreadId, counterpartyEmail, onCreated }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const create = async () => {
    setBusy(true);
    setErr('');
    try {
      // Default deal title to the counterparty email's local-part capitalised.
      let title = 'New deal';
      if (counterpartyEmail) {
        const local = counterpartyEmail.split('@')[0].replace(/[._-]+/g, ' ');
        title = local.charAt(0).toUpperCase() + local.slice(1);
      }
      const deal = await api.post('/api/crm/deals', { title });
      await api.post('/api/crm/threads', buildSnapshot({ gmailThreadId, counterpartyEmail, dealId: deal.id }));
      onCreated();
    } catch (e) {
      setErr(e.message || 'Could not create deal');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section>
      <button onClick={create} disabled={busy} style={primaryBtn}>
        {busy ? 'Creating…' : '+ New deal from this thread'}
      </button>
      {err && <Err msg={err} />}
    </Section>
  );
}

function AddAnotherDeal({ gmailThreadId, counterpartyEmail, excludeDealIds, onAttached }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Section>
        <button onClick={() => setOpen(true)} style={ghostBtn}>+ Add to another deal</button>
      </Section>
    );
  }
  return (
    <DealPicker
      gmailThreadId={gmailThreadId}
      counterpartyEmail={counterpartyEmail}
      excludeDealIds={excludeDealIds}
      onAttached={() => { setOpen(false); onAttached(); }}
      label="Add to another deal"
    />
  );
}

function DealPicker({ gmailThreadId, counterpartyEmail, excludeDealIds = [], onAttached, label = 'Add to deal' }) {
  const [deals, setDeals] = useState(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get('/api/crm/deals')
      .then(rows => { if (!cancelled) setDeals(Array.isArray(rows) ? rows : []); })
      .catch(e => { if (!cancelled) setErr(e.message || 'Failed to load deals'); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!deals) return [];
    const q = query.trim().toLowerCase();
    const exclude = new Set(excludeDealIds);
    return deals
      .filter(d => !exclude.has(d.id) && d.stage !== 'lost')
      .filter(d => !q || (d.title || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [deals, query, excludeDealIds]);

  const attach = async (dealId) => {
    setBusy(true);
    setErr('');
    try {
      await api.post('/api/crm/threads', buildSnapshot({ gmailThreadId, counterpartyEmail, dealId }));
      onAttached();
    } catch (e) {
      setErr(e.message || 'Attach failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section>
      <Label>{label}</Label>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search deals…"
        style={input}
      />
      {!deals && <Muted>Loading deals…</Muted>}
      {deals && filtered.length === 0 && <Muted>No matching deals.</Muted>}
      {filtered.map(d => (
        <button
          key={d.id}
          onClick={() => attach(d.id)}
          disabled={busy}
          style={pickerRow}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
          <StageBadge stage={d.stage} compact />
        </button>
      ))}
      {err && <Err msg={err} />}
    </Section>
  );
}

function SuggestionRow({ deal, onAttach, disabled }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid ' + BRAND.border }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{deal.title}</div>
        <div style={{ marginTop: 2 }}><StageBadge stage={deal.stage} compact /></div>
      </div>
      <button onClick={onAttach} disabled={disabled} style={primaryBtn}>Attach</button>
    </div>
  );
}

// -------------------- Building blocks --------------------

function DealChip({ title, stage, onRemove, disabled }) {
  const c = STAGE_COLOURS[stage] || STAGE_COLOURS.lead;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 6px 3px 8px', borderRadius: 999,
      background: c.bg, color: c.fg,
      fontSize: 11, fontWeight: 600, maxWidth: 200,
    }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      <button
        onClick={onRemove}
        disabled={disabled}
        title="Remove from deal"
        style={{
          background: 'transparent', border: 'none', color: c.fg,
          cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1,
          marginLeft: 2, opacity: 0.6,
        }}
      >×</button>
    </span>
  );
}

function StageBadge({ stage, compact }) {
  const c = STAGE_COLOURS[stage] || STAGE_COLOURS.lead;
  return (
    <span style={{
      display: 'inline-block', padding: compact ? '1px 6px' : '2px 8px',
      borderRadius: 4, background: c.bg, color: c.fg,
      fontSize: compact ? 10 : 11, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: 0.4,
    }}>{stage}</span>
  );
}

const Box = ({ children }) => (
  <div style={{
    fontFamily: '-apple-system, system-ui, sans-serif',
    color: BRAND.ink,
    fontSize: 13,
    padding: 12,
  }}>{children}</div>
);

const Section = ({ children }) => (
  <div style={{ marginBottom: 14 }}>{children}</div>
);

const Row = ({ children }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>{children}</div>
);

const Label = ({ children }) => (
  <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{children}</div>
);

const Muted = ({ children, style }) => (
  <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.4, ...(style || {}) }}>{children}</div>
);

const Hr = () => <div style={{ borderTop: '1px solid ' + BRAND.border, margin: '12px 0' }} />;

const Err = ({ msg }) => (
  <div style={{ marginTop: 8, background: '#FEE2E2', color: '#991B1B', fontSize: 12, padding: '6px 8px', borderRadius: 6 }}>{msg}</div>
);

const primaryBtn = {
  background: BRAND.blue, color: 'white', border: 'none',
  padding: '6px 12px', borderRadius: 6, fontSize: 12,
  fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
};

const ghostBtn = {
  background: 'white', color: BRAND.ink,
  border: '1px solid ' + BRAND.border,
  padding: '6px 12px', borderRadius: 6, fontSize: 12,
  cursor: 'pointer', fontFamily: 'inherit',
};

const input = {
  width: '100%', padding: '6px 8px', marginTop: 6,
  border: '1px solid ' + BRAND.border, borderRadius: 6,
  fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box',
};

const pickerRow = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '6px 8px', marginTop: 4, width: '100%',
  background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6,
  fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
  textAlign: 'left', color: BRAND.ink,
};

// -------------------- Snapshot / event helpers --------------------

function buildSnapshot({ gmailThreadId, counterpartyEmail, dealId }) {
  // Minimal snapshot — server's auto-link resolver fills the rest from
  // whatever was already ingested via Pub/Sub. Crucially we send a
  // gmailMessageId derived from the thread id so the row is unique.
  return {
    gmailThreadId,
    gmailMessageId: gmailThreadId + ':extension-stub',
    dealId,
    fromEmail: counterpartyEmail || null,
    direction: 'inbound',
    subject: null,
    snippet: null,
    sentAt: new Date().toISOString(),
  };
}

function describeEvent(e) {
  const p = e.payload || {};
  switch (e.eventType) {
    case 'deal_created':  return 'Deal created';
    case 'stage_change':  return `Stage: ${p.from} → ${p.to}`;
    case 'task_created':  return `Task: ${p.title || ''}`;
    case 'task_done':     return `Task done: ${p.title || ''}`;
    case 'task_reopened': return `Task reopened: ${p.title || ''}`;
    case 'email_sent':    return `Email sent`;
    default:              return e.eventType;
  }
}

function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString('en-GB');
}
