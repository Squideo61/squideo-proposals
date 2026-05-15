import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Building2, Calendar, CheckSquare, Clock, Edit2, ExternalLink, FileText, Mail, MessageSquare, Phone, Plus, Square, Trash2, User, X } from 'lucide-react';
import DOMPurify from 'dompurify';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, formatRelativeTime, useIsMobile, formatProposalNumber } from '../../utils.js';
import { Modal } from '../ui.jsx';
import { Avatar, AvatarGroup } from '../Avatar.jsx';
import { PIPELINE_STAGES } from './PipelineView.jsx';
import { TaskFormModal } from './TaskFormModal.jsx';
import { Card, Empty } from './Card.jsx';
import { InvoicesPaymentsCard } from './InvoicesPaymentsCard.jsx';
import { RetainersCard } from './RetainersCard.jsx';

const LOST_REASONS = ['Price', 'Timing', 'Competitor', 'Disengaged', 'Other'];

export function DealDetailView({ dealId, onBack, onOpenProposal, onCreateProposal }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [editing, setEditing] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [composingEmail, setComposingEmail] = useState(false);
  const [openEmailId, setOpenEmailId] = useState(null);
  const [askLost, setAskLost] = useState(false);
  const [prefillTitle, setPrefillTitle] = useState('');
  const [replyingTo, setReplyingTo] = useState(null);
  const [editingCommentId, setEditingCommentId] = useState(null);

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
  const comments = detail?.comments || [];

  const overdueTasks  = tasks.filter(t => isTaskOverdue(t));
  const upcomingTasks = tasks.filter(t => !t.doneAt && !isTaskOverdue(t));
  const doneTasks     = tasks.filter(t => !!t.doneAt);

  const timeline = useMemo(() =>
    [...events]
      .map(e => ({ kind: 'event', when: e.occurredAt, data: e }))
      .sort((a, b) => new Date(b.when) - new Date(a.when)),
  [events]);

  // Group emails by Gmail thread so the UI shows one row per conversation
  // (collapsed by default, expanded to show every message in order). Threads
  // are sorted newest-first by their most recent message; messages within a
  // thread read oldest→newest like a Gmail conversation.
  const threadGroups = useMemo(() => {
    const byThread = new Map();
    for (const em of emails) {
      const tid = em.gmailThreadId || em.gmailMessageId;
      if (!byThread.has(tid)) byThread.set(tid, []);
      byThread.get(tid).push(em);
    }
    const groups = Array.from(byThread.entries()).map(([threadId, msgs]) => {
      const sorted = msgs.slice().sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
      return {
        threadId,
        messages: sorted,
        latestSentAt: sorted[sorted.length - 1]?.sentAt || null,
      };
    });
    groups.sort((a, b) => new Date(b.latestSentAt) - new Date(a.latestSentAt));
    return groups;
  }, [emails]);
  const totalEmails = emails.length;

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
        <Card
          title="Proposals"
          count={proposals.length}
          action={onCreateProposal && (
            <button onClick={() => onCreateProposal(dealId)} className="btn">
              <Plus size={14} /> New proposal
            </button>
          )}
        >
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
                {(p.totalExVat ?? p.basePrice) != null && (
                  <div style={{ fontSize: 11, color: BRAND.muted }}>
                    {formatGBP(p.totalExVat ?? p.basePrice)} ex VAT
                    {p.signed && p.totalExVat != null && p.basePrice != null && p.totalExVat !== p.basePrice && (
                      <span style={{ marginLeft: 4 }} title="Includes selected extras">(inc. extras)</span>
                    )}
                  </div>
                )}
              </div>
              <ExternalLink size={14} color={BRAND.muted} />
            </button>
          ))}
        </Card>

        <Card title="Tasks" count={tasks.filter(t => !t.doneAt).length}>
          <QuickAddTask
            dealId={dealId}
            onSchedule={(title) => { setPrefillTitle(title); setCreatingTask(true); }}
          />
          {tasks.length === 0 && <Empty text="No tasks yet" />}
          {overdueTasks.length > 0 && (
            <>
              <TaskSection label="Overdue" color="#DC2626" />
              {overdueTasks.map(t => (
                <TaskRow key={t.id} task={t} onToggle={() => actions.toggleTask(t.id)} onEdit={() => setEditingTask(t)} />
              ))}
            </>
          )}
          {upcomingTasks.length > 0 && (
            <>
              <TaskSection label="Upcoming" color={BRAND.muted} />
              {upcomingTasks.map(t => (
                <TaskRow key={t.id} task={t} onToggle={() => actions.toggleTask(t.id)} onEdit={() => setEditingTask(t)} />
              ))}
            </>
          )}
          {doneTasks.length > 0 && (
            <>
              <TaskSection label="Done" color="#16A34A" />
              {doneTasks.map(t => (
                <TaskRow key={t.id} task={t} onToggle={() => actions.toggleTask(t.id)} onEdit={() => setEditingTask(t)} />
              ))}
            </>
          )}
        </Card>

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <InvoicesPaymentsCard
            dealId={dealId}
            proposals={proposals}
            contactName={company?.name || contact?.name || deal.title}
          />
        </div>

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <RetainersCard dealId={dealId} contacts={Object.values(state.contacts || {})} />
        </div>

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <Card title="Emails" count={totalEmails} action={
            <button onClick={() => setComposingEmail(true)} className="btn-ghost"><Mail size={12} /> Send email</button>
          }>
            {threadGroups.length === 0 && <Empty text="No emails yet" />}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {threadGroups.map(group => (
                <ThreadRow
                  key={group.threadId}
                  messages={group.messages}
                  dealId={dealId}
                  onOpenMessage={(id) => setOpenEmailId(id)}
                />
              ))}
            </div>
          </Card>
        </div>

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <FilesCard dealId={dealId} files={detail?.files || []} />
        </div>

        <Card title="Activity" count={timeline.length}>
          {timeline.length === 0 && <Empty text="No activity yet" />}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {timeline.map((item) => (
              <EventRow key={'ev_' + item.data.id} event={item.data} users={state.users} />
            ))}
          </div>
        </Card>

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <Card title="Comments" count={comments.length}>
            <CommentThread
              comments={comments}
              session={state.session}
              replyingTo={replyingTo}
              editingCommentId={editingCommentId}
              onReply={(id) => { setReplyingTo(id); setEditingCommentId(null); }}
              onCancelReply={() => setReplyingTo(null)}
              onEdit={(id) => { setEditingCommentId(id); setReplyingTo(null); }}
              onCancelEdit={() => setEditingCommentId(null)}
              onSubmitEdit={(commentId, body, mentions) => {
                actions.editDealComment(commentId, dealId, body, mentions)
                  .then(() => setEditingCommentId(null))
                  .catch(() => {});
              }}
              onDelete={(commentId) => {
                if (window.confirm('Delete this comment?')) {
                  actions.deleteDealComment(commentId, dealId);
                }
              }}
              onReact={(commentId, emoji) => actions.reactToDealComment(commentId, dealId, emoji, state.session?.email)}
              onSubmitReply={(body, mentions) => {
                actions.createDealComment(dealId, body, replyingTo, mentions)
                  .then(() => setReplyingTo(null))
                  .catch(() => {});
              }}
              dealId={dealId}
            />
            <div style={{ marginTop: comments.length > 0 ? 12 : 0, paddingTop: comments.length > 0 ? 12 : 0, borderTop: comments.length > 0 ? '1px solid ' + BRAND.border : 'none' }}>
              <CommentInput
                users={state.users}
                placeholder="Add a comment…"
                onSubmit={(body, mentions) => actions.createDealComment(dealId, body, null, mentions)}
              />
            </div>
          </Card>
        </div>
      </div>

      {editing && <EditDealModal deal={deal} onClose={() => setEditing(false)} />}
      {creatingTask && (
        <TaskFormModal
          defaults={{ dealId, title: prefillTitle }}
          onClose={() => { setCreatingTask(false); setPrefillTitle(''); }}
          onSaved={() => { setCreatingTask(false); setPrefillTitle(''); actions.loadDealDetail(dealId); }}
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
          dealId={dealId}
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


function TaskRow({ task, onToggle, onEdit }) {
  const done = !!task.doneAt;
  const Icon = done ? CheckSquare : Square;
  const overdue = isTaskOverdue(task);
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
        <div style={{ fontSize: 13, fontWeight: 500, textDecoration: done ? 'line-through' : 'none', color: done ? BRAND.muted : BRAND.ink, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span>{task.title}</span>
          {overdue && <OverdueBadge />}
        </div>
        {task.dueAt && (
          <div style={{ fontSize: 11, color: overdue ? '#DC2626' : BRAND.muted, fontWeight: overdue ? 600 : 400, marginTop: 2 }}>
            Due {new Date(task.dueAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
          </div>
        )}
      </button>
      {assignees.length > 0 && (
        <div style={{ flexShrink: 0, marginTop: 4 }}>
          <AvatarGroup emails={assignees} max={3} size={22} />
        </div>
      )}
    </div>
  );
}

function TaskSection({ label, color }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 10, marginBottom: 2 }}>
      {label}
    </div>
  );
}

function QuickAddTask({ dealId, onSchedule }) {
  const { state, actions } = useStore();
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
    d.setHours(8, 0, 0, 0);
    await actions.createTask({
      title: t,
      dealId: dealId || null,
      dueAt: d.toISOString(),
      assigneeEmails: state.session?.email ? [state.session.email] : [],
      notes: null,
    });
    setTitle('');
    setSaving(false);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid ' + BRAND.border, paddingBottom: 8, marginBottom: 4 }}>
      <Plus size={14} color={BRAND.muted} style={{ flexShrink: 0 }} />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        placeholder="Add a task"
        disabled={saving}
        style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13, color: BRAND.ink, fontFamily: 'inherit' }}
      />
      <button
        type="button"
        onClick={() => onSchedule(title.trim())}
        title="Schedule with full details"
        style={{ padding: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: BRAND.muted, display: 'flex', lineHeight: 1 }}
      >
        <Clock size={14} />
      </button>
    </div>
  );
}

