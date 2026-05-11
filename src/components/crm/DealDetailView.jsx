import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Building2, Calendar, CheckSquare, Edit2, ExternalLink, FileText, Mail, Phone, Plus, Square, Trash2, User, X } from 'lucide-react';
import DOMPurify from 'dompurify';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, formatRelativeTime, useIsMobile, formatProposalNumber } from '../../utils.js';
import { Modal } from '../ui.jsx';
import { AvatarGroup } from '../Avatar.jsx';
import { PIPELINE_STAGES } from './PipelineView.jsx';
import { TaskFormModal } from './TaskFormModal.jsx';

const LOST_REASONS = ['Price', 'Timing', 'Competitor', 'Disengaged', 'Other'];

export function DealDetailView({ dealId, onBack, onOpenProposal }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [editing, setEditing] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [composingEmail, setComposingEmail] = useState(false);
  const [openEmailId, setOpenEmailId] = useState(null);
  const [askLost, setAskLost] = useState(false);

  useEffect(() => {
    if (dealId) actions.loadDealDetail(dealId);
  }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const detail = state.dealDetail[dealId];
  const deal = detail || state.deals[dealId];
  const company = deal?.companyId ? state.companies[deal.companyId] : null;
  const contact = deal?.primaryContactId ? state.contacts[deal.primaryContactId] : null;
  const owner = deal?.ownerEmail ? state.users[deal.ownerEmail] : null;

  if (!deal) {
    return (
      <div style={{ maxWidth: 900, margin: '0 auto', padding: 32 }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
        <p style={{ marginTop: 24, color: BRAND.muted }}>Loading deal…</p>
      </div>
    );
  }

  const proposals = detail?.proposals || [];
  const events = detail?.events || [];
  const tasks = detail?.tasks || [];
  const emails = detail?.emails || [];

  // Merge events + emails into one chronological timeline. Emails carry
  // sentAt; deal_events carry occurredAt. Tag each item with its kind so the
  // renderer can pick the right component and icon.
  const timeline = useMemo(() => {
    const items = [
      ...events.map(e => ({ kind: 'event', when: e.occurredAt, data: e })),
      ...emails.map(em => ({ kind: 'email', when: em.sentAt, data: em })),
    ];
    items.sort((a, b) => new Date(b.when) - new Date(a.when));
    return items;
  }, [events, emails]);

  const handleStageChange = (next) => {
    if (next === 'lost') {
      setAskLost(true);
      return;
    }
    actions.moveDealStage(dealId, next);
    showMsg(`Stage: ${PIPELINE_STAGES.find(s => s.id === next)?.label || next}`);
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Pipeline</button>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setComposingEmail(true)} className="btn"><Mail size={14} /> Send email</button>
          <button onClick={() => setEditing(true)} className="btn-ghost"><Edit2 size={14} /> Edit deal</button>
          <button
            onClick={() => {
              if (window.confirm('Delete this deal? Linked proposals will be unlinked but not removed.')) {
                actions.deleteDeal(dealId);
                onBack();
              }
            }}
            className="btn-ghost is-danger"
          ><Trash2 size={14} /> Delete</button>
        </div>
      </header>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 16 : 24, marginBottom: 16 }}>
        <h1 style={{ margin: '0 0 12px', fontSize: 22, fontWeight: 700 }}>{deal.title}</h1>
        <StagePicker stage={deal.stage} onChange={handleStageChange} />
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 16, marginTop: 20 }}>
          <Field icon={Building2} label="Company">{company?.name || <span style={{ color: BRAND.muted }}>—</span>}</Field>
          <Field icon={User} label="Primary contact">
            {contact ? <>{contact.name || contact.email}{contact.email && contact.name ? <span style={{ color: BRAND.muted, fontSize: 12 }}> · {contact.email}</span> : null}</> : <span style={{ color: BRAND.muted }}>—</span>}
          </Field>
          <Field icon={User} label="Owner">{owner?.name || deal.ownerEmail || <span style={{ color: BRAND.muted }}>—</span>}</Field>
          <Field label="Value (ex VAT)">{deal.value != null ? <strong>{formatGBP(deal.value)}</strong> : <span style={{ color: BRAND.muted }}>—</span>}</Field>
          <Field icon={Calendar} label="Expected close">{deal.expectedCloseAt || <span style={{ color: BRAND.muted }}>—</span>}</Field>
          <Field label="Last activity">{formatRelativeTime(deal.lastActivityAt)}</Field>
        </div>
        {deal.notes && (
          <div style={{ marginTop: 16, padding: 12, background: '#F8FAFC', borderRadius: 8, fontSize: 13, color: BRAND.ink, whiteSpace: 'pre-wrap' }}>
            {deal.notes}
          </div>
        )}
        {deal.stage === 'lost' && deal.lostReason && (
          <div style={{ marginTop: 12, fontSize: 13, color: '#92400E', background: '#FEF3C7', padding: '8px 12px', borderRadius: 6 }}>
            Lost — {deal.lostReason}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        <Card title="Proposals" count={proposals.length}>
          {proposals.length === 0 && <Empty text="No proposals attached yet" />}
          {proposals.map(p => (
            <button
              key={p.id}
              onClick={() => onOpenProposal?.(p.id)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%', padding: '8px 10px', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', marginBottom: 6 }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {p.number ? <span style={{ color: BRAND.muted, fontSize: 11, marginRight: 6 }}>{formatProposalNumber(p.number)}</span> : null}
                  {p.clientName || p.contactBusinessName || 'Untitled'}
                </div>
                {p.basePrice != null && <div style={{ fontSize: 11, color: BRAND.muted }}>{formatGBP(p.basePrice)} ex VAT</div>}
              </div>
              <ExternalLink size={14} color={BRAND.muted} />
            </button>
          ))}
        </Card>

        <Card title="Tasks" count={tasks.filter(t => !t.doneAt).length} action={
          <button onClick={() => setCreatingTask(true)} className="btn-ghost"><Plus size={12} /> Task</button>
        }>
          {tasks.length === 0 && <Empty text="No tasks yet" />}
          {tasks.map(t => (
            <TaskRow
              key={t.id}
              task={t}
              onToggle={() => actions.toggleTask(t.id)}
              onEdit={() => setEditingTask(t)}
            />
          ))}
        </Card>

        <Card title="Timeline" count={timeline.length}>
          {timeline.length === 0 && <Empty text="No activity yet" />}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {timeline.map((item, i) => item.kind === 'email'
              ? <EmailRow key={'em_' + item.data.gmailMessageId} email={item.data} onOpen={() => setOpenEmailId(item.data.gmailMessageId)} />
              : <EventRow key={'ev_' + item.data.id} event={item.data} users={state.users} />
            )}
          </div>
        </Card>
      </div>

      {editing && <EditDealModal deal={deal} onClose={() => setEditing(false)} />}
      {creatingTask && (
        <TaskFormModal
          defaults={{ dealId }}
          onClose={() => setCreatingTask(false)}
          onSaved={() => { setCreatingTask(false); actions.loadDealDetail(dealId); }}
        />
      )}
      {editingTask && (
        <TaskFormModal
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSaved={() => { setEditingTask(null); actions.loadDealDetail(dealId); }}
        />
      )}
      {composingEmail && (
        <EmailComposerModal
          deal={deal}
          contact={contact}
          onClose={() => setComposingEmail(false)}
          onSent={() => { setComposingEmail(false); actions.loadDealDetail(dealId); }}
        />
      )}
      {askLost && (
        <LostReasonModal
          onClose={() => setAskLost(false)}
          onSubmit={(reason) => { setAskLost(false); actions.moveDealStage(dealId, 'lost', reason); showMsg('Marked as lost'); }}
        />
      )}
      {openEmailId && (
        <EmailViewerModal
          gmailMessageId={openEmailId}
          onClose={() => setOpenEmailId(null)}
        />
      )}
    </div>
  );
}

