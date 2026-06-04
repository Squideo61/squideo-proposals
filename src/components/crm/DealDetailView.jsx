import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Building2, Calendar, CheckSquare, Clock, Edit2, ExternalLink, FileText, Mail, MessageSquare, MoreVertical, Phone, Plus, Square, Trash2, User, X } from 'lucide-react';
import DOMPurify from 'dompurify';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, formatRelativeTime, useIsMobile, formatProposalNumber } from '../../utils.js';
import { Badge, Modal } from '../ui.jsx';
import { Avatar, AvatarGroup } from '../Avatar.jsx';
import { PIPELINE_STAGES, NewDealModal } from './PipelineView.jsx';
import { TaskFormModal } from './TaskFormModal.jsx';
import { Card, Empty } from './Card.jsx';
import { InvoicesPaymentsCard } from './InvoicesPaymentsCard.jsx';
import { OrderSummaryCard } from './OrderSummaryCard.jsx';
import { RetainersCard } from './RetainersCard.jsx';
import { ProductionPanel } from './ProductionPanel.jsx';

const LOST_REASONS = ['Price', 'Timing', 'Competitor', 'Disengaged', 'Other'];

export function DealDetailView({ dealId, onBack, onOpenProposal, onCreateProposal, onOpenVideo, onOpenCompany }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [editing, setEditing] = useState(false);
  // Bumped when invoices/extras change so the Order Summary re-pulls.
  const [orderRefresh, setOrderRefresh] = useState(0);
  const [creatingTask, setCreatingTask] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  // The composer itself is mounted at App level (see EmailComposerHost) so
  // it survives navigation. Opening it is now a store action.
  const openComposerForDeal = () => actions.openComposer({
    dealId: deal?.id,
    dealTitle: deal?.title,
    contactEmail: contact?.email || null,
  });
  const [openEmailId, setOpenEmailId] = useState(null);
  const [askLost, setAskLost] = useState(false);
  const [prefillTitle, setPrefillTitle] = useState('');
  const [replyingTo, setReplyingTo] = useState(null);
  const [editingCommentId, setEditingCommentId] = useState(null);
  // Linking an email to other deals — populated when the user picks "Add to
  // another deal" / "Create new deal" from a row's kebab menu. `target`
  // carries the thread + latest message id; the modal uses both so the user
  // can choose whole-thread vs single-message scope at submit time.
  const [linkEmailTarget, setLinkEmailTarget] = useState(null);
  const [newDealFromEmail, setNewDealFromEmail] = useState(null);

  useEffect(() => {
    if (dealId) {
      actions.loadDealDetail(dealId);
      actions.loadScheduledEmails(dealId);
    }
  }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const detail = state.dealDetail[dealId];
  const deal = detail || state.deals[dealId];
  const company = deal?.companyId ? state.companies[deal.companyId] : null;
  const contact = deal?.primaryContactId ? state.contacts[deal.primaryContactId] : null;
  const owner = deal?.ownerEmail ? state.users[deal.ownerEmail] : null;

  if (!deal) {
    return (
      <div style={{ padding: 32 }}>
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
  // Drafts the user explicitly saved while composing on this deal. Filtered
  // by dealId so each deal page only shows its own. Newest first.
  const dealDrafts = useMemo(
    () => (state.drafts || []).filter((d) => d.dealId === dealId).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || '')),
    [state.drafts, dealId],
  );
  const dealScheduled = (state.scheduledEmails && state.scheduledEmails[dealId]) || [];

  // Set of addresses we already consider "linked" to this deal — used by the
  // email rows to decide whether a Cc'd address counts as "new on this thread"
  // and worth prompting about. Includes the signed-in user (you are never a
  // candidate for being added to your own deal as a secondary contact), the
  // primary contact, and any existing secondary contacts.
  const linkedEmails = useMemo(() => {
    const set = new Set();
    if (state.session?.email) set.add(state.session.email.toLowerCase());
    if (contact?.email) set.add(contact.email.toLowerCase());
    for (const sc of (detail?.secondaryContacts || [])) {
      if (sc.email) set.add(sc.email.toLowerCase());
    }
    return set;
  }, [state.session?.email, contact?.email, detail?.secondaryContacts]);

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
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Pipeline</button>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => openComposerForDeal()} className="btn"><Mail size={14} /> Send email</button>
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
          <Field icon={Building2} label="Company">
            {company
              ? (onOpenCompany
                  ? <button type="button" onClick={() => onOpenCompany(company.id)} className="link-btn" style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: BRAND.blue, cursor: 'pointer', textAlign: 'left' }}>{company.name}</button>
                  : company.name)
              : <span style={{ color: BRAND.muted }}>—</span>}
          </Field>
          <Field icon={User} label="Primary contact">
            {contact ? <>{contact.name || contact.email}{contact.email && contact.name ? <span style={{ color: BRAND.muted, fontSize: 12 }}> · {contact.email}</span> : null}</> : <span style={{ color: BRAND.muted }}>—</span>}
          </Field>
          <Field icon={User} label="Owner">{owner?.name || deal.ownerEmail || <span style={{ color: BRAND.muted }}>—</span>}</Field>
          <Field label="Value (ex VAT)">{deal.value != null ? <strong>{formatGBP(deal.value)}</strong> : <span style={{ color: BRAND.muted }}>—</span>}</Field>
          <Field icon={Calendar} label="Expected close">{deal.expectedCloseAt || <span style={{ color: BRAND.muted }}>—</span>}</Field>
          <Field label="Last activity">{formatRelativeTime(deal.lastActivityAt)}</Field>
        </div>
        <SecondaryContactsRow
          dealId={dealId}
          primaryContact={contact}
          secondaryContacts={detail?.secondaryContacts || []}
          defaultCompanyId={deal.companyId || null}
        />
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

      <ProductionPanel dealId={dealId} deal={deal} videos={detail?.videos || []} isMobile={isMobile} onOpenVideo={onOpenVideo} />

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
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {p.number ? <span style={{ color: BRAND.muted, fontSize: 11 }}>{formatProposalNumber(p.number)}</span> : null}
                  <span>{p.clientName || p.contactBusinessName || 'Untitled'}</span>
                  {p.signed
                    ? <Badge color="green">Signed</Badge>
                    : <Badge color="grey">Unsigned</Badge>}
                </div>
                {(p.totalExVat ?? p.basePrice) != null && (
                  <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>
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
          <OrderSummaryCard dealId={dealId} refreshKey={orderRefresh} />
        </div>

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <InvoicesPaymentsCard
            dealId={dealId}
            proposals={proposals}
            contactName={company?.name || contact?.name || deal.title}
            onChanged={() => setOrderRefresh((n) => n + 1)}
          />
        </div>

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <RetainersCard dealId={dealId} contacts={Object.values(state.contacts || {})} />
        </div>

        {dealDrafts.length > 0 && (
          <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
            <DealDraftsCard
              drafts={dealDrafts}
              onResume={(id) => actions.resumeDraft(id)}
              onDiscard={(id) => actions.discardDraft(id)}
            />
          </div>
        )}

        {dealScheduled.length > 0 && (
          <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
            <DealScheduledCard
              scheduled={dealScheduled}
              onCancel={(id) => actions.cancelScheduledEmail(dealId, id)}
            />
          </div>
        )}

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <Card title="Emails" count={totalEmails} action={
            <button onClick={() => openComposerForDeal()} className="btn-ghost"><Mail size={12} /> Send email</button>
          }>
            {threadGroups.length === 0 && <Empty text="No emails yet" />}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {threadGroups.map(group => (
                <ThreadRow
                  key={group.threadId}
                  messages={group.messages}
                  dealId={dealId}
                  dealTitle={deal.title}
                  linkedEmails={linkedEmails}
                  defaultCompanyId={deal.companyId || null}
                  onOpenMessage={(id) => setOpenEmailId(id)}
                  onLinkAnother={(target) => setLinkEmailTarget(target)}
                  onCreateNewDeal={(target) => setNewDealFromEmail(target)}
                />
              ))}
            </div>
          </Card>
        </div>

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <FilesCard dealId={dealId} files={detail?.files || []} driveEnabled={!!detail?.driveFiles} />
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
      {/* Composer lives at the App root now (see EmailComposerHost) so it
          stays open across CRM navigation. Opened via actions.openComposer. */}
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
      {linkEmailTarget && (
        <LinkEmailModal
          target={linkEmailTarget}
          currentDealId={dealId}
          onClose={() => setLinkEmailTarget(null)}
          onLinked={() => { setLinkEmailTarget(null); actions.loadDealDetail(dealId); }}
        />
      )}
      {newDealFromEmail && (
        <NewDealFromEmailFlow
          target={newDealFromEmail}
          onClose={() => setNewDealFromEmail(null)}
          onCreated={() => { setNewDealFromEmail(null); actions.loadDealDetail(dealId); }}
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

export function EventRow({ event, users }) {
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

function EmailRow({ email, onOpen, threadCount, expanded, dealTitle, onLinkAnother, onCreateNewDeal }) {
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
  // Kebab menu state. Anchor ref drives the portal-positioned menu so it
  // floats above the row regardless of overflow on the parent card.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef(null);
  const linkLabel = email.manuallyLinked
    ? `Linked to ${dealTitle || 'this deal'}`
    : `Auto-linked to ${dealTitle || 'this deal'}`;
  // Row uses a div + onKeyDown rather than a <button> so we can nest the
  // kebab button inside (nested buttons are invalid HTML).
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen?.();
        }
      }}
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
        <div
          style={{
            fontSize: 10, color: BRAND.muted, marginTop: 3,
            display: 'inline-block', background: '#F1F4F7',
            padding: '1px 6px', borderRadius: 999, letterSpacing: 0.2,
          }}
          title={email.manuallyLinked ? 'You added this email to this deal manually.' : 'Squideo auto-linked this email to this deal.'}
        >
          {linkLabel}
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
      {(onLinkAnother || onCreateNewDeal) && (
        <div
          style={{ flexShrink: 0, alignSelf: 'flex-start', marginTop: 1 }}
          // Stop the kebab's clicks from triggering the row's onOpen.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <button
            ref={menuAnchorRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Email actions"
            onClick={() => setMenuOpen((o) => !o)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: 4, color: BRAND.muted, borderRadius: 4,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <MoreVertical size={14} />
          </button>
          {menuOpen && (
            <EmailActionsMenu
              anchor={menuAnchorRef.current}
              onClose={() => setMenuOpen(false)}
              onLinkAnother={onLinkAnother}
              onCreateNewDeal={onCreateNewDeal}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Portal-positioned actions menu for an email row. Mirrors the ProjectMenu
// pattern in RetainersCard.jsx (click-outside / Escape closes, fixed-position
// computed from the anchor's bounding rect).
function EmailActionsMenu({ anchor, onClose, onLinkAnother, onCreateNewDeal }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!anchor) return;
    const update = () => {
      const r = anchor.getBoundingClientRect();
      // Open below the anchor, right-aligned.
      const width = 220;
      setPos({ top: r.bottom + 4, left: Math.max(8, r.right - width) });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onDocClick = (e) => {
      if (!menuRef.current) return;
      if (menuRef.current.contains(e.target)) return;
      if (anchor && anchor.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  const items = [
    onLinkAnother && { label: 'Add to another deal', onClick: () => { onClose(); onLinkAnother(); } },
    onCreateNewDeal && { label: 'Create new deal from this email', onClick: () => { onClose(); onCreateNewDeal(); } },
  ].filter(Boolean);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: 'fixed', top: pos.top, left: pos.left, width: 220,
        background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8,
        boxShadow: '0 8px 20px rgba(15,42,61,0.15)', padding: 4, zIndex: 1500,
      }}
    >
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          onClick={it.onClick}
          style={{
            display: 'block', width: '100%', textAlign: 'left',
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '8px 10px', borderRadius: 6, fontSize: 13, color: BRAND.ink,
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#F4F8FB')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

// Gmail-style conversation row. Collapsed: shows the latest message in the
// thread with a "(N messages)" chip when applicable. Expanded: stacks every
// message oldest→newest with its body inlined (lazy-loaded). Single-message
// threads keep the original click-to-modal behaviour.
export function ThreadRow({ messages, dealId, dealTitle, linkedEmails, defaultCompanyId, onOpenMessage, onLinkAnother, onCreateNewDeal }) {
  const [expanded, setExpanded] = useState(false);
  const isMulti = messages.length > 1;
  const latest = messages[messages.length - 1];
  const threadId = latest.gmailThreadId || latest.gmailMessageId;
  const gmailLink = latest.gmailThreadId
    ? `https://mail.google.com/mail/u/0/#all/${latest.gmailThreadId}`
    : null;

  // Addresses Cc'd into any *inbound* message on this thread that aren't
  // already linked to this deal. We only mine inbound because the user asked
  // for "Cc'd in replies I get" — outgoing Cc's are the user's own choice and
  // don't need a prompt.
  const unknownCcs = useMemo(() => {
    if (!linkedEmails) return [];
    const seen = new Set();
    const out = [];
    for (const m of messages) {
      if (m.direction !== 'inbound') continue;
      const ccs = Array.isArray(m.ccEmails) ? m.ccEmails : [];
      for (const raw of ccs) {
        if (!raw || typeof raw !== 'string') continue;
        const lower = raw.trim().toLowerCase();
        if (!lower || seen.has(lower) || linkedEmails.has(lower)) continue;
        seen.add(lower);
        out.push(raw.trim());
      }
    }
    return out;
  }, [messages, linkedEmails]);

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
        dealTitle={dealTitle}
        onLinkAnother={onLinkAnother ? () => onLinkAnother({ threadId, gmailMessageId: latest.gmailMessageId, subject: latest.subject }) : null}
        onCreateNewDeal={onCreateNewDeal ? () => onCreateNewDeal({ threadId, gmailMessageId: latest.gmailMessageId, subject: latest.subject }) : null}
      />
      {unknownCcs.length > 0 && (
        <CcSuggestionStrip
          dealId={dealId}
          addresses={unknownCcs}
          defaultCompanyId={defaultCompanyId}
        />
      )}
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
// Modal opened from an email row's kebab → "Add to another deal". Lets the
// user pick which deal to attach this conversation (or just the visible
// message) to. The deal list is read from the store's cached `state.deals`
// — same source the pipeline + task picker use — filtered to anything that
// isn't lost and excluding the deal we're already on.
export function LinkEmailModal({ target, currentDealId, onClose, onLinked }) {
  const { state, actions, showMsg } = useStore();
  const candidates = useMemo(() => {
    return Object.values(state.deals || {})
      .filter((d) => d && d.id !== currentDealId && d.stage !== 'lost' && d.stage !== 'won')
      .sort((a, b) => {
        const ta = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
        const tb = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
        return tb - ta;
      });
  }, [state.deals, currentDealId]);
  const [dealId, setDealId] = useState(candidates[0]?.id || '');
  const [scope, setScope] = useState('thread');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!dealId || submitting) return;
    setSubmitting(true);
    try {
      const r = await actions.linkEmail({
        threadId: target.threadId,
        gmailMessageId: target.gmailMessageId,
        dealId,
        scope,
      });
      showMsg('Linked to ' + (r?.dealTitle || 'deal'));
      onLinked?.();
    } catch (err) {
      showMsg('Could not link: ' + (err?.message || 'unknown error'));
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>Add email to another deal</h2>
      {candidates.length === 0 ? (
        <>
          <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 16px' }}>
            No other open deals to link to. Use <strong>Create new deal from this email</strong> instead.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} className="btn-ghost">Close</button>
          </div>
        </>
      ) : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ fontSize: 13, fontWeight: 500 }}>
            Deal
            <select className="input" value={dealId} onChange={(e) => setDealId(e.target.value)} style={{ marginTop: 4 }} required>
              {candidates.map((d) => (
                <option key={d.id} value={d.id}>{d.title}</option>
              ))}
            </select>
          </label>
          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Link</legend>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 4 }}>
              <input type="radio" name="scope" value="thread" checked={scope === 'thread'} onChange={() => setScope('thread')} />
              The whole conversation
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="radio" name="scope" value="message" checked={scope === 'message'} onChange={() => setScope('message')} />
              Just this email
            </label>
          </fieldset>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" className="btn" disabled={!dealId || submitting}>
              {submitting ? 'Linking…' : 'Link'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// Two-step flow: ask scope (thread/message), open NewDealModal pre-filled
// with the email subject, then link the just-created deal to the chosen scope.
// Reuses the existing NewDealModal from PipelineView so creation stays a
// single code path.
export function NewDealFromEmailFlow({ target, onClose, onCreated }) {
  const { actions, showMsg } = useStore();
  const [scope, setScope] = useState('thread');
  const [step, setStep] = useState('scope'); // 'scope' → 'deal'
  // Strip Re:/Fwd: prefixes so the suggested deal title is the actual subject.
  const initialTitle = (target?.subject || '').replace(/^(re|fwd?):\s*/i, '').trim();

  if (step === 'scope') {
    return (
      <Modal onClose={onClose}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700 }}>Create deal from this email</h2>
        <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 16px' }}>
          What should be attached to the new deal?
        </p>
        <fieldset style={{ border: 'none', padding: 0, margin: '0 0 18px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 4 }}>
            <input type="radio" name="newdeal-scope" value="thread" checked={scope === 'thread'} onChange={() => setScope('thread')} />
            The whole conversation
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="radio" name="newdeal-scope" value="message" checked={scope === 'message'} onChange={() => setScope('message')} />
            Just this email
          </label>
        </fieldset>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="button" className="btn" onClick={() => setStep('deal')}>Next</button>
        </div>
      </Modal>
    );
  }

  return (
    <NewDealModal
      initialTitle={initialTitle}
      onClose={onClose}
      onCreated={async (deal) => {
        if (!deal?.id) {
          showMsg('Deal created');
          onCreated?.();
          return;
        }
        try {
          await actions.linkEmail({
            threadId: target.threadId,
            gmailMessageId: target.gmailMessageId,
            dealId: deal.id,
            scope,
          });
          showMsg('Linked to ' + (deal.title || 'new deal'));
        } catch (err) {
          showMsg('Deal created, but linking failed: ' + (err?.message || 'unknown'));
        }
        onCreated?.();
      }}
    />
  );
}

export function EmailViewerModal({ gmailMessageId, dealId, onClose }) {
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

function FilesCard({ dealId, files, driveEnabled }) {
  const { actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = React.useRef(null);

  // Drive direct-upload has no serverless body limit; Blob uploads cap at 20 MB.
  const maxBytes = driveEnabled ? 5 * 1024 * 1024 * 1024 : 20 * 1024 * 1024;
  const maxLabel = driveEnabled ? '5 GB' : '20 MB';

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const tooBig = files.find(f => f.size > maxBytes);
    if (tooBig) { showMsg(`"${tooBig.name}" is too large (max ${maxLabel})`); return; }
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
            <div style={{ fontSize: 11, color: BRAND.muted, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span>{fileSizeLabel(f.sizeBytes)}{f.sizeBytes ? ' · ' : ''}{formatRelativeTime(f.createdAt)}{f.source === 'email' ? ' · from email' : ''}</span>
              {f.storage === 'drive' && (
                <span style={{ fontSize: 9, fontWeight: 700, color: '#1D4ED8', background: '#EFF6FF', padding: '1px 5px', borderRadius: 3, textTransform: 'uppercase', letterSpacing: 0.3 }}>Drive</span>
              )}
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

export function CommentThread({ comments, session, replyingTo, editingCommentId, onReply, onCancelReply, onEdit, onCancelEdit, onSubmitEdit, onDelete, onSubmitReply, onReact, dealId }) {
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

export function CommentInput({ users, placeholder = 'Add a comment…', initialBody = '', initialMentions = [], submitLabel = 'Comment', onSubmit, onCancel, autoFocus = false }) {
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

// Drafts the user saved while composing on this deal. Clicking Resume
// loads the snapshot back into the composer; Discard deletes it.
function DealDraftsCard({ drafts, onResume, onDiscard }) {
  return (
    <Card title="Unsent drafts" count={drafts.length}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {drafts.map((d) => {
          // The "preview" line is the subject if we have one, else the
          // first line of the body, else a placeholder.
          const subject = (d.subject || '').trim();
          const bodyFirstLine = (d.body || '').split('\n').find((l) => l.trim()) || '';
          const headline = subject || bodyFirstLine || '(no subject)';
          const sub = subject && bodyFirstLine ? bodyFirstLine : null;
          return (
            <div
              key={d.id}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '8px 10px', border: '1px solid ' + BRAND.border,
                borderRadius: 8, background: '#FFFBF0',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontWeight: 600, fontSize: 13, color: BRAND.ink,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {headline}
                </div>
                {sub && (
                  <div style={{
                    fontSize: 12, color: BRAND.muted, marginTop: 2,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {sub}
                  </div>
                )}
                <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 3 }}>
                  Saved {d.savedAt ? formatRelativeTime(d.savedAt) : 'recently'}
                  {d.to ? ' · to ' + d.to.split(',')[0].trim() : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button type="button" className="btn" onClick={() => onResume(d.id)} style={{ fontSize: 12, padding: '2px 10px' }}>
                  Resume
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    if (window.confirm('Discard this draft?')) onDiscard(d.id);
                  }}
                  style={{ fontSize: 12, padding: '2px 10px' }}
                  aria-label="Discard draft"
                >
                  Discard
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// Pending scheduled emails for this deal — sends queued via the composer's
// "Schedule send" that the scheduled-emails cron will dispatch when their time
// comes. Cancel sets status='cancelled' server-side and drops the row here.
function DealScheduledCard({ scheduled, onCancel }) {
  const fmt = (iso) => {
    try { return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch { return iso; }
  };
  return (
    <Card title="Scheduled emails" count={scheduled.length}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {scheduled.map((s) => {
          const headline = (s.subject || '').trim() || '(no subject)';
          const recipients = Array.isArray(s.to) ? s.to.join(', ') : (s.to || '');
          return (
            <div
              key={s.id}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '8px 10px', border: '1px solid ' + BRAND.border,
                borderRadius: 8, background: '#F0F7FB',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontWeight: 600, fontSize: 13, color: BRAND.ink,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {headline}
                </div>
                {recipients && (
                  <div style={{
                    fontSize: 12, color: BRAND.muted, marginTop: 2,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    To {recipients}
                  </div>
                )}
                <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Clock size={11} /> Sends {fmt(s.scheduledFor)}
                  {s.attachmentCount ? ` · ${s.attachmentCount} attachment${s.attachmentCount > 1 ? 's' : ''}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => { if (window.confirm('Cancel this scheduled email?')) onCancel(s.id); }}
                  style={{ fontSize: 12, padding: '2px 10px' }}
                  aria-label="Cancel scheduled email"
                >
                  Cancel
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function EmailComposerModal({ deal, contact, initialDraft = null, onClose, onSent, inline = false }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const gmailConnected = state.gmailAccount && state.gmailAccount.connected;
  const defaultSubject = deal?.title ? `Re: ${deal.title}` : '';
  // initialDraft (passed when resuming a saved draft) takes precedence over
  // the contact/deal-derived defaults. Each field falls back through:
  //   draft snapshot → deal/contact default → empty
  const [to, setTo] = useState(initialDraft?.to ?? (contact?.email || ''));
  const [cc, setCc] = useState(initialDraft?.cc ?? '');
  const [bcc, setBcc] = useState(initialDraft?.bcc ?? '');
  // Gmail-style: hide Cc + Bcc behind buttons. Once revealed they stay
  // visible for the lifetime of the composer (matches Gmail/Streak).
  const [showCc, setShowCc] = useState(!!initialDraft?.cc);
  const [showBcc, setShowBcc] = useState(!!initialDraft?.bcc);
  // Inline (Gmail-style reply): start with the recipients/subject collapsed to
  // a one-line "to …" summary when we already have a recipient. The dock
  // composer and a recipient-less inline forward stay expanded.
  const [recipientsExpanded, setRecipientsExpanded] = useState(!inline || !(initialDraft?.to));
  const [subject, setSubject] = useState(initialDraft?.subject ?? defaultSubject);
  // body now holds HTML (rich-text editor). Older drafts may carry plain text;
  // RichTextEditor seeds its contentEditable from it either way.
  const [body, setBody] = useState(initialDraft?.body ?? '');
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  // Attachment refs uploaded to the temporary email-attachments blob store.
  // Each: { id, filename, mimeType, sizeBytes, blobUrl?, blobPathname?, uploading?, error? }.
  const [attachments, setAttachments] = useState(initialDraft?.attachments ?? []);
  const fileInputRef = useRef(null);
  // Shared by the body editor and its toolbar (the toolbar sits below the
  // signature but drives this same contentEditable element).
  const editorRef = useRef(null);
  // Scheduled-send popover state.
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [scheduling, setScheduling] = useState(false);
  // Templates popover state.
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const templates = state.emailTemplates || [];
  const teamTemplates = templates.filter(t => t.visibility !== 'private');
  const privateTemplates = templates.filter(t => t.visibility === 'private');
  const [error, setError] = useState('');
  const [signature, setSignature] = useState(null); // null = loading, '' = none
  const [sigDiagnostics, setSigDiagnostics] = useState(null);
  const [refreshingSig, setRefreshingSig] = useState(false);
  const [minimised, setMinimised] = useState(false);
  // Extra deals to file this email against in addition to the deal we're
  // sending from. Stored as {id,title} so the chip can render without
  // another store lookup. Backend attaches them at thread scope post-send.
  const [extraDeals, setExtraDeals] = useState(initialDraft?.extraDeals ?? []);
  const [pickingExtraDeal, setPickingExtraDeal] = useState(false);
  const [creatingExtraDeal, setCreatingExtraDeal] = useState(false);
  // Set when the composer is opened as a reply from the Emails section — keeps
  // the send inside the existing Gmail conversation. null for fresh compose.
  const replyThreadId = initialDraft?.gmailThreadId || null;

  const handleSaveDraft = () => {
    if (savingDraft) return;
    setSavingDraft(true);
    actions.saveDraft({
      dealId: deal?.id || null,
      dealTitle: deal?.title || null,
      contactEmail: contact?.email || null,
      gmailThreadId: replyThreadId || null,
      to, cc, bcc, showCc, showBcc, subject, body, extraDeals,
      // Persist only fully-uploaded attachment refs so a resumed draft can
      // still send them (the blobs live until the email is sent/cancelled).
      attachments: attachments.filter(a => a.blobUrl && !a.uploading),
    });
    showMsg('Draft saved');
    // The store action already closes the composer (clears composerContext);
    // calling onClose too is redundant but harmless if the host happens to
    // be a non-store-driven caller.
    onClose?.();
  };

  // Esc closes the composer — preserves the Modal-era keyboard affordance
  // even though we no longer render through Modal.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!gmailConnected) { setSignature(''); return; }
    let cancelled = false;
    actions.getGmailSignature()
      .then(r => {
        if (cancelled) return;
        setSignature(r?.signatureHtml || '');
        setSigDiagnostics(r?.diagnostics || null);
      })
      .catch((err) => {
        if (cancelled) return;
        // Surface the raw transport error (HTTP status text, network error)
        // so the user sees what actually happened rather than a generic hint.
        setSignature('');
        setSigDiagnostics({
          html: null, summary: [], pickedEmail: null,
          error: { stage: 'transport', message: err?.message || 'Network error', code: null },
        });
      });
    return () => { cancelled = true; };
  }, [gmailConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load saved templates once when the composer opens.
  useEffect(() => {
    actions.loadEmailTemplates();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load a template into the composer. Sets the subject (if the template has
  // one) and replaces the body — pushing the HTML straight into the
  // contentEditable since the editor is uncontrolled.
  const loadTemplate = (t) => {
    if (t.subject) setSubject(t.subject);
    const html = t.bodyHtml || '';
    setBody(html);
    if (editorRef.current) editorRef.current.innerHTML = html;
    setShowTemplates(false);
    showMsg(`Loaded template “${t.name}”`);
  };

  // Save the current subject/body as a new named template, either team-wide
  // ('team') or just for this user ('private').
  const saveAsNewTemplate = async (visibility) => {
    if (templateBusy) return;
    if (!subject.trim() && isHtmlEmpty(body)) { setError('Add a subject or message before saving a template.'); return; }
    const name = window.prompt(visibility === 'private' ? 'Private template name:' : 'Team template name:');
    if (!name || !name.trim()) return;
    setTemplateBusy(true);
    try {
      await actions.saveEmailTemplate({
        name: name.trim(), subject: subject.trim() || null,
        bodyHtml: body, bodyText: htmlToPlainText(body), visibility,
      });
      showMsg(visibility === 'private' ? 'Private template saved' : 'Team template saved');
    } catch (err) {
      setError(err?.message || 'Failed to save template');
    } finally {
      setTemplateBusy(false);
    }
  };

  // Overwrite an existing template with the current subject/body.
  const overwriteTemplate = async (t) => {
    if (templateBusy) return;
    if (!window.confirm(`Overwrite “${t.name}” with the current email?`)) return;
    setTemplateBusy(true);
    try {
      await actions.updateEmailTemplate(t.id, {
        subject: subject.trim() || null,
        bodyHtml: body, bodyText: htmlToPlainText(body),
      });
      showMsg(`Updated template “${t.name}”`);
    } catch (err) {
      setError(err?.message || 'Failed to update template');
    } finally {
      setTemplateBusy(false);
    }
  };

  const removeTemplate = async (t) => {
    if (!window.confirm(`Delete template “${t.name}”?`)) return;
    try {
      await actions.deleteEmailTemplate(t.id);
    } catch (err) {
      setError(err?.message || 'Failed to delete template');
    }
  };

  const refreshSignature = async () => {
    if (refreshingSig) return;
    setRefreshingSig(true);
    try {
      const r = await actions.refreshGmailSignature();
      setSignature(r?.signatureHtml || '');
      setSigDiagnostics(r?.diagnostics || null);
    } catch (err) {
      setSignature('');
      setSigDiagnostics({
        html: null, summary: [], pickedEmail: null,
        error: { stage: 'transport', message: err?.message || 'Network error', code: null },
      });
    } finally {
      setRefreshingSig(false);
    }
  };

  const sanitizedSignature = useMemo(() => {
    if (!signature) return null;
    return DOMPurify.sanitize(signature, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    });
  }, [signature]);

  // The body editor holds HTML; treat a tags-only / whitespace value as empty
  // for the disabled-button guards and the can't-send check.
  const bodyEmpty = isHtmlEmpty(body);
  const uploadedBytes = attachments.reduce((n, a) => n + (a.sizeBytes || 0), 0);
  const anyUploading = attachments.some(a => a.uploading);

  // Upload picked files to the temporary blob store, enforcing the 20 MB
  // running total. Each shows as a chip with a spinner until its ref lands.
  const handleFilesSelected = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let running = uploadedBytes + attachments.filter(a => a.uploading).reduce((n, a) => n + (a.sizeBytes || 0), 0);
    for (const file of files) {
      if (running + file.size > EMAIL_ATTACH_MAX_BYTES) {
        setError('Attachments exceed the 20 MB total limit.');
        continue;
      }
      running += file.size;
      const tempId = 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      setAttachments(prev => [...prev, { id: tempId, filename: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, uploading: true }]);
      try {
        const ref = await actions.uploadEmailAttachment(file);
        setAttachments(prev => prev.map(a => a.id === tempId ? { ...a, ...ref, uploading: false } : a));
      } catch (err) {
        setAttachments(prev => prev.map(a => a.id === tempId ? { ...a, uploading: false, error: err?.message || 'Upload failed' } : a));
      }
    }
  };

  const removeAttachment = (att) => {
    setAttachments(prev => prev.filter(a => a.id !== att.id));
    if (att.blobPathname) actions.deleteEmailAttachment(att.blobPathname);
  };

  // Shared payload for both immediate send and scheduled send. Cc/Bcc only
  // included if the user has the field visible (lets them type, hide, exclude).
  const buildPayload = () => ({
    to: to.split(',').map(s => s.trim()).filter(Boolean),
    cc: (showCc && cc) ? cc.split(',').map(s => s.trim()).filter(Boolean) : [],
    bcc: (showBcc && bcc) ? bcc.split(',').map(s => s.trim()).filter(Boolean) : [],
    subject: subject.trim(),
    html: sanitizeEmailHtml(body),
    text: htmlToPlainText(body),
    dealId: deal?.id || null,
    gmailThreadId: replyThreadId || undefined,
    extraDealIds: extraDeals.map(d => d.id),
    attachments: attachments
      .filter(a => a.blobUrl && !a.uploading)
      .map(a => ({ blobUrl: a.blobUrl, blobPathname: a.blobPathname, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
  });

  const submit = async (e) => {
    e.preventDefault();
    if (!to.trim() || !subject.trim() || bodyEmpty || sending || anyUploading) return;
    setError('');
    setSending(true);
    try {
      const resp = await actions.sendGmail(buildPayload());
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

  const handleSchedule = async () => {
    if (!to.trim() || !subject.trim() || bodyEmpty || scheduling || anyUploading) return;
    const when = scheduleAt ? new Date(scheduleAt) : null;
    if (!when || isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      setError('Pick a send time in the future.');
      return;
    }
    setError('');
    setScheduling(true);
    try {
      await actions.scheduleGmail({ ...buildPayload(), scheduledFor: when.toISOString() });
      if (deal?.id) actions.loadScheduledEmails(deal.id);
      showMsg('Email scheduled for ' + when.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }));
      setShowSchedule(false);
      onClose?.();
    } catch (err) {
      setError(err?.message || 'Failed to schedule');
    } finally {
      setScheduling(false);
    }
  };

  // Gmail-style compose dock. Anchored to the bottom-right of the viewport
  // so the user can keep the deal page interactive while drafting. On mobile
  // we still take the full width, since a 520px dock would overflow.
  const dockWidth = isMobile ? '100%' : 560;
  const dockRight = isMobile ? 0 : 24;
  const dockBottom = isMobile ? 0 : 0;
  // Inline mode (used by the Emails thread view) renders the composer in normal
  // flow at the foot of the conversation, Gmail-style. The default dock mode is
  // a fixed, minimisable bottom-right panel.
  const wrapStyle = inline
    ? {
        position: 'relative', width: '100%', background: 'white',
        border: '1px solid ' + BRAND.border, borderRadius: 10,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }
    : {
        position: 'fixed', right: dockRight, bottom: dockBottom, width: dockWidth, maxWidth: '100vw',
        background: 'white', border: '1px solid ' + BRAND.border,
        borderTopLeftRadius: 10, borderTopRightRadius: 10,
        boxShadow: '0 12px 32px rgba(15, 42, 61, 0.24)', zIndex: 2000,
        display: 'flex', flexDirection: 'column', maxHeight: minimised ? 44 : '80vh', overflow: 'hidden',
      };
  const collapsed = !inline && minimised;
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Send email"
      style={wrapStyle}
    >
      <div
        onClick={inline ? undefined : () => setMinimised((m) => !m)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: '#0F2A3D',
          color: 'white',
          padding: '8px 12px',
          fontSize: 13,
          fontWeight: 600,
          cursor: inline ? 'default' : 'pointer',
          flexShrink: 0,
        }}
      >
        <span>{subject.trim() ? subject : 'New message'}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {!inline && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setMinimised((m) => !m); }}
              aria-label={minimised ? 'Expand' : 'Minimise'}
              style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', padding: 2, lineHeight: 1, fontSize: 16 }}
            >
              {minimised ? '▴' : '▾'}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', padding: 2, lineHeight: 1 }}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      {!collapsed && (
        // Flex column so the inner scroll region can grow and shrink while
        // the action-buttons row stays pinned at the bottom of the dock.
        // The form's onSubmit fires for either Send or Enter inside an input,
        // so the buttons need to be inside the <form> — keeping them inside
        // the same form, but in a separate flex-shrink:0 footer below the
        // scrollable region.
        <form
          onSubmit={submit}
          style={inline ? { display: 'flex', flexDirection: 'column' } : { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        >
          <div style={inline ? { padding: 14 } : { flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
          {!gmailConnected && (
            <div style={{ background: '#FEF3C7', color: '#92400E', fontSize: 13, padding: '10px 12px', borderRadius: 6, marginBottom: 12 }}>
              Gmail isn't connected for your account yet. Connect it from Account → Gmail integration before sending.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {inline && !recipientsExpanded ? (
              // Collapsed Gmail-style recipients line. Click to expand the full
              // To/Cc/Bcc fields; the Cc/Bcc buttons expand straight to that field.
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid ' + BRAND.border, paddingBottom: 8 }}>
                <button
                  type="button"
                  onClick={() => setRecipientsExpanded(true)}
                  style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: BRAND.ink, textAlign: 'left', padding: '2px 0' }}
                >
                  <span style={{ color: BRAND.muted }}>to</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {[to, (showCc && cc) ? cc : ''].filter(Boolean).join(', ') || '(no recipient)'}
                  </span>
                  <span style={{ flexShrink: 0, opacity: 0.6 }}>▾</span>
                </button>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button type="button" onClick={() => { setShowCc(true); setRecipientsExpanded(true); }} className="btn-ghost" style={{ fontSize: 11, padding: '0 8px' }}>Cc</button>
                  <button type="button" onClick={() => { setShowBcc(true); setRecipientsExpanded(true); }} className="btn-ghost" style={{ fontSize: 11, padding: '0 8px' }}>Bcc</button>
                </div>
              </div>
            ) : (
              <>
                <FormRow label="To">
                  <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <RecipientInput
                        value={to}
                        onChange={setTo}
                        placeholder="name@example.com"
                        autoFocus
                        required
                      />
                    </div>
                    {/* Gmail-style: Cc/Bcc start hidden, revealed by a small
                        toggle next to the To field. Stays visible when on so
                        the user can click again to hide. Selected state gets
                        a tinted background to read as a pill toggle. */}
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <button
                        type="button"
                        onClick={() => setShowCc((s) => !s)}
                        aria-pressed={showCc}
                        aria-label={showCc ? 'Hide Cc' : 'Add Cc'}
                        className={showCc ? 'btn' : 'btn-ghost'}
                        style={{ fontSize: 11, padding: '0 8px' }}
                      >
                        Cc
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowBcc((s) => !s)}
                        aria-pressed={showBcc}
                        aria-label={showBcc ? 'Hide Bcc' : 'Add Bcc'}
                        className={showBcc ? 'btn' : 'btn-ghost'}
                        style={{ fontSize: 11, padding: '0 8px' }}
                      >
                        Bcc
                      </button>
                    </div>
                  </div>
                </FormRow>
                {showCc && (
                  <FormRow label="Cc">
                    <RecipientInput value={cc} onChange={setCc} placeholder="comma,separated@example.com" />
                  </FormRow>
                )}
                {showBcc && (
                  <FormRow label="Bcc">
                    <RecipientInput value={bcc} onChange={setBcc} placeholder="comma,separated@example.com" />
                  </FormRow>
                )}
                {/* Inline replies keep the subject fixed (Re: …) like Gmail, so
                    the subject field only shows in the full dock composer. */}
                {!inline && (
                  <FormRow label="Subject">
                    <input className="input" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} required />
                  </FormRow>
                )}
              </>
            )}
            {/* Message field is NOT wrapped in FormRow's <label> on purpose:
                that label carries font-weight:500, and Grammarly drops the
                editor's inline weight when it instruments the field, so the
                text would fall back to that inherited 500 and look bold. By
                keeping the weight on the label text only, the editor's
                inherited baseline stays a normal 400. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>Message</span>
              <div
                style={{
                  border: '1px solid ' + BRAND.border,
                  borderRadius: 6,
                  background: 'white',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                <RichTextEditor editorRef={editorRef} initialHtml={body} onChange={setBody} />
                {gmailConnected && (
                  <div style={{ padding: '8px 12px 12px', borderTop: '1px dashed ' + BRAND.border, fontSize: 13 }}>
                    {signature === null && (
                      <div style={{ color: BRAND.muted, fontStyle: 'italic', fontSize: 12 }}>Loading signature…</div>
                    )}
                    {signature === '' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <SignatureEmptyHint diagnostics={sigDiagnostics} />
                        <div>
                          <button
                            type="button"
                            onClick={refreshSignature}
                            disabled={refreshingSig}
                            className="btn-ghost"
                            style={{ fontSize: 11, padding: '2px 8px' }}
                          >
                            {refreshingSig ? 'Refreshing…' : 'Refresh from Gmail'}
                          </button>
                        </div>
                      </div>
                    )}
                    {sanitizedSignature && (
                      <div
                        className="email-body"
                        // Cap the in-composer signature preview so a long
                        // image-heavy signature (banner + legal footer)
                        // doesn't push Send/Save buttons below the viewport.
                        // Scrolls within its own box; full signature still
                        // gets appended to the actual send.
                        style={{
                          fontSize: 12, lineHeight: 1.4, color: BRAND.ink,
                          wordBreak: 'break-word', maxHeight: 90, overflowY: 'auto',
                        }}
                        dangerouslySetInnerHTML={{ __html: sanitizedSignature }}
                      />
                    )}
                  </div>
                )}
                {/* Formatting + attach toolbar, Gmail-style: below the body and
                    signature so it sits just above the send controls. */}
                <RichTextToolbar
                  editorRef={editorRef}
                  onChange={setBody}
                  onAttach={() => fileInputRef.current && fileInputRef.current.click()}
                />
              </div>
            </div>
            {/* Attachments: hidden file input (opened from the toolbar's attach
                button); each picked
                file uploads to a temporary blob and shows as a chip until it's
                embedded into the message at send (or scheduled-send) time. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => { handleFilesSelected(e.target.files); e.target.value = ''; }}
              />
              {attachments.length > 0 && (
                <span style={{ fontSize: 11, color: BRAND.muted }}>
                  Attachments · {fileSizeLabel(uploadedBytes)} / 20 MB
                </span>
              )}
              {attachments.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {attachments.map((a) => (
                    <span
                      key={a.id}
                      title={a.error || a.filename}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
                        fontSize: 12, color: a.error ? '#991B1B' : BRAND.ink,
                        background: a.error ? '#FEE2E2' : '#EEF3F6',
                        border: '1px solid ' + (a.error ? '#FCA5A5' : BRAND.border),
                        padding: '3px 4px 3px 9px', borderRadius: 999,
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
                        {a.uploading ? 'Uploading… ' : ''}{a.filename}
                      </span>
                      <span style={{ color: BRAND.muted, flexShrink: 0 }}>{fileSizeLabel(a.sizeBytes)}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(a)}
                        aria-label={`Remove ${a.filename}`}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, color: BRAND.muted, display: 'flex', flexShrink: 0 }}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            {/* Deal-link summary: shows the primary deal as a static chip
                plus any extras the user added (removable). The two buttons
                below open the picker / create-deal flows; backend attaches
                the extras at thread scope when the message is sent. */}
            <div style={{
              fontSize: 12, color: BRAND.muted, display: 'flex', flexDirection: 'column', gap: 6,
              padding: '8px 10px', background: '#FAFBFC', border: '1px solid ' + BRAND.border, borderRadius: 6,
            }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                <span>Auto-linked to:</span>
                <span style={{
                  fontSize: 11, fontWeight: 600, color: BRAND.ink, background: '#E5EFF5',
                  padding: '2px 8px', borderRadius: 999,
                }}>
                  {deal?.title || 'this deal'}
                </span>
                {extraDeals.map(d => (
                  <span
                    key={d.id}
                    style={{
                      fontSize: 11, fontWeight: 600, color: BRAND.ink, background: '#E5EFF5',
                      padding: '2px 4px 2px 8px', borderRadius: 999, display: 'inline-flex',
                      alignItems: 'center', gap: 4,
                    }}
                  >
                    {d.title}
                    <button
                      type="button"
                      onClick={() => setExtraDeals(prev => prev.filter(x => x.id !== d.id))}
                      aria-label={`Remove ${d.title}`}
                      style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        padding: 0, lineHeight: 1, color: BRAND.muted, display: 'flex',
                      }}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => setPickingExtraDeal(true)}
                >
                  + Add to another deal
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => setCreatingExtraDeal(true)}
                >
                  + Create new deal
                </button>
              </div>
            </div>
            {error && (
              <div style={{ background: '#FEE2E2', color: '#991B1B', fontSize: 13, padding: '8px 10px', borderRadius: 6 }}>
                {error}
              </div>
            )}
            <div style={{ fontSize: 11, color: BRAND.muted, lineHeight: 1.45 }}>
              Sent from {state.gmailAccount?.gmailAddress || 'your connected Gmail'} via the Gmail API.
            </div>
          </div>
          </div>
          {/* Pinned action footer — sits below the scrolling body so the
              Discard / Save as draft / Send buttons stay visible no matter
              how tall the form (or the signature preview) gets. */}
          <div
            style={{
              flexShrink: 0, position: 'relative',
              display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center',
              padding: '10px 14px', borderTop: '1px solid ' + BRAND.border,
              background: 'white',
            }}
          >
            {/* Templates menu, pushed to the left so it reads as a separate
                control from the Discard/Save/Send actions. */}
            <button
              type="button"
              onClick={() => { setShowSchedule(false); setShowTemplates((v) => !v); }}
              className="btn-ghost"
              style={{ marginRight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              aria-expanded={showTemplates}
              title="Insert or save an email template"
            >
              <FileText size={14} /> Templates
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">Discard</button>
            <button
              type="button"
              onClick={handleSaveDraft}
              className="btn-ghost"
              disabled={savingDraft || (!to.trim() && !subject.trim() && bodyEmpty)}
              title="Stash this email in the drafts list and close the composer"
            >
              Save as draft
            </button>
            {/* Split Send button: the main half sends now, the ▾ half opens a
                popover to schedule the send for later. */}
            <div style={{ display: 'flex' }}>
              <button
                type="submit"
                className="btn"
                disabled={!gmailConnected || sending || anyUploading || !to.trim() || !subject.trim() || bodyEmpty}
                style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setShowSchedule((v) => {
                    if (!v && !scheduleAt) setScheduleAt(defaultScheduleValue());
                    return !v;
                  });
                }}
                disabled={!gmailConnected || sending || anyUploading || !to.trim() || !subject.trim() || bodyEmpty}
                aria-label="Schedule send"
                title="Schedule send"
                style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: '1px solid rgba(255,255,255,0.35)', padding: '0 8px', display: 'inline-flex', alignItems: 'center', gap: 3 }}
              >
                <Clock size={14} /> ▾
              </button>
            </div>
            {showSchedule && (
              <div
                style={{
                  position: 'absolute', right: 14, bottom: 'calc(100% + 6px)',
                  background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8,
                  boxShadow: '0 8px 24px rgba(15,42,61,0.18)', padding: 12, width: 260, zIndex: 10,
                  display: 'flex', flexDirection: 'column', gap: 8,
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: BRAND.ink }}>Schedule send</div>
                <input
                  className="input"
                  type="datetime-local"
                  value={scheduleAt}
                  min={defaultScheduleValueNow()}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  style={{ fontSize: 13 }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                  <button type="button" className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowSchedule(false)}>
                    Cancel
                  </button>
                  <button type="button" className="btn" style={{ fontSize: 12 }} disabled={scheduling || !scheduleAt} onClick={handleSchedule}>
                    {scheduling ? 'Scheduling…' : 'Schedule'}
                  </button>
                </div>
              </div>
            )}
            {showTemplates && (
              <div
                style={{
                  position: 'absolute', left: 14, bottom: 'calc(100% + 6px)',
                  background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8,
                  boxShadow: '0 8px 24px rgba(15,42,61,0.18)', padding: 10, width: 300, zIndex: 10,
                  display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: BRAND.ink }}>Templates</div>
                  <button type="button" onClick={() => setShowTemplates(false)} aria-label="Close templates" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: BRAND.muted, display: 'flex', padding: 2 }}>
                    <X size={14} />
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
                  {templates.length === 0 && (
                    <div style={{ fontSize: 12, color: BRAND.muted, fontStyle: 'italic', padding: '4px 2px' }}>
                      No saved templates yet. Compose an email, then save it as a team or private template below.
                    </div>
                  )}
                  {[
                    { key: 'team', label: 'Team templates', list: teamTemplates },
                    { key: 'private', label: 'My private templates', list: privateTemplates },
                  ].filter(g => g.list.length > 0).map((g) => (
                    <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: BRAND.muted }}>
                        {g.label}
                      </div>
                      {g.list.map((t) => (
                        <div
                          key={t.id}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 4,
                            border: '1px solid ' + BRAND.border, borderRadius: 6, padding: '4px 4px 4px 8px',
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => loadTemplate(t)}
                            title="Load this template into the email"
                            style={{
                              flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none',
                              cursor: 'pointer', color: BRAND.ink, fontSize: 13, padding: '2px 0',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}
                          >
                            {t.name}
                          </button>
                          <button
                            type="button"
                            onClick={() => overwriteTemplate(t)}
                            disabled={templateBusy}
                            title="Overwrite with the current email"
                            className="btn-ghost"
                            style={{ fontSize: 11, padding: '2px 8px', flexShrink: 0 }}
                          >
                            Overwrite
                          </button>
                          <button
                            type="button"
                            onClick={() => removeTemplate(t)}
                            aria-label={`Delete ${t.name}`}
                            title="Delete template"
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: BRAND.muted, display: 'flex', padding: 2, flexShrink: 0 }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                <div style={{ borderTop: '1px solid ' + BRAND.border, paddingTop: 8, display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => saveAsNewTemplate('team')}
                    disabled={templateBusy}
                    style={{ fontSize: 12, flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                    title="Save the current email as a team-wide template"
                  >
                    <Plus size={13} /> Save as team
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => saveAsNewTemplate('private')}
                    disabled={templateBusy}
                    style={{ fontSize: 12, flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                    title="Save the current email as a private template only you can see"
                  >
                    <Plus size={13} /> Save as private
                  </button>
                </div>
              </div>
            )}
          </div>
        </form>
      )}
      {pickingExtraDeal && (
        <ComposerExtraDealPicker
          currentDealId={deal?.id || null}
          excludeIds={[deal?.id, ...extraDeals.map(d => d.id)].filter(Boolean)}
          onClose={() => setPickingExtraDeal(false)}
          onPicked={(picked) => {
            setExtraDeals(prev => prev.some(d => d.id === picked.id) ? prev : [...prev, picked]);
            setPickingExtraDeal(false);
          }}
        />
      )}
      {creatingExtraDeal && (
        <NewDealModal
          initialTitle={(subject || '').replace(/^(re|fwd?):\s*/i, '').trim()}
          onClose={() => setCreatingExtraDeal(false)}
          onCreated={(newDeal) => {
            if (newDeal?.id) {
              setExtraDeals(prev => prev.some(d => d.id === newDeal.id) ? prev : [...prev, { id: newDeal.id, title: newDeal.title }]);
            }
            setCreatingExtraDeal(false);
          }}
        />
      )}
    </div>
  );
}

// Email-recipient input with CRM contact typeahead. Wraps a plain <input>
// (comma-separated emails) with a popup that suggests up to 6 contacts as
// the user types. Pattern mirrors XeroContactPicker but filters synchronously
// against state.contacts since the list is already in memory and small
// enough to scan on every keystroke.
//
// The popup is caret-aware: the "current token" is the substring between
// the last comma before the caret and the caret itself. Picking a suggestion
// replaces just that token with `<email>, `, leaving any earlier or later
// tokens intact and parking the caret ready for the next address.
function RecipientInput({ value, onChange, placeholder, autoFocus, required }) {
  const { state } = useStore();
  const inputRef = useRef(null);
  const wrapperRef = useRef(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  // Already-included emails (lowercased) so we don't suggest somebody twice.
  const includedEmails = useMemo(() => {
    return new Set(
      (value || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
  }, [value]);

  // Locate the boundaries of the current token around `caret`.
  const tokenBounds = useMemo(() => {
    const v = value || '';
    let start = caret;
    while (start > 0 && v[start - 1] !== ',') start--;
    let end = caret;
    while (end < v.length && v[end] !== ',') end++;
    return { start, end };
  }, [value, caret]);
  const currentToken = (value || '').slice(tokenBounds.start, tokenBounds.end).trim();

  // Filter contacts. Empty token (just inserted, or empty field) → no popup.
  // Matches against name, email, AND the contact's company name (looked up
  // via state.companies), so typing "acme" surfaces every contact attached
  // to that company even if the contact's own name doesn't contain it.
  const suggestions = useMemo(() => {
    if (!focused) return [];
    const q = currentToken.toLowerCase();
    if (!q) return [];
    const out = [];
    for (const c of Object.values(state.contacts || {})) {
      if (!c?.email) continue;
      const emailLower = c.email.toLowerCase();
      if (includedEmails.has(emailLower)) continue;
      const nameLower = (c.name || '').toLowerCase();
      const companyName = c.companyId ? (state.companies?.[c.companyId]?.name || '') : '';
      const companyLower = companyName.toLowerCase();
      const nameHit = nameLower.includes(q);
      const emailHit = emailLower.includes(q);
      const companyHit = companyLower.includes(q);
      if (!nameHit && !emailHit && !companyHit) continue;
      // Score so prefix-matches outrank substring-matches, and within each
      // tier name > company > email. Substring tier interleaves company
      // above email-substring because a company match feels more relevant
      // than an email's local-part containing the token.
      let score = 0;
      if (nameLower.startsWith(q)) score = 6;
      else if (companyLower.startsWith(q)) score = 5;
      else if (emailLower.startsWith(q)) score = 4;
      else if (nameHit) score = 3;
      else if (companyHit) score = 2;
      else score = 1;
      out.push({ contact: c, score });
    }
    out.sort((a, b) => b.score - a.score || (a.contact.name || a.contact.email).localeCompare(b.contact.name || b.contact.email));
    return out.slice(0, 6).map((r) => r.contact);
  }, [state.contacts, state.companies, focused, currentToken, includedEmails]);

  // Clamp active row when suggestions list changes.
  useEffect(() => {
    if (activeIdx >= suggestions.length) setActiveIdx(0);
  }, [suggestions.length, activeIdx]);

  const updateCaretFromEvent = (e) => {
    const pos = e.target.selectionStart;
    if (typeof pos === 'number') setCaret(pos);
  };

  const handleChange = (e) => {
    onChange(e.target.value);
    updateCaretFromEvent(e);
  };

  // Replace currentToken with `<email>, ` and reposition the caret.
  const commit = (contact) => {
    if (!contact?.email) return;
    const v = value || '';
    const before = v.slice(0, tokenBounds.start);
    const after = v.slice(tokenBounds.end);
    // If `before` doesn't already end with ", " (which it would for tokens
    // after the first), keep it as-is. We always emit ", " *after* the
    // inserted address so the caret is parked for the next one.
    const insert = contact.email + ', ';
    const next = before + insert + after.replace(/^[ ,]+/, '');
    onChange(next);
    const newCaret = (before + insert).length;
    setActiveIdx(0);
    // Wait for the controlled value to flush, then move the caret.
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.setSelectionRange(newCaret, newCaret);
        setCaret(newCaret);
        inputRef.current.focus();
      }
    });
  };

  const handleKeyDown = (e) => {
    if (!suggestions.length) {
      // No popup → don't trap any keys. Track caret on any movement.
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        setTimeout(() => updateCaretFromEvent(e), 0);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      commit(suggestions[activeIdx]);
    } else if (e.key === ',') {
      // Allow comma to commit the current highlight rather than break the token.
      e.preventDefault();
      commit(suggestions[activeIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setFocused(false);
    }
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%' }}>
      <input
        ref={inputRef}
        className="input"
        type="text"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        required={required}
        onChange={handleChange}
        onKeyUp={updateCaretFromEvent}
        onClick={updateCaretFromEvent}
        onKeyDown={handleKeyDown}
        onFocus={(e) => { setFocused(true); updateCaretFromEvent(e); }}
        // Delay the close so a click on the popup still registers before the
        // blur tears it down. mousedown on a row would otherwise miss.
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        style={{ width: '100%' }}
        autoComplete="off"
      />
      {focused && suggestions.length > 0 && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2,
            background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8,
            boxShadow: '0 8px 20px rgba(15,42,61,0.15)', zIndex: 10, padding: 4,
            maxHeight: 280, overflowY: 'auto',
          }}
        >
          {suggestions.map((c, i) => {
            const companyName = c.companyId ? state.companies?.[c.companyId]?.name : null;
            const active = i === activeIdx;
            return (
              <div
                key={c.id}
                role="option"
                aria-selected={active}
                onMouseDown={(e) => { e.preventDefault(); commit(c); }}
                onMouseEnter={() => setActiveIdx(i)}
                style={{
                  padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                  background: active ? '#F1F4F7' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 13 }}>
                  <span style={{ fontWeight: 600, color: BRAND.ink }}>
                    {c.name || <span style={{ fontStyle: 'italic', color: BRAND.muted }}>(no name)</span>}
                  </span>
                  <span style={{ color: BRAND.muted, fontSize: 12 }}>{c.email}</span>
                </div>
                {companyName && (
                  <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 1 }}>{companyName}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Lightweight picker used by the composer's "Add to another deal" button.
// Same shape as LinkEmailModal but without the scope radio — new outbound
// emails always link at thread scope (the message doesn't exist yet so
// "just this email" doesn't apply meaningfully).
function ComposerExtraDealPicker({ currentDealId, excludeIds, onClose, onPicked }) {
  const { state } = useStore();
  const exclude = new Set(excludeIds || []);
  const candidates = useMemo(() => {
    return Object.values(state.deals || {})
      .filter((d) => d && !exclude.has(d.id) && d.stage !== 'lost' && d.stage !== 'won')
      .sort((a, b) => {
        const ta = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
        const tb = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
        return tb - ta;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.deals, currentDealId, excludeIds.join(',')]);
  const [dealId, setDealId] = useState(candidates[0]?.id || '');

  return (
    <Modal onClose={onClose}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>Add to another deal</h2>
      {candidates.length === 0 ? (
        <>
          <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 16px' }}>
            No other open deals to link to. Use <strong>Create new deal</strong> instead.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} className="btn-ghost">Close</button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const picked = candidates.find(d => d.id === dealId);
            if (picked) onPicked({ id: picked.id, title: picked.title });
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <label style={{ fontSize: 13, fontWeight: 500 }}>
            Deal
            <select className="input" value={dealId} onChange={(e) => setDealId(e.target.value)} style={{ marginTop: 4 }} required>
              {candidates.map((d) => (
                <option key={d.id} value={d.id}>{d.title}</option>
              ))}
            </select>
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" className="btn" disabled={!dealId}>Add</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// Renders a helpful explanation when Gmail's sendAs.list comes back without
// a usable signature. The diagnostic from the server has enough detail to
// distinguish the three real failure modes — bad scope, signature lives on
// an admin-imposed footer, or genuinely no signature configured — instead
// of the old vague "set one in Gmail and reconnect".
function SignatureEmptyHint({ diagnostics }) {
  const baseStyle = { fontSize: 12, color: BRAND.muted, fontStyle: 'italic', lineHeight: 1.5 };
  if (!diagnostics) {
    // No diagnostics → the GET to /api/crm/gmail/signature errored before
    // we got a structured response (network blip, 5xx, JSON parse). Tell the
    // user to retry rather than blaming Gmail config — the latter would be
    // misleading if the problem is on our side.
    return (
      <div style={baseStyle}>
        Couldn't reach the signature sync just now. Click <strong>Refresh from Gmail</strong> to try again.
      </div>
    );
  }
  if (diagnostics.error) {
    const e = diagnostics.error;
    const label = e.stage === 'token'
      ? 'authentication'
      : e.stage === 'unexpected'
        ? 'unexpected server error'
        : e.stage === 'transport'
          ? 'connection error'
          : e.stage === 'disconnected'
            ? 'Gmail not connected'
            : `Gmail API ${e.status || 'error'}`;
    const detail = e.message ? ` — ${e.message}` : '';
    return (
      <div style={baseStyle}>
        Couldn't read your Gmail signature ({label}{detail}).
        {' '}Try <strong>Refresh from Gmail</strong> again, or reconnect Gmail from Account → Gmail integration if this keeps happening.
      </div>
    );
  }
  const summary = Array.isArray(diagnostics.summary) ? diagnostics.summary : [];
  if (!summary.length) {
    return (
      <div style={baseStyle}>
        Gmail returned no sendAs identities. Reconnect Gmail to refresh the
        granted scopes.
      </div>
    );
  }
  const anyHas = summary.some((s) => s.hasSig);
  if (anyHas) {
    return (
      <div style={baseStyle}>
        Gmail has signatures on {summary.filter((s) => s.hasSig).map((s) => s.email).join(', ')},
        but none could be picked. Try <strong>Refresh from Gmail</strong>.
      </div>
    );
  }
  return (
    <div style={baseStyle}>
      No signature is configured in Gmail for {summary.map((s) => s.email).join(', ')}.
      Set one in Gmail (Settings → General → Signature), then click <strong>Refresh from Gmail</strong>.
    </div>
  );
}

// 20 MB total attachment cap — matches the deal-file cap and stays under
// Gmail's 25 MB message limit once base64 inflates the payload ~33%.
const EMAIL_ATTACH_MAX_BYTES = 20 * 1024 * 1024;

// Tags the rich-text toolbar can produce. Anything else (scripts, styles,
// inline event handlers) is stripped before the HTML leaves the browser.
const EMAIL_HTML_SANITIZE = {
  ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'p', 'br', 'span', 'div'],
  ALLOWED_ATTR: ['href', 'target', 'rel'],
};

function sanitizeEmailHtml(html) {
  const clean = DOMPurify.sanitize(html || '', EMAIL_HTML_SANITIZE);
  // Wrap so recipients get a sensible default font/size/colour even if the
  // body has no block wrapper of its own.
  return '<div style="font-family:-apple-system,system-ui,sans-serif;font-size:14px;line-height:1.6;color:#0F2A3D;">'
    + clean + '</div>';
}

// Plain-text fallback for the multipart/alternative text part: turn block ends
// and <br> into newlines, strip the rest, decode entities.
function htmlToPlainText(html) {
  if (!html) return '';
  const withBreaks = String(html)
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const ta = document.createElement('textarea');
  ta.innerHTML = withBreaks;
  return ta.value.replace(/\n{3,}/g, '\n\n').trim();
}

function isHtmlEmpty(html) {
  if (!html) return true;
  const stripped = String(html).replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, '').replace(/\s/g, '');
  return stripped.length === 0;
}

// Format a Date as the value a <input type="datetime-local"> expects (local
// time, no timezone, minute precision): "YYYY-MM-DDTHH:mm".
function toDatetimeLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Default the picker to one hour from now; min is the current minute.
function defaultScheduleValue() { return toDatetimeLocal(new Date(Date.now() + 60 * 60 * 1000)); }
function defaultScheduleValueNow() { return toDatetimeLocal(new Date()); }

// Rich-text body editor (just the editable area). Uncontrolled — the DOM owns
// the HTML; we seed it once and report changes up via onChange so cursor
// position is never disturbed by re-renders. The formatting controls live in
// RichTextToolbar (rendered separately, below the signature) and act on this
// same editorRef.
function RichTextEditor({ editorRef, initialHtml, onChange }) {
  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = initialHtml || '';
    // Seed once on mount; remounts (new draft) come with a fresh key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={editorRef}
      contentEditable
      suppressContentEditableWarning
      onInput={() => editorRef.current && onChange(editorRef.current.innerHTML)}
      className="email-body"
      style={{
        // Match the To/Subject inputs: same font stack and normal weight.
        // Without an explicit weight the editor inherits the FormRow <label>'s
        // font-weight:500, which made typed text look bold.
        outline: 'none', padding: '10px 12px',
        fontFamily: '-apple-system, system-ui, sans-serif', fontSize: 14, fontWeight: 400,
        lineHeight: 1.5, minHeight: 120, maxHeight: 280, overflowY: 'auto',
        color: BRAND.ink, background: 'transparent',
      }}
    />
  );
}

// Formatting toolbar driven by document.execCommand (deprecated but universally
// supported and dependency-free), plus the attach-files button. Acts on the
// shared editorRef. Rendered at the bottom of the message box, below the
// signature (Gmail-style).
function RichTextToolbar({ editorRef, onChange, onAttach }) {
  const emit = () => { if (editorRef.current) onChange(editorRef.current.innerHTML); };
  const exec = (cmd, val = null) => {
    document.execCommand(cmd, false, val);
    if (editorRef.current) editorRef.current.focus();
    emit();
  };
  const addLink = () => {
    const url = window.prompt('Link URL (include https://):', 'https://');
    if (url && url !== 'https://') exec('createLink', url);
  };
  const toolBtn = {
    background: 'transparent', border: '1px solid transparent', borderRadius: 4,
    cursor: 'pointer', color: BRAND.ink, fontSize: 13, lineHeight: 1,
    padding: '4px 7px', minWidth: 28,
  };
  const Btn = ({ cmd, onClick, title, children }) => (
    <button
      type="button"
      title={title}
      // preventDefault on mousedown so clicking the toolbar doesn't blur the
      // editor and lose the current selection before execCommand runs.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick || (() => exec(cmd))}
      style={toolBtn}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#EEF3F6'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
  return (
    <div style={{
      display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center',
      padding: '4px 6px', borderTop: '1px solid ' + BRAND.border, background: '#FAFBFC',
    }}>
      <Btn cmd="bold" title="Bold"><strong>B</strong></Btn>
      <Btn cmd="italic" title="Italic"><em>I</em></Btn>
      <Btn cmd="underline" title="Underline"><span style={{ textDecoration: 'underline' }}>U</span></Btn>
      <span style={{ width: 1, alignSelf: 'stretch', background: BRAND.border, margin: '2px 4px' }} />
      <Btn cmd="insertUnorderedList" title="Bulleted list">• —</Btn>
      <Btn cmd="insertOrderedList" title="Numbered list">1.</Btn>
      <span style={{ width: 1, alignSelf: 'stretch', background: BRAND.border, margin: '2px 4px' }} />
      <Btn onClick={onAttach} title="Attach files">📎</Btn>
      <Btn onClick={addLink} title="Insert link">🔗</Btn>
      <Btn onClick={() => exec('removeFormat')} title="Clear formatting">⨯</Btn>
    </div>
  );
}

// Thin wrapper that lets App.jsx mount the composer at the top of the tree
// so it survives CRM navigation. Reads `state.composerContext` (set by
// `actions.openComposer`) and renders the same EmailComposerModal that
// used to live inside DealDetailView. Returns null when the composer is
// closed — the host stays cheap.
export function EmailComposerHost() {
  const { state, actions } = useStore();
  const ctx = state.composerContext;
  if (!ctx) return null;
  // If the deal is in state.deals we hand it through (lets the composer
  // pick up live updates like a stage change). Otherwise synthesise a
  // minimal stub from the saved context so a deleted-deal draft still
  // renders without crashing.
  const deal = (ctx.dealId && state.deals[ctx.dealId])
    || (ctx.dealId ? { id: ctx.dealId, title: ctx.dealTitle } : null);
  const contact = ctx.contactEmail
    ? (Object.values(state.contacts || {}).find((c) => (c?.email || '').toLowerCase() === ctx.contactEmail.toLowerCase())
       || { email: ctx.contactEmail })
    : null;
  return (
    <EmailComposerModal
      // sessionId keys the modal so a fresh open / draft resume remounts it
      // (the in-component useState initialisers re-run with the new draft).
      // A plain re-render (e.g. state.deals update) doesn't change the key,
      // so the in-progress form state is preserved.
      key={ctx.sessionId || 'composer'}
      deal={deal}
      contact={contact}
      initialDraft={ctx.initialDraft || null}
      onClose={() => actions.closeComposer()}
      onSent={() => {
        actions.closeComposer();
        if (ctx.dealId) actions.loadDealDetail(ctx.dealId);
      }}
    />
  );
}

// Secondary contacts strip rendered below the deal header. Shows the primary
// contact (read-only here — edited via "Edit deal") plus removable chips for
// each secondary, and a "+ Add" button that opens an existing-or-new picker.
function SecondaryContactsRow({ dealId, primaryContact, secondaryContacts, defaultCompanyId }) {
  const { state, actions, showMsg } = useStore();
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(null); // { email, name } prefill

  const remove = async (contactId) => {
    try {
      await actions.removeDealContact(dealId, contactId);
    } catch (e) {
      showMsg(e?.message || 'Could not remove contact');
    }
  };

  return (
    <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        Contacts
      </span>
      {primaryContact && (
        <ContactChip
          contact={primaryContact}
          label="primary"
          removable={false}
        />
      )}
      {secondaryContacts.map((c) => (
        <ContactChip
          key={c.id}
          contact={c}
          label="secondary"
          removable
          onRemove={() => remove(c.id)}
        />
      ))}
      <button
        onClick={() => setPicking(true)}
        className="btn-ghost"
        style={{ fontSize: 12, padding: '4px 10px' }}
        type="button"
      >
        <Plus size={12} /> Add contact
      </button>
      {picking && (
        <PickContactModal
          dealId={dealId}
          excludeIds={new Set([primaryContact?.id, ...secondaryContacts.map(c => c.id)].filter(Boolean))}
          defaultCompanyId={defaultCompanyId}
          onClose={() => setPicking(false)}
          onPickExisting={async (contactId) => {
            try {
              await actions.addDealContact(dealId, { contactId });
              setPicking(false);
            } catch (e) {
              showMsg(e?.message || 'Could not add contact');
            }
          }}
          onCreateNew={(prefill) => {
            setPicking(false);
            setCreating(prefill || {});
          }}
        />
      )}
      {creating && (
        <CreateContactModal
          dealId={dealId}
          defaultCompanyId={defaultCompanyId}
          prefill={creating}
          onClose={() => setCreating(null)}
          onCreated={() => setCreating(null)}
        />
      )}
    </div>
  );
}

function ContactChip({ contact, label, removable, onRemove }) {
  const display = contact.name || contact.email || '(no email)';
  const subtitle = contact.name && contact.email ? contact.email : null;
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 10px', borderRadius: 999,
        border: '1px solid ' + BRAND.border,
        background: 'white', fontSize: 12, maxWidth: 320,
      }}
      title={subtitle ? `${display} · ${subtitle} (${label})` : `${display} (${label})`}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {display}
      </span>
      {label === 'primary' && (
        <span style={{ fontSize: 10, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          primary
        </span>
      )}
      {removable && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove?.(); }}
          aria-label="Remove contact"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, padding: 0, border: 'none', borderRadius: '50%',
            background: 'transparent', cursor: 'pointer', color: BRAND.muted,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#F4F8FB')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

// Picker for the "+ Add contact" button. Searches existing CRM contacts and
// also offers "Create new contact" when the typed query looks like an email
// that isn't in the list yet.
function PickContactModal({ dealId, excludeIds, defaultCompanyId, onClose, onPickExisting, onCreateNew }) {
  const { state } = useStore();
  const [query, setQuery] = useState('');
  const contacts = useMemo(() => Object.values(state.contacts || {}), [state.contacts]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = contacts.filter((c) => c && !excludeIds.has(c.id));
    if (!q) return list.slice(0, 30);
    return list
      .filter((c) => (c.name || '').toLowerCase().includes(q)
        || (c.email || '').toLowerCase().includes(q)
        || (state.companies?.[c.companyId]?.name || '').toLowerCase().includes(q))
      .slice(0, 30);
  }, [contacts, query, excludeIds, state.companies]);

  const trimmed = query.trim();
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  const alreadyExists = looksLikeEmail
    && contacts.some(c => (c.email || '').toLowerCase() === trimmed.toLowerCase());

  return (
    <Modal onClose={onClose} maxWidth={520}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>Add a contact to this deal</h2>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, email, or company…"
        className="input"
        style={{ width: '100%', marginBottom: 12 }}
      />
      <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 8 }}>
        {filtered.length === 0 && (
          <div style={{ padding: 16, color: BRAND.muted, fontSize: 13, textAlign: 'center' }}>
            No matches.
          </div>
        )}
        {filtered.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onPickExisting(c.id)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              background: 'white', border: 'none', borderBottom: '1px solid ' + BRAND.border,
              padding: '10px 12px', cursor: 'pointer', fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#F4F8FB')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink }}>
              {c.name || <span style={{ fontStyle: 'italic', color: BRAND.muted }}>(no name)</span>}
              {c.email && <span style={{ color: BRAND.muted, fontWeight: 400 }}> · {c.email}</span>}
            </div>
            {c.companyId && state.companies?.[c.companyId]?.name && (
              <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>
                {state.companies[c.companyId].name}
              </div>
            )}
          </button>
        ))}
      </div>
      {looksLikeEmail && !alreadyExists && (
        <button
          type="button"
          onClick={() => onCreateNew({ email: trimmed })}
          className="btn"
          style={{ marginTop: 12, width: '100%' }}
        >
          <Plus size={14} /> Create new contact for {trimmed}
        </button>
      )}
    </Modal>
  );
}

// Lightweight create-and-link modal used by the email Cc prompt and the
// SecondaryContactsRow picker when the typed email isn't in CRM yet.
function CreateContactModal({ dealId, defaultCompanyId, prefill, onClose, onCreated }) {
  const { state, actions, showMsg } = useStore();
  const [email, setEmail] = useState(prefill?.email || '');
  const [name, setName] = useState(prefill?.name || '');
  const [title, setTitle] = useState(prefill?.title || '');
  const [companyId, setCompanyId] = useState(prefill?.companyId || defaultCompanyId || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const companies = useMemo(() => Object.values(state.companies || {})
    .sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [state.companies]);

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setError('');
    setBusy(true);
    try {
      await actions.addDealContact(dealId, {
        email: email.trim(),
        name: name.trim() || null,
        title: title.trim() || null,
        companyId: companyId || null,
      });
      onCreated?.();
    } catch (err) {
      setError(err?.message || 'Could not add contact');
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={460}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>Add new contact</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={{ fontSize: 12, color: BRAND.muted }}>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} required className="input" style={{ width: '100%', marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12, color: BRAND.muted }}>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" className="input" style={{ width: '100%', marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12, color: BRAND.muted }}>
          Job title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" className="input" style={{ width: '100%', marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12, color: BRAND.muted }}>
          Company
          <select value={companyId || ''} onChange={(e) => setCompanyId(e.target.value)} className="input" style={{ width: '100%', marginTop: 4 }}>
            <option value="">— None —</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        {error && <div style={{ color: '#DC2626', fontSize: 12 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={busy || !email.trim()}>
            {busy ? 'Adding…' : 'Add to deal'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Strip rendered below an email row when the message has Cc'd addresses that
// aren't yet linked to this deal (neither as primary nor secondary). One
// chip per unknown address; clicking either links the existing CRM contact
// (when the email matches one) or opens CreateContactModal pre-filled.
function CcSuggestionStrip({ dealId, addresses, defaultCompanyId }) {
  const { state, actions, showMsg } = useStore();
  const [creating, setCreating] = useState(null);
  const [busyEmail, setBusyEmail] = useState(null);

  if (!addresses.length) return null;

  // Map email → existing contact (for one-click linking).
  const contactByEmail = useMemo(() => {
    const m = new Map();
    for (const c of Object.values(state.contacts || {})) {
      if (c?.email) m.set(c.email.toLowerCase(), c);
    }
    return m;
  }, [state.contacts]);

  const handleAdd = async (email) => {
    const existing = contactByEmail.get(email.toLowerCase());
    if (existing) {
      setBusyEmail(email);
      try {
        await actions.addDealContact(dealId, { contactId: existing.id });
      } catch (e) {
        showMsg(e?.message || 'Could not add contact');
      } finally {
        setBusyEmail(null);
      }
    } else {
      setCreating({ email });
    }
  };

  return (
    <div
      style={{
        marginTop: 8, marginLeft: 22, padding: '8px 12px',
        background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8,
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        fontSize: 12,
      }}
    >
      <span style={{ color: '#9A3412', fontWeight: 600 }}>New on this thread:</span>
      {addresses.map((email) => {
        const existing = contactByEmail.get(email.toLowerCase());
        return (
          <button
            key={email}
            type="button"
            onClick={() => handleAdd(email)}
            disabled={busyEmail === email}
            title={existing
              ? `Add ${existing.name || existing.email} as a secondary contact`
              : `Create a new contact for ${email} and link it to this deal`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 9px', borderRadius: 999,
              border: '1px solid #FED7AA', background: 'white', color: BRAND.ink,
              cursor: busyEmail === email ? 'wait' : 'pointer',
              fontFamily: 'inherit', fontSize: 12,
            }}
          >
            <Plus size={11} /> {existing ? (existing.name || existing.email) : email}
          </button>
        );
      })}
      {creating && (
        <CreateContactModal
          dealId={dealId}
          defaultCompanyId={defaultCompanyId}
          prefill={creating}
          onClose={() => setCreating(null)}
          onCreated={() => setCreating(null)}
        />
      )}
    </div>
  );
}