function OverdueBadge() {
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 6px',
      borderRadius: 3,
      background: '#FEE2E2',
      color: '#DC2626',
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 0.3,
      textTransform: 'uppercase',
    }}>Overdue</span>
  );
}

function isTaskOverdue(task) {
  if (task.doneAt) return false;
  if (!task.dueAt) return false;
  return new Date(task.dueAt).getTime() < Date.now();
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

function EmailRow({ email, onOpen, threadCount, expanded }) {
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
  const hasThreadChip = typeof threadCount === 'number' && threadCount > 1;
  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={hasThreadChip ? (expanded ? 'Collapse thread' : 'Expand thread') : 'Open email'}
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
      {hasThreadChip && (
        <div style={{ flexShrink: 0, alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, color: BRAND.muted,
            background: '#EEF2F6', padding: '2px 6px', borderRadius: 999,
            letterSpacing: 0.3,
          }}>{threadCount} msgs</span>
          <span style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1 }}>{expanded ? '▾' : '▸'}</span>
        </div>
      )}
    </button>
  );
}

// Gmail-style conversation row. Collapsed: shows the latest message in the
// thread with a "(N messages)" chip when applicable. Expanded: stacks every
// message oldest→newest with its body inlined (lazy-loaded). Single-message
// threads keep the original click-to-modal behaviour.
function ThreadRow({ messages, dealId, onOpenMessage }) {
  const [expanded, setExpanded] = useState(false);
  const isMulti = messages.length > 1;
  const latest = messages[messages.length - 1];
  const threadId = latest.gmailThreadId || latest.gmailMessageId;
  const gmailLink = latest.gmailThreadId
    ? `https://mail.google.com/mail/u/0/#all/${latest.gmailThreadId}`
    : null;

  const handleHeaderClick = () => {
    if (isMulti) {
      setExpanded(e => !e);
    } else {
      onOpenMessage(latest.gmailMessageId);
    }
  };

  return (
    <div>
      <EmailRow
        email={latest}
        onOpen={handleHeaderClick}
        threadCount={isMulti ? messages.length : null}
        expanded={isMulti ? expanded : false}
      />
      {expanded && isMulti && (
        <div style={{ marginTop: 8, marginLeft: 22, paddingLeft: 12, borderLeft: '2px solid ' + BRAND.border, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.map((m) => (
            <ExpandedMessage
              key={m.gmailMessageId}
              email={m}
              onOpenFull={() => onOpenMessage(m.gmailMessageId)}
            />
          ))}
          {gmailLink && (
            <a href={gmailLink} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: BRAND.muted, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start' }}>
              <ExternalLink size={11} /> Open thread in Gmail
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// One message inside an expanded thread. Loads its body on mount (cached in
// the store so re-opens are free), sanitises HTML, and falls back to plain
// text. Click the header to open the standalone modal.
function ExpandedMessage({ email, onOpenFull }) {
  const { state, actions } = useStore();
  const cached = state.emailBodies?.[email.gmailMessageId] || null;
  const [data, setData] = useState(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    actions.loadEmailBody(email.gmailMessageId)
      .then((res) => { if (!cancelled) { setData(res); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err?.message || 'Failed to load'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [email.gmailMessageId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sanitized = useMemo(() => {
    if (!data?.bodyHtml) return null;
    return DOMPurify.sanitize(data.bodyHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
    });
  }, [data?.bodyHtml]);

  const inbound = email.direction === 'inbound';
  const accent = inbound ? '#16A34A' : '#2BB8E6';
  const counterparty = inbound ? email.fromEmail : (email.toEmails?.[0] || '');

  return (
    <div style={{ background: '#FAFBFC', border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 12 }}>
      <button
        type="button"
        onClick={onOpenFull}
        title="Open full message"
        style={{
          width: '100%', background: 'transparent', border: 'none', padding: 0,
          textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: 'inherit',
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
        }}
      >
        <span style={{
          display: 'inline-block', padding: '1px 5px', borderRadius: 3,
          background: accent + '22', color: accent,
          fontSize: 10, fontWeight: 700, flexShrink: 0,
        }}>{inbound ? 'IN' : 'OUT'}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {inbound ? 'From' : 'To'} <strong>{counterparty || '—'}</strong>
        </span>
        <span style={{ fontSize: 11, color: BRAND.muted, flexShrink: 0 }}>
          {formatRelativeTime(email.sentAt)}
        </span>
      </button>
      <div style={{ borderTop: '1px solid ' + BRAND.border, paddingTop: 8, fontSize: 13, lineHeight: 1.5, maxHeight: 320, overflowY: 'auto', wordBreak: 'break-word' }}>
        {loading && <div style={{ color: BRAND.muted, fontSize: 12 }}>Loading…</div>}
        {error && <div style={{ color: '#DC2626', fontSize: 12 }}>{error}</div>}
        {!loading && !error && data && (
          sanitized
            ? <div className="email-body" dangerouslySetInnerHTML={{ __html: sanitized }} />
            : data.bodyText
              ? <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0 }}>{data.bodyText}</pre>
              : <div style={{ color: BRAND.muted, fontStyle: 'italic', fontSize: 12 }}>(no body stored — open in Gmail to read)</div>
        )}
      </div>
    </div>
  );
}

// Lazy-loaded full email body viewer. Bodies aren't in the deal payload so we
// fetch on open and cache by gmail_message_id in the store so re-opens are
// instant. HTML is sanitized with DOMPurify before render — emails are an
// untrusted source.
function EmailViewerModal({ gmailMessageId, dealId, onClose }) {
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
        {data?.attachments?.length > 0 && (
          <div style={{ marginTop: 12, borderTop: '1px solid ' + BRAND.border, paddingTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
              Attachments · {data.attachments.length}
            </div>
            {data.attachments.map(att => (
              <AttachmentRow key={att.attachmentId} attachment={att} dealId={dealId} gmailMessageId={gmailMessageId} />
            ))}
          </div>
        )}
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

function fileSizeLabel(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function FileTypeTag({ mimeType }) {
  if (!mimeType) return <FileText size={14} color={BRAND.muted} />;
  if (mimeType.startsWith('image/')) return <span style={{ fontSize: 10, fontWeight: 700, color: '#7C3AED' }}>IMG</span>;
  if (mimeType === 'application/pdf') return <span style={{ fontSize: 10, fontWeight: 700, color: '#DC2626' }}>PDF</span>;
  if (mimeType.includes('sheet') || mimeType.includes('excel') || mimeType.includes('csv'))
    return <span style={{ fontSize: 10, fontWeight: 700, color: '#16A34A' }}>XLS</span>;
  if (mimeType.includes('word') || mimeType.includes('document'))
    return <span style={{ fontSize: 10, fontWeight: 700, color: '#2563EB' }}>DOC</span>;
  return <FileText size={14} color={BRAND.muted} />;
}

function FilesCard({ dealId, files }) {
  const { actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = React.useRef(null);

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const tooBig = files.find(f => f.size > 20 * 1024 * 1024);
    if (tooBig) { showMsg(`"${tooBig.name}" is too large (max 20 MB)`); return; }
    setUploading(true);
    try {
      await Promise.all(files.map(f => actions.uploadDealFile(dealId, f)));
      showMsg(files.length === 1 ? 'File uploaded' : `${files.length} files uploaded`);
    } catch (err) {
      showMsg(err.message || 'Upload failed');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleDownload = async (fileId, filename) => {
    try {
      const { downloadUrl } = await actions.getFileDownloadUrl(dealId, fileId);
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
    } catch {
      showMsg('Could not generate download link');
    }
  };

  const handleDelete = async (fileId, filename) => {
    if (!window.confirm(`Delete "${filename}"?`)) return;
    await actions.deleteDealFile(dealId, fileId);
    showMsg('File deleted');
  };

  return (
    <Card title="Files" count={files.length} action={
      <button className="btn-ghost" onClick={() => inputRef.current?.click()} disabled={uploading}>
        <Plus size={12} /> {uploading ? 'Uploading…' : 'Upload'}
      </button>
    }>
      <input ref={inputRef} type="file" multiple style={{ display: 'none' }}
        onChange={(e) => handleFiles(e.target.files)} />
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!uploading) handleFiles(e.dataTransfer.files); }}
        onClick={() => { if (!uploading) inputRef.current?.click(); }}
        style={{
          border: '2px dashed ' + (dragOver ? BRAND.blue : BRAND.border),
          borderRadius: 8, padding: '8px 14px', fontSize: 12,
          color: dragOver ? BRAND.blue : BRAND.muted,
          background: dragOver ? BRAND.blue + '0A' : 'transparent',
          cursor: uploading ? 'not-allowed' : 'pointer',
          textAlign: 'center', marginBottom: files.length ? 10 : 0,
        }}
      >
        {uploading ? 'Uploading…' : 'Drop files here or click Upload'}
      </div>
      {files.length === 0 && !uploading && <Empty text="No files attached yet" />}
      {files.map(f => (
        <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderTop: '1px solid ' + BRAND.border }}>
          <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 6, background: '#F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <FileTypeTag mimeType={f.mimeType} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filename}</div>
            <div style={{ fontSize: 11, color: BRAND.muted }}>
              {fileSizeLabel(f.sizeBytes)}{f.sizeBytes ? ' · ' : ''}{formatRelativeTime(f.createdAt)}{f.source === 'email' ? ' · from email' : ''}
            </div>
          </div>
          {f.uploadedBy && <Avatar email={f.uploadedBy} size={20} />}
          <button onClick={() => handleDownload(f.id, f.filename)}
            style={{ padding: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: BRAND.muted, display: 'flex' }}
            title="Download">
            <ExternalLink size={13} />
          </button>
          <button onClick={() => handleDelete(f.id, f.filename)}
            style={{ padding: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: BRAND.muted, display: 'flex' }}
            title="Delete file">
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </Card>
  );
}

function AttachmentRow({ attachment, dealId, gmailMessageId }) {
  const { actions, showMsg } = useStore();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleAdd = async () => {
    if (!dealId || saving || saved) return;
    setSaving(true);
    try {
      await actions.addDealFileFromEmail(dealId, {
        gmailMessageId,
        attachmentId: attachment.attachmentId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
      });
      setSaved(true);
      showMsg(`"${attachment.filename}" added to files`);
    } catch (err) {
      showMsg(err.message || 'Failed to add attachment');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <FileText size={14} color={BRAND.muted} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.filename}</div>
        {attachment.size && <div style={{ fontSize: 11, color: BRAND.muted }}>{fileSizeLabel(attachment.size)}</div>}
      </div>
      {dealId && (
        <button onClick={handleAdd} disabled={saving || saved} className="btn-ghost"
          style={{ fontSize: 11, padding: '3px 8px', flexShrink: 0 }}>
          {saved ? 'Added ✓' : saving ? 'Adding…' : '+ Add to files'}
        </button>
      )}
    </div>
  );
}

// -------------------- Comments --------------------

function renderCommentBody(body, mentions) {
  if (!mentions || !mentions.length) return body;
  // Highlight @Name tokens that correspond to a mentioned email's name.
  // We split on word boundaries around @ so plain text is preserved.
  const parts = body.split(/(@\S+)/g);
  return parts.map((part, i) => {
    if (!part.startsWith('@')) return part;
    const nameToken = part.slice(1).toLowerCase();
    const matched = mentions.some(email => {
      const name = email.split('@')[0].toLowerCase();
      return nameToken.startsWith(name.replace(/\./g, '').slice(0, 5));
    });
    if (!matched) return part;
    return (
      <span key={i} style={{ color: BRAND.blue, fontWeight: 600 }}>{part}</span>
    );
  });
}

const REACTION_EMOJIS = ['👍', '👎', '❤️', '😂', '🎉', '👀'];

function ReactionBar({ reactions = {}, userEmail, onReact }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const existing = Object.entries(reactions).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, alignItems: 'center' }}>
      {existing.map(([emoji, { count, users }]) => {
        const mine = users.includes(userEmail);
        return (
          <button
            key={emoji}
            onClick={() => onReact(emoji)}
            title={users.join(', ')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '2px 7px', borderRadius: 12, border: '1px solid',
              fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
              background: mine ? '#EFF6FF' : 'white',
              borderColor: mine ? BRAND.blue : BRAND.border,
              color: mine ? BRAND.blue : BRAND.ink,
              fontWeight: mine ? 600 : 400,
              lineHeight: 1.4,
            }}
          >
            {emoji} <span style={{ fontSize: 11 }}>{count}</span>
          </button>
        );
      })}
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setPickerOpen(v => !v)}
          title="Add reaction"
          style={{
            display: 'inline-flex', alignItems: 'center', padding: '2px 6px',
            borderRadius: 12, border: '1px solid ' + BRAND.border,
            fontSize: 12, cursor: 'pointer', background: 'white',
            color: BRAND.muted, fontFamily: 'inherit', lineHeight: 1.4,
          }}
        >
          +
        </button>
        {pickerOpen && (
          <div
            style={{
              position: 'absolute', bottom: '100%', left: 0, marginBottom: 4,
              display: 'flex', gap: 2, padding: '4px 6px',
              background: 'white', border: '1px solid ' + BRAND.border,
              borderRadius: 10, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 10,
            }}
            onMouseLeave={() => setPickerOpen(false)}
          >
            {REACTION_EMOJIS.map(e => (
              <button
                key={e}
                onClick={() => { onReact(e); setPickerOpen(false); }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 18, padding: '2px 4px', borderRadius: 6,
                  lineHeight: 1,
                }}
                title={e}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CommentRow({ comment, session, isReply, replyingTo, editingCommentId, onReply, onCancelReply, onEdit, onCancelEdit, onSubmitEdit, onDelete, onSubmitReply, onReact, users }) {
  const [hover, setHover] = useState(false);
  const isMine = session?.email === comment.createdBy;
  const isAdmin = Array.isArray(session?.permissions) && (session.permissions.includes('*') || session.permissions.includes('comments.manage_all'));
  const isEditing = editingCommentId === comment.id;
  const isReplying = replyingTo === comment.id;

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        paddingLeft: isReply ? 28 : 0,
        borderLeft: isReply ? '2px solid ' + BRAND.border : 'none',
        marginLeft: isReply ? 16 : 0,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={{ flexShrink: 0, marginTop: 2 }}>
        <Avatar email={comment.createdBy} size={24} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{comment.authorName || comment.createdBy}</span>
          <span style={{ fontSize: 11, color: BRAND.muted }}>{formatRelativeTime(comment.createdAt)}{comment.updatedAt ? ' · edited' : ''}</span>
          {(hover || isEditing || isReplying) && !isEditing && (
            <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
              {!isReply && (
                <button
                  onClick={() => isReplying ? onCancelReply() : onReply(comment.id)}
                  style={{ padding: '2px 6px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, color: BRAND.muted, fontFamily: 'inherit', borderRadius: 4 }}
                  title="Reply"
                >
                  Reply
                </button>
              )}
              {(isMine || isAdmin) && (
                <>
                  <button
                    onClick={() => onEdit(comment.id)}
                    style={{ padding: '2px 6px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, color: BRAND.muted, fontFamily: 'inherit', borderRadius: 4 }}
                    title="Edit"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onDelete(comment.id)}
                    style={{ padding: '2px 6px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, color: '#DC2626', fontFamily: 'inherit', borderRadius: 4 }}
                    title="Delete"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {isEditing ? (
          <CommentInput
            users={users}
            initialBody={comment.body}
            initialMentions={comment.mentions || []}
            placeholder="Edit comment…"
            submitLabel="Save"
            onSubmit={(body, mentions) => onSubmitEdit(comment.id, body, mentions)}
            onCancel={onCancelEdit}
          />
        ) : (
          <>
            <div style={{ fontSize: 13, color: BRAND.ink, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {renderCommentBody(comment.body, comment.mentions)}
            </div>
            {onReact && (
              <ReactionBar
                reactions={comment.reactions || {}}
                userEmail={session?.email}
                onReact={(emoji) => onReact(comment.id, emoji)}
              />
            )}
          </>
        )}
        {isReplying && (
          <div style={{ marginTop: 8 }}>
            <CommentInput
              users={users}
              placeholder={'Reply to ' + (comment.authorName || comment.createdBy) + '…'}
              submitLabel="Reply"
              onSubmit={onSubmitReply}
              onCancel={onCancelReply}
              autoFocus
            />
          </div>
        )}
      </div>
    </div>
  );
}

function CommentThread({ comments, session, replyingTo, editingCommentId, onReply, onCancelReply, onEdit, onCancelEdit, onSubmitEdit, onDelete, onSubmitReply, onReact, dealId }) {
  const { state } = useStore();
  const topLevel = comments.filter(c => !c.parentId);
  const replies = comments.filter(c => !!c.parentId);

  if (comments.length === 0) return <Empty text="No comments yet — be the first!" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {topLevel.map(comment => {
        const childReplies = replies.filter(r => r.parentId === comment.id);
        return (
          <div key={comment.id}>
            <CommentRow
              comment={comment}
              session={session}
              isReply={false}
              replyingTo={replyingTo}
              editingCommentId={editingCommentId}
              onReply={onReply}
              onCancelReply={onCancelReply}
              onEdit={onEdit}
              onCancelEdit={onCancelEdit}
              onSubmitEdit={onSubmitEdit}
              onDelete={onDelete}
              onSubmitReply={onSubmitReply}
              onReact={onReact}
              users={state.users}
            />
            {childReplies.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
                {childReplies.map(reply => (
                  <CommentRow
                    key={reply.id}
                    comment={reply}
                    session={session}
                    isReply={true}
                    replyingTo={replyingTo}
                    editingCommentId={editingCommentId}
                    onReply={onReply}
                    onCancelReply={onCancelReply}
                    onEdit={onEdit}
                    onCancelEdit={onCancelEdit}
                    onSubmitEdit={onSubmitEdit}
                    onDelete={onDelete}
                    onSubmitReply={onSubmitReply}
                    onReact={onReact}
                    users={state.users}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CommentInput({ users, placeholder = 'Add a comment…', initialBody = '', initialMentions = [], submitLabel = 'Comment', onSubmit, onCancel, autoFocus = false }) {
  const [body, setBody] = useState(initialBody);
  const [mentions, setMentions] = useState(initialMentions);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (autoFocus && textareaRef.current) textareaRef.current.focus();
  }, [autoFocus]);

  const userList = Object.values(users || {});

  const filteredUsers = mentionQuery !== null
    ? userList.filter(u => {
        const q = mentionQuery.toLowerCase();
        return (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q);
      }).slice(0, 5)
    : [];

  const handleChange = (e) => {
    const val = e.target.value;
    setBody(val);
    const caret = e.target.selectionStart;
    const textUpToCaret = val.slice(0, caret);
    const match = textUpToCaret.match(/@(\w*)$/);
    if (match) {
      setMentionQuery(match[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  };

  const insertMention = (selectedUser) => {
    const caret = textareaRef.current?.selectionStart ?? body.length;
    const textUpToCaret = body.slice(0, caret);
    const textAfterCaret = body.slice(caret);
    const replaced = textUpToCaret.replace(/@(\w*)$/, '@' + (selectedUser.name || selectedUser.email).split(' ')[0] + ' ');
    setBody(replaced + textAfterCaret);
    setMentions(prev => prev.includes(selectedUser.email) ? prev : [...prev, selectedUser.email]);
    setMentionQuery(null);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const pos = replaced.length;
        textareaRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  };

  const handleKeyDown = (e) => {
    if (mentionQuery !== null && filteredUsers.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => Math.min(i + 1, filteredUsers.length - 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(filteredUsers[mentionIndex]); return; }
      if (e.key === 'Escape') { setMentionQuery(null); return; }
    }
    if (e.key === 'Escape' && onCancel) { onCancel(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSubmit(); }
  };

  const handleSubmit = async () => {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed, mentions);
      setBody('');
      setMentions([]);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <textarea
        ref={textareaRef}
        value={body}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={2}
        disabled={submitting}
        style={{
          width: '100%',
          border: '1px solid ' + BRAND.border,
          borderRadius: 6,
          padding: '8px 10px',
          fontSize: 13,
          fontFamily: 'inherit',
          resize: 'vertical',
          outline: 'none',
          background: 'white',
          color: BRAND.ink,
          boxSizing: 'border-box',
        }}
      />
      {mentionQuery !== null && filteredUsers.length > 0 && (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: 0,
          zIndex: 100,
          background: 'white',
          border: '1px solid ' + BRAND.border,
          borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
          minWidth: 220,
          overflow: 'hidden',
          marginBottom: 4,
        }}>
          {filteredUsers.map((u, i) => (
            <button
              key={u.email}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); insertMention(u); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', padding: '8px 10px', border: 'none',
                background: i === mentionIndex ? '#F0F7FF' : 'white',
                cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
              }}
            >
              <Avatar email={u.email} size={20} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{u.name || u.email}</div>
                {u.name && <div style={{ fontSize: 11, color: BRAND.muted }}>{u.email}</div>}
              </div>
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}>
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!body.trim() || submitting}
          className="btn"
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          {submitting ? 'Saving…' : submitLabel}
        </button>
      </div>
    </div>
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
  const activeIdx = PIPELINE_STAGES.findIndex(s => s.id === stage);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', borderRadius: 8, overflow: 'hidden', border: '1px solid ' + BRAND.border }}>
      {PIPELINE_STAGES.map((s, i) => {
        const active = s.id === stage;
        const past = i < activeIdx;
        return (
          <button
            key={s.id}
            onClick={() => onChange(s.id)}
            style={{
              flex: '1 1 auto',
              padding: '7px 10px',
              border: 'none',
              borderLeft: i > 0 ? '1px solid rgba(0,0,0,0.12)' : 'none',
              background: active ? s.color : past ? s.color + '33' : '#F1F5F9',
              color: active ? 'white' : past ? s.color : BRAND.muted,
              fontSize: 11,
              fontWeight: active ? 700 : 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
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
  const [signature, setSignature] = useState(null); // null = loading, '' = none

  useEffect(() => {
    if (!gmailConnected) { setSignature(''); return; }
    let cancelled = false;
    actions.getGmailSignature()
      .then(r => { if (!cancelled) setSignature(r?.signatureHtml || ''); })
      .catch(() => { if (!cancelled) setSignature(''); });
    return () => { cancelled = true; };
  }, [gmailConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  const sanitizedSignature = useMemo(() => {
    if (!signature) return null;
    return DOMPurify.sanitize(signature, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    });
  }, [signature]);

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
        {gmailConnected && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Signature (synced from Gmail)
            </div>
            {signature === null && (
              <div style={{ fontSize: 12, color: BRAND.muted, fontStyle: 'italic' }}>Loading signature…</div>
            )}
            {signature === '' && (
              <div style={{ fontSize: 12, color: BRAND.muted, fontStyle: 'italic' }}>
                No Gmail signature found — set one in Gmail and reconnect to apply it here.
              </div>
            )}
            {sanitizedSignature && (
              <div
                className="email-body"
                style={{ background: '#FAFBFC', border: '1px solid ' + BRAND.border, borderRadius: 6, padding: 10, fontSize: 12, lineHeight: 1.5, maxHeight: 160, overflowY: 'auto', wordBreak: 'break-word' }}
                dangerouslySetInnerHTML={{ __html: sanitizedSignature }}
              />
            )}
          </div>
        )}
        {error && (
          <div style={{ background: '#FEE2E2', color: '#991B1B', fontSize: 13, padding: '8px 10px', borderRadius: 6 }}>
            {error}
          </div>
        )}
        <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.5 }}>
          Sent from {state.gmailAccount?.gmailAddress || 'your connected Gmail'} via the Gmail API — this message will appear in your Gmail Sent folder. The deal is tagged via the X-Squideo-Deal header so replies thread back automatically.
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