function Field({ icon: Icon, label, children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 4 }}>
        {Icon && <Icon size={11} />}
        {label}
      </div>
      <div style={{ fontSize: 14 }}>{children}</div>
    </div>
  );
}

function Card({ title, count, action, children }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16, minHeight: 120 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          {title}{typeof count === 'number' ? <span style={{ color: BRAND.blue, marginLeft: 6 }}>· {count}</span> : null}
        </h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function Empty({ text }) {
  return <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted, fontStyle: 'italic' }}>{text}</div>;
}

function TaskRow({ task, onToggle, onEdit }) {
  const done = !!task.doneAt;
  const Icon = done ? CheckSquare : Square;
  const assignees = Array.isArray(task.assigneeEmails) && task.assigneeEmails.length
    ? task.assigneeEmails
    : (task.assigneeEmail ? [task.assigneeEmail] : []);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 4px', borderTop: '1px solid ' + BRAND.border }}>
      <button onClick={onToggle} className="btn-icon" style={{ padding: 4, border: 'none', background: 'transparent' }} aria-label={done ? 'Mark not done' : 'Mark done'}>
        <Icon size={16} color={done ? '#16A34A' : BRAND.muted} />
      </button>
      <button
        onClick={onEdit}
        title="Edit task"
        style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit' }}
      >
        <div style={{ fontSize: 13, fontWeight: 500, textDecoration: done ? 'line-through' : 'none', color: done ? BRAND.muted : BRAND.ink }}>{task.title}</div>
        {task.dueAt && <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>Due {new Date(task.dueAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</div>}
      </button>
      {assignees.length > 0 && (
        <div style={{ flexShrink: 0, marginTop: 4 }}>
          <AvatarGroup emails={assignees} max={3} size={22} />
        </div>
      )}
    </div>
  );
}

function EventRow({ event, users }) {
  const actor = users[event.actorEmail || ''];
  const label = describeEvent(event);
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
      <div style={{ flexShrink: 0, width: 6, height: 6, borderRadius: '50%', background: BRAND.blue, marginTop: 7 }} />
      <div style={{ flex: 1 }}>
        <div>{label}</div>
        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>
          {formatRelativeTime(event.occurredAt)}{actor ? ' · ' + (actor.name || event.actorEmail) : (event.actorEmail ? ' · ' + event.actorEmail : '')}
        </div>
      </div>
    </div>
  );
}

function EmailRow({ email, onOpen }) {
  const inbound = email.direction === 'inbound';
  const arrow = inbound ? '↓' : '↑';
  const accent = inbound ? '#16A34A' : '#2BB8E6';
  const counterparty = inbound ? email.fromEmail : (email.toEmails?.[0] || '');
  // Hard cap snippet length even before CSS truncation, in case Gmail returned
  // a long one with embedded newlines that defeat single-line nowrap.
  const snippetTrim = email.snippet
    ? email.snippet.replace(/\s+/g, ' ').trim().slice(0, 140)
    : null;
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Open email"
      style={{
        display: 'flex', gap: 8, fontSize: 13, minWidth: 0,
        textAlign: 'left', width: '100%', padding: '4px 6px',
        margin: '-4px -6px', border: 'none', borderRadius: 6,
        background: hover ? '#F4F8FB' : 'transparent',
        cursor: 'pointer', fontFamily: 'inherit', color: 'inherit',
      }}
    >
      <div
        style={{
          flexShrink: 0, width: 14, height: 14,
          marginTop: 3,
          background: accent + '22',
          color: accent,
          borderRadius: 3,
          fontSize: 10,
          fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        title={inbound ? 'Inbound email' : 'Outbound email'}
      >
        {arrow}
      </div>
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }} title={email.subject || ''}>
        <div style={{
          fontWeight: 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: 1,
          WebkitBoxOrient: 'vertical',
          wordBreak: 'break-word',
        }}>
          {email.subject || <span style={{ color: BRAND.muted, fontStyle: 'italic' }}>(no subject)</span>}
        </div>
        {snippetTrim && (
          <div style={{
            fontSize: 12,
            color: BRAND.muted,
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 1,
            WebkitBoxOrient: 'vertical',
            wordBreak: 'break-word',
          }}>
            {snippetTrim}
          </div>
        )}
        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>
          {formatRelativeTime(email.sentAt)}{counterparty ? ` · ${inbound ? 'from' : 'to'} ${counterparty}` : ''}
        </div>
      </div>
    </button>
  );
}

// Lazy-loaded full email body viewer. Bodies aren't in the deal payload so we
// fetch on open and cache by gmail_message_id in the store so re-opens are
// instant. HTML is sanitized with DOMPurify before render — emails are an
// untrusted source.
function EmailViewerModal({ gmailMessageId, onClose }) {
  const { state, actions } = useStore();
  const cached = state.emailBodies?.[gmailMessageId] || null;
  const [data, setData] = useState(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    actions.loadEmailBody(gmailMessageId)
      .then((res) => { if (!cancelled) { setData(res); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err?.message || 'Failed to load email'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [gmailMessageId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sanitized = useMemo(() => {
    if (!data?.bodyHtml) return null;
    // Strip inline styles + scripting vectors so a sender can't break our
    // modal layout or run code. Wrap in a constrained container at render.
    return DOMPurify.sanitize(data.bodyHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
    });
  }, [data?.bodyHtml]);

  const inbound = data?.direction === 'inbound';
  const gmailLink = data?.gmailThreadId
    ? `https://mail.google.com/mail/u/0/#all/${data.gmailThreadId}`
    : null;

  return (
    <Modal onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, wordBreak: 'break-word', flex: 1 }}>
            {data?.subject || (loading ? 'Loading…' : '(no subject)')}
          </h2>
          <button onClick={onClose} className="btn-ghost" style={{ padding: 4 }} aria-label="Close"><X size={16} /></button>
        </div>
        {data && (
          <div style={{ fontSize: 12, color: BRAND.muted, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div>
              <span style={{
                display: 'inline-block', padding: '1px 6px', borderRadius: 3, marginRight: 6,
                background: (inbound ? '#16A34A' : '#2BB8E6') + '22',
                color: inbound ? '#16A34A' : '#2BB8E6',
                fontSize: 10, fontWeight: 700,
              }}>{inbound ? 'IN' : 'OUT'}</span>
              <span>{new Date(data.sentAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
            </div>
            {data.fromEmail && <div><strong>From:</strong> {data.fromEmail}</div>}
            {data.toEmails?.length > 0 && <div><strong>To:</strong> {data.toEmails.join(', ')}</div>}
            {data.ccEmails?.length > 0 && <div><strong>Cc:</strong> {data.ccEmails.join(', ')}</div>}
          </div>
        )}
        <div style={{
          borderTop: '1px solid ' + BRAND.border,
          paddingTop: 12,
          maxHeight: '60vh',
          overflowY: 'auto',
          fontSize: 13,
          lineHeight: 1.5,
        }}>
          {loading && <div style={{ color: BRAND.muted }}>Loading email…</div>}
          {error && <div style={{ color: '#DC2626' }}>{error}</div>}
          {!loading && !error && data && (
            sanitized
              ? (
                <div
                  style={{ wordBreak: 'break-word' }}
                  className="email-body"
                  dangerouslySetInnerHTML={{ __html: sanitized }}
                />
              )
              : data.bodyText
                ? <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0 }}>{data.bodyText}</pre>
                : <div style={{ color: BRAND.muted, fontStyle: 'italic' }}>(no body stored — open in Gmail to read)</div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid ' + BRAND.border, paddingTop: 12 }}>
          {gmailLink
            ? <a href={gmailLink} target="_blank" rel="noopener noreferrer" className="btn-ghost" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}><ExternalLink size={12} /> Open in Gmail</a>
            : <span />}
          <button onClick={onClose} className="btn">Close</button>
        </div>
      </div>
    </Modal>
  );
}

function describeEvent(e) {
  const p = e.payload || {};
  switch (e.eventType) {
    case 'deal_created':  return p.title ? `Deal created: ${p.title}` : 'Deal created';
    case 'stage_change':  return `Stage: ${labelForStage(p.from)} → ${labelForStage(p.to)}` + (p.manual ? '' : ' (auto)');
    case 'task_created':  return `Task created: ${p.title || ''}`;
    case 'task_done':     return `Task completed: ${p.title || ''}`;
    case 'task_reopened': return `Task reopened: ${p.title || ''}`;
    case 'email_sent':    return p.subject ? `Email sent: ${p.subject}` : 'Email sent';
    case 'note':          return p.text || 'Note added';
    default:              return e.eventType;
  }
}

function labelForStage(id) {
  return PIPELINE_STAGES.find(s => s.id === id)?.label || id || '—';
}

export function StagePicker({ stage, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {PIPELINE_STAGES.map(s => {
        const active = s.id === stage;
        return (
          <button
            key={s.id}
            onClick={() => onChange(s.id)}
            style={{
              padding: '6px 12px',
              borderRadius: 999,
              border: '1px solid ' + (active ? s.color : BRAND.border),
              background: active ? s.color : 'white',
              color: active ? 'white' : BRAND.ink,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

function EditDealModal({ deal, onClose }) {
  const { state, actions } = useStore();
  const [title, setTitle] = useState(deal.title || '');
  const [value, setValue] = useState(deal.value != null ? String(deal.value) : '');
  const [companyId, setCompanyId] = useState(deal.companyId || '');
  const [primaryContactId, setPrimaryContactId] = useState(deal.primaryContactId || '');
  const [ownerEmail, setOwnerEmail] = useState(deal.ownerEmail || '');
  const [expectedCloseAt, setExpectedCloseAt] = useState(deal.expectedCloseAt || '');
  const [notes, setNotes] = useState(deal.notes || '');
  const [submitting, setSubmitting] = useState(false);

  const companies = Object.values(state.companies || {});
  const contacts = Object.values(state.contacts || {});
  const users = Object.values(state.users || {});

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    await actions.saveDeal(deal.id, {
      title: title.trim(),
      value: value === '' ? null : Number(value),
      companyId: companyId || null,
      primaryContactId: primaryContactId || null,
      ownerEmail: ownerEmail || null,
      expectedCloseAt: expectedCloseAt || null,
      notes: notes || null,
    });
    setSubmitting(false);
    onClose();
  };

  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>Edit deal</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <FormRow label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></FormRow>
        <FormRow label="Value (£, ex VAT)"><input className="input" type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} /></FormRow>
        <FormRow label="Company">
          <select className="input" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">—</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FormRow>
        <FormRow label="Primary contact">
          <select className="input" value={primaryContactId} onChange={(e) => setPrimaryContactId(e.target.value)}>
            <option value="">—</option>
            {contacts.map(c => <option key={c.id} value={c.id}>{c.name || c.email}</option>)}
          </select>
        </FormRow>
        <FormRow label="Owner">
          <select className="input" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)}>
            <option value="">—</option>
            {users.map(u => <option key={u.email} value={u.email}>{u.name || u.email}</option>)}
          </select>
        </FormRow>
        <FormRow label="Expected close (YYYY-MM-DD)"><input className="input" type="date" value={expectedCloseAt} onChange={(e) => setExpectedCloseAt(e.target.value)} /></FormRow>
        <FormRow label="Notes"><textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ fontFamily: 'inherit', resize: 'vertical' }} /></FormRow>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={submitting}>{submitting ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function LostReasonModal({ onClose, onSubmit }) {
  const [reason, setReason] = useState('Price');
  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700 }}>Mark deal as lost</h2>
      <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 16px' }}>What's the main reason?</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
        {LOST_REASONS.map(r => (
          <label key={r} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', cursor: 'pointer', fontSize: 14 }}>
            <input type="radio" name="lost" checked={reason === r} onChange={() => setReason(r)} />
            <span>{r}</span>
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={() => onSubmit(reason)} className="btn">Confirm lost</button>
      </div>
    </Modal>
  );
}

function FormRow({ label, children }) {
  return (
    <label style={{ fontSize: 13, fontWeight: 500, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function EmailComposerModal({ deal, contact, onClose, onSent }) {
  const { state, actions, showMsg } = useStore();
  const gmailConnected = state.gmailAccount && state.gmailAccount.connected;
  const defaultSubject = deal?.title ? `Re: ${deal.title}` : '';
  const [to, setTo] = useState(contact?.email || '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!to.trim() || !subject.trim() || !body.trim() || sending) return;
    setError('');
    setSending(true);
    try {
      const resp = await actions.sendGmail({
        to: to.split(',').map(s => s.trim()).filter(Boolean),
        cc: cc ? cc.split(',').map(s => s.trim()).filter(Boolean) : [],
        subject: subject.trim(),
        text: body,
        html: bodyToHtml(body),
        dealId: deal.id,
      });
      if (!resp?.ok) throw new Error('Send failed');
      showMsg('Email sent');
      onSent?.();
    } catch (err) {
      const msg = err?.message || 'Failed to send';
      if (msg.toLowerCase().includes('not connected') || msg.toLowerCase().includes('reauth') || msg.toLowerCase().includes('expired')) {
        setError(msg + ' Open Account → Gmail integration to connect.');
      } else {
        setError(msg);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>Send email</h2>
      {!gmailConnected && (
        <div style={{ background: '#FEF3C7', color: '#92400E', fontSize: 13, padding: '10px 12px', borderRadius: 6, marginBottom: 14 }}>
          Gmail isn't connected for your account yet. Connect it from Account → Gmail integration before sending.
        </div>
      )}
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <FormRow label="To">
          <input className="input" type="text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" autoFocus required />
        </FormRow>
        <FormRow label="Cc (optional)">
          <input className="input" type="text" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="comma,separated@example.com" />
        </FormRow>
        <FormRow label="Subject">
          <input className="input" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} required />
        </FormRow>
        <FormRow label="Message">
          <textarea
            className="input"
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            style={{ fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5 }}
            required
          />
        </FormRow>
        {error && (
          <div style={{ background: '#FEE2E2', color: '#991B1B', fontSize: 13, padding: '8px 10px', borderRadius: 6 }}>
            {error}
          </div>
        )}
        <div style={{ fontSize: 12, color: BRAND.muted }}>
          Sent from {state.gmailAccount?.gmailAddress || 'your connected Gmail'}. The deal will be tagged via the X-Squideo-Deal header so replies thread back automatically (Phase 3).
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={!gmailConnected || sending || !to.trim() || !subject.trim() || !body.trim()}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function bodyToHtml(text) {
  // Minimal text→HTML: escape and turn newlines into <br>. Keeps the email
  // simple — Phase 5 templates will give us proper rich content.
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return '<div style="font-family:-apple-system,system-ui,sans-serif;font-size:14px;line-height:1.6;color:#0F2A3D;">'
    + escaped.replace(/\n/g, '<br>')
    + '</div>';
}

