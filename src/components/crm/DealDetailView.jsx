import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowLeft, Building2, Calendar, CheckSquare, ChevronRight, Clock, Download, Edit2, ExternalLink, Eye, FileText, Flame, Folder, FolderPlus, Mail, MessageSquare, MoreVertical, Paperclip, Phone, Play, Plus, RefreshCw, Reply, ReplyAll, Rocket, Square, Trash2, Unlink, User, Video, X } from 'lucide-react';
import DOMPurify from 'dompurify';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, formatRelativeTime, formatDuration, useIsMobile, formatProposalNumber, decodeHtmlEntities } from '../../utils.js';
import { sanitizeEmailBody } from '../../utils/emailImages.js';
import { Badge, CallLink, Modal } from '../ui.jsx';
import { Avatar, AvatarGroup } from '../Avatar.jsx';
import { PIPELINE_STAGES, NewDealModal } from './PipelineView.jsx';
import { TaskFormModal, AssigneePicker } from './TaskFormModal.jsx';
import { ScheduleCard, ScheduleModal } from './ScheduleModal.jsx';
import { Card, Empty } from './Card.jsx';
import { InvoicesPaymentsCard } from './InvoicesPaymentsCard.jsx';
import { OrderSummaryCard } from './OrderSummaryCard.jsx';
import { RetainersCard } from './RetainersCard.jsx';
import { ProductionPanel } from './ProductionPanel.jsx';
import { PortalDealCard } from './PortalDealCard.jsx';
import { IntroCallButton } from './IntroCallCard.jsx';
import { ProductionProgressBar, aggregateProjectPhase } from './ProductionProgressBar.jsx';
import { TrackingEye } from './EmailTracking.jsx';
import { ContactModal } from './ContactsView.jsx';
import { LostReasonModal } from './LostReasonModal.jsx';
import { ConversationView } from './EmailsView.jsx';
import { EmailAttachmentCard } from './EmailAttachment.jsx';
import { XeroContactPicker } from './XeroContactPicker.jsx';
import { ViewAnalyticsModal } from '../ViewAnalyticsModal.jsx';


// Render plain text with any http(s) URLs turned into clickable links that open
// in a new tab. Used for quote-request notes, which the client pastes raw.
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]}'"])/gi;
function Linkify({ text }) {
  if (!text) return null;
  // Capturing group in the regex keeps the URLs as their own array elements.
  const parts = String(text).split(URL_RE);
  return parts.map((part, i) => (
    /^https?:\/\//i.test(part)
      ? (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: BRAND.blue, textDecoration: 'underline', wordBreak: 'break-all' }}
        >
          {part}
        </a>
      )
      : part
  ));
}

// Turn a share link into an inline-embeddable player URL. Loom is the primary
// case (loom.com/share/ID → loom.com/embed/ID); YouTube/Vimeo handled too.
// Returns null when the provider isn't recognised — caller falls back to a link.
function toEmbedSrc(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'loom.com') {
      const m = u.pathname.match(/\/(?:share|embed)\/([0-9a-zA-Z]+)/);
      if (m) return 'https://www.loom.com/embed/' + m[1];
    }
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = u.searchParams.get('v');
      if (id) return 'https://www.youtube.com/embed/' + id;
    }
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1);
      if (id) return 'https://www.youtube.com/embed/' + id;
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      // vimeo.com/ID, vimeo.com/ID/HASH, or player.vimeo.com/video/ID — keep the
      // privacy hash so "Hide from Vimeo"/unlisted videos still embed (without it
      // Vimeo refuses to play them). Hash can be a path segment or ?h= query.
      const parts = u.pathname.split('/').filter(Boolean);
      const idIdx = parts[0] === 'video' ? 1 : 0;
      const id = parts[idIdx];
      if (id && /^\d+$/.test(id)) {
        const hash = /^[0-9a-zA-Z]+$/.test(parts[idIdx + 1] || '')
          ? parts[idIdx + 1]
          : u.searchParams.get('h');
        return 'https://player.vimeo.com/video/' + id + (hash ? '?h=' + hash : '');
      }
    }
  } catch { /* not a valid URL — fall through to link */ }
  return null;
}

// `productionOnly` strips the sales/financial chrome (pipeline, order summary,
// proposals, invoices, edit/delete…) so producers/copywriters get a focused
// project view — the deal page doubles as the project page once signed.
export function DealDetailView({ dealId, onBack, onOpenProposal, onCreateProposal, onOpenVideo, onOpenCompany, productionOnly = false, hideFinancials = false }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [editing, setEditing] = useState(false);
  // Bumped when invoices/extras change so the Order Summary re-pulls.
  const [orderRefresh, setOrderRefresh] = useState(0);
  const [creatingTask, setCreatingTask] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
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
  // "Create or link proposal" chooser modal.
  const [choosingProposal, setChoosingProposal] = useState(false);
  // Proposal whose viewing analytics modal is open (null = closed).
  const [analyticsProposal, setAnalyticsProposal] = useState(null);

  useEffect(() => {
    if (dealId) {
      actions.loadDealDetail(dealId);
      if (!productionOnly) actions.loadScheduledEmails(dealId);
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
  // Value shown on the deal card. A signed proposal's total is the *actual* sale
  // value (incl. selected extras), so it wins. Otherwise the latest *proposed*
  // value takes over — sending a proposal supersedes any manual figure, so the
  // deal value tracks the quote you actually sent. A manual deal value is only
  // used before any proposal exists (and as the final fallback so it's never a dash).
  const dealValueInfo = useMemo(() => {
    const priced = proposals.filter(p => (p.totalExVat ?? p.basePrice) != null);
    const newest = (list) => list.reduce((best, p) => (best && (best.number || 0) >= (p.number || 0) ? best : p), null);
    const signed = newest(priced.filter(p => p.signed));
    if (signed) return { value: signed.totalExVat ?? signed.basePrice, source: 'signed' };
    const latest = newest(priced);
    if (latest) return { value: latest.totalExVat ?? latest.basePrice, source: 'proposal' };
    if (deal.value != null) return { value: deal.value, source: 'manual' };
    return { value: null, source: null };
  }, [proposals, deal.value]);
  const projectVideos = detail?.videos || [];
  const projectPhase = useMemo(() => aggregateProjectPhase(projectVideos), [projectVideos]);
  // Once a deal is in production it's a project (production_phase is set as soon
  // as it enters, before videos finish loading, so check both). Before that, the
  // "Good to go" gate moves it into Projects — but only when it's committed:
  // a signed proposal, a paid/long-term stage, or a purchase order. (The server
  // enforces the same rule; this just decides whether to offer the button.)
  const isProject = projectVideos.length > 0 || !!deal.productionPhase;
  const po = detail?.purchaseOrder || null;
  const canGoodToGo = !isProject && (
    proposals.some(p => p.signed)
    || ['signed', 'paid', 'long_term'].includes(deal.stage)
    || (po && (po.isPo || !!po.number))
  );
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

  // Milestone-flagged tasks (created from the production schedule) get their own
  // group and are kept out of the ordinary overdue/upcoming/done buckets — done
  // milestones stay in the Milestones group (struck through) rather than jumping
  // to Done.
  const milestoneTasks = tasks.filter(t => t.isMilestone);
  const overdueTasks  = tasks.filter(t => !t.isMilestone && isTaskOverdue(t));
  const upcomingTasks = tasks.filter(t => !t.isMilestone && !t.doneAt && !isTaskOverdue(t));
  const doneTasks     = tasks.filter(t => !t.isMilestone && !!t.doneAt);

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

  // "Good to go": move the deal into Projects/production and notify the project
  // managers. One-way, so confirm first.
  const handleGoodToGo = () => {
    if (!window.confirm('Mark this deal “Good to go”?\n\nIt will move into Projects (production) and the project managers will be notified. This can’t be undone.')) return;
    actions.markDealGoodToGo(dealId)
      .then(() => showMsg('Good to go — moved to Projects, project managers notified'))
      .catch((err) => showMsg(err?.message || 'Could not mark good to go'));
  };

  // Project overview video (e.g. Loom): owner records a quick walkthrough for
  // producers to watch first. Captured via a simple prompt; cleared with a blank.
  const overviewUrl = deal.overviewVideoUrl || null;
  const overviewEmbedSrc = useMemo(() => toEmbedSrc(overviewUrl), [overviewUrl]);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const editOverview = async () => {
    const input = window.prompt(
      'Paste a project overview video link (e.g. Loom) for producers to watch first.\nLeave blank to remove.',
      overviewUrl || '',
    );
    if (input === null) return; // cancelled
    const url = input.trim();
    if (url && !/^https?:\/\//i.test(url)) { showMsg('Enter a full URL starting with http:// or https://'); return; }
    try {
      await actions.saveDeal(dealId, { overviewVideoUrl: url || null });
      showMsg(url ? 'Overview video saved' : 'Overview video removed');
    } catch (e) {
      showMsg(e?.message || 'Could not save overview video');
    }
  };

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> {productionOnly ? 'Production' : 'Pipeline'}</button>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <IntroCallButton dealId={dealId} />
          <button
            onClick={() => { setPrefillTitle(''); setCreatingTask(true); }}
            className="btn"
            title="Add a task to this deal"
          ><Plus size={14} /> Add task</button>
          {!productionOnly && (
            <>
              {canGoodToGo && (
                <button
                  onClick={handleGoodToGo}
                  className="btn"
                  style={{ background: '#22C55E', borderColor: '#22C55E', color: '#fff' }}
                  title="Move this deal into Projects (production) and notify the project managers"
                ><Rocket size={14} /> Good to go</button>
              )}
              {proposals.length === 0 && (
                <button
                  onClick={() => setChoosingProposal(true)}
                  className="btn"
                  style={{ background: '#22C55E', borderColor: '#22C55E', color: '#fff' }}
                ><FileText size={14} /> Create or link proposal</button>
              )}
              <button onClick={() => openComposerForDeal()} className="btn"><Mail size={14} /> Send email</button>
            </>
          )}
        </div>
      </header>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 16 : 24, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '0 0 12px' }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{deal.title}</h1>
          {/* "Hot" is a sales/lead warmth marker — irrelevant once the deal
              is a won project in production, so hide it there. */}
          {!productionOnly && !isProject && (
            <button
              onClick={() => actions.toggleDealHot(dealId, !deal.hot)}
              className="btn-ghost"
              aria-pressed={!!deal.hot}
              title={deal.hot ? 'Flagged hot — click to unflag' : 'Flag as hot'}
              style={{ color: deal.hot ? '#EA580C' : undefined, borderColor: deal.hot ? '#EA580C' : undefined, fontWeight: deal.hot ? 600 : undefined }}
            ><Flame size={14} fill={deal.hot ? '#EA580C' : 'none'} /> {deal.hot ? 'Hot' : 'Mark hot'}</button>
          )}
          {!productionOnly && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button onClick={() => setEditing(true)} className="btn-ghost"><Edit2 size={14} /> Edit deal</button>
              <button
                onClick={() => {
                  if (window.confirm('Delete this deal? Linked proposals will be unlinked but not removed.')) {
                    actions.deleteDeal(dealId);
                    onBack();
                  }
                }}
                className="btn-ghost is-danger"
                title="Delete deal"
                aria-label="Delete deal"
              ><Trash2 size={14} /></button>
            </div>
          )}
        </div>
        {/* Once the deal is a project (it has production videos) the sales
            pipeline bar gives way to a production progress bar for the whole
            project — aggregated across its videos. */}
        {projectVideos.length > 0 ? (
          <ProductionProgressBar
            phaseId={projectPhase.phaseId}
            subtitle={projectPhase.total > 1
              ? `${projectPhase.delivered} of ${projectPhase.total} videos delivered`
              : (projectPhase.delivered ? 'Video delivered' : 'In production')}
          />
        ) : (!productionOnly && <StagePicker stage={deal.stage} onChange={handleStageChange} />)}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 16, marginTop: 20 }}>
          <Field icon={Building2} label="Customer">
            {company
              ? (onOpenCompany && !productionOnly
                  ? <button type="button" onClick={() => onOpenCompany(company.id)} className="link-btn" style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: BRAND.blue, cursor: 'pointer', textAlign: 'left' }}>{company.name}</button>
                  : company.name)
              : <span style={{ color: BRAND.muted }}>—</span>}
          </Field>
          <Field icon={User} label="Primary contact">
            {contact ? (() => {
              // The email is a click-to-compose button (opens the email box
              // pre-addressed to this contact), not just plain text.
              const emailBtn = contact.email ? (
                state.session?.role === 'freelancer'
                  ? <span>{contact.email}</span>
                  : <button type="button" onClick={() => openComposerForDeal()} title="Email this contact" style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: BRAND.blue, cursor: 'pointer' }}>{contact.email}</button>
              ) : null;
              return (
                <>
                  {contact.name || emailBtn}
                  {contact.email && contact.name ? <span style={{ color: BRAND.muted, fontSize: 12 }}> · {emailBtn}</span> : null}
                  {contact.phone ? <span style={{ color: BRAND.muted, fontSize: 12 }}> · <CallLink phone={contact.phone} title="Call this contact" /></span> : null}
                </>
              );
            })() : <span style={{ color: BRAND.muted }}>—</span>}
          </Field>
          {!hideFinancials && (
            <Field label="Value (ex VAT)">
              {dealValueInfo.value != null
                ? (() => {
                    const rate = deal.vatRate != null ? deal.vatRate : 0.2;
                    return (
                      <>
                        <strong title={dealValueInfo.source === 'signed' ? 'Signed sale value (incl. extras)'
                          : dealValueInfo.source === 'proposal' ? 'From the latest proposal (not yet signed)'
                          : 'Set manually'}>{formatGBP(dealValueInfo.value)}</strong>
                        {rate > 0 && (
                          <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>
                            {formatGBP(dealValueInfo.value * (1 + rate))} inc VAT ({+(rate * 100).toFixed(2)}%)
                          </div>
                        )}
                      </>
                    );
                  })()
                : <span style={{ color: BRAND.muted }}>—</span>}
            </Field>
          )}
          {!hideFinancials && projectVideos.length > 0 && deal.productionEnteredAt && (
            <Field icon={Calendar} label={deal.paymentOption === '5050' ? 'Deposit paid' : deal.paymentOption === 'po' ? 'PO confirmed' : 'Paid'}>
              {new Date(deal.productionEnteredAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </Field>
          )}
          {projectVideos.length > 0 && (
            <Field icon={Calendar} label="Production start date">
              <input
                type="date"
                value={(deal.productionStartDate || '').slice(0, 10)}
                onChange={(e) => actions.saveDeal(dealId, { productionStartDate: e.target.value || null })}
                title="Set or adjust when production actually starts (e.g. once all client assets are in)"
                style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid ' + BRAND.border, background: 'white', fontSize: 14, color: BRAND.ink }}
              />
            </Field>
          )}
          {!productionOnly && (
            <Field icon={User} label="Deal Owner">
              {deal.ownerEmail ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <Avatar email={deal.ownerEmail} size={22} />
                  <span>{owner?.name || deal.ownerEmail}</span>
                </span>
              ) : <span style={{ color: BRAND.muted }}>—</span>}
            </Field>
          )}
          {!productionOnly && <Field label="Last activity">{formatRelativeTime(deal.lastActivityAt)}</Field>}
        </div>
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Team</div>
          <AssigneePicker
            users={Object.entries(state.users || {}).map(([email, u]) => ({ email, ...u }))}
            selected={deal.producerEmails || (deal.producerEmail ? [deal.producerEmail] : [])}
            onToggle={(email) => {
              const set = new Set(deal.producerEmails || (deal.producerEmail ? [deal.producerEmail] : []));
              set.has(email) ? set.delete(email) : set.add(email);
              actions.saveDeal(dealId, { producerEmails: Array.from(set) });
            }}
            emptyLabel="No team members assigned"
          />
        </div>
        {!productionOnly && (
          <SecondaryContactsRow
            dealId={dealId}
            primaryContact={contact}
            secondaryContacts={detail?.secondaryContacts || []}
            defaultCompanyId={deal.companyId || null}
          />
        )}
        {deal.notes && (
          <div style={{ marginTop: 16, padding: 12, background: '#F8FAFC', borderRadius: 8, fontSize: 13, color: BRAND.ink, whiteSpace: 'pre-wrap' }}>
            <Linkify text={deal.notes} />
          </div>
        )}
        {deal.stage === 'lost' && deal.lostReason && (
          <div style={{ marginTop: 12, fontSize: 13, color: '#92400E', background: '#FEF3C7', padding: '8px 12px', borderRadius: 6 }}>
            Lost — {deal.lostReason}
          </div>
        )}
        {!productionOnly && deal.leadSource && <LeadSourceCard src={deal.leadSource} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        {!productionOnly && (
          <div>
            <OrderSummaryCard dealId={dealId} refreshKey={orderRefresh} />
          </div>
        )}

        {/* Project overview video (e.g. Loom) — embedded beside the order
            summary; visible to producers when set, editable by the owner. */}
        {(overviewUrl || !productionOnly) && (
          <div>
            <Card
              title="Project overview"
              action={!productionOnly ? (
                <button onClick={editOverview} className="btn"
                  title={overviewUrl ? 'Replace or remove the overview video link' : 'Embed a project overview video link (e.g. Loom)'}>
                  <Video size={12} /> {overviewUrl ? 'Edit' : 'Embed overview video'}
                </button>
              ) : undefined}
            >
              {overviewEmbedSrc ? (
                <button
                  type="button"
                  onClick={() => setOverviewOpen(true)}
                  title="Play the project overview video"
                  style={{ display: 'block', width: '50%', maxWidth: 340, margin: '4px auto', padding: 0, border: 0, background: 'transparent', cursor: 'pointer' }}
                >
                  <div style={{ position: 'relative', paddingTop: '56.25%', borderRadius: 8, overflow: 'hidden', background: '#000' }}>
                    {/* Non-interactive poster frame; the overlay below opens the modal player. */}
                    <iframe
                      src={overviewEmbedSrc}
                      title="Project overview preview"
                      tabIndex={-1}
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, pointerEvents: 'none' }}
                    />
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.18)' }}>
                      <span style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(255,255,255,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.25)' }}>
                        <Play size={20} color="#0F2A3D" fill="#0F2A3D" style={{ marginLeft: 2 }} />
                      </span>
                    </div>
                  </div>
                </button>
              ) : overviewUrl ? (
                <a href={overviewUrl} target="_blank" rel="noopener noreferrer" className="btn"
                  style={{ textDecoration: 'none', background: '#6D28D9', borderColor: '#6D28D9' }}>
                  <Play size={14} /> Watch overview
                </a>
              ) : (
                // No duplicate body button — the top-right "Embed overview
                // video" button is the single entry point, keeping this empty
                // card compact.
                <div style={{ fontSize: 12.5, color: BRAND.muted, padding: '2px 0' }}>
                  No overview video yet — add a quick walkthrough for producers.
                </div>
              )}
            </Card>
          </div>
        )}

        {overviewOpen && overviewEmbedSrc && (
          <Modal onClose={() => setOverviewOpen(false)} maxWidth={960} overflow="hidden">
            <div style={{ position: 'relative', paddingTop: '56.25%', borderRadius: 8, overflow: 'hidden', background: '#000' }}>
              <iframe
                src={overviewEmbedSrc + (overviewEmbedSrc.includes('?') ? '&' : '?') + 'autoplay=1'}
                title="Project overview video"
                allow="autoplay; fullscreen; picture-in-picture"
                allowFullScreen
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
              />
            </div>
          </Modal>
        )}

        {!productionOnly && (<>
        <Card title="Proposal">
          {proposals.length === 0 && (
            <div style={{ textAlign: 'center', padding: '4px' }}>
              <Empty text="No proposals attached yet" />
              <button
                onClick={() => setChoosingProposal(true)}
                className="btn"
                style={{ marginTop: 8, background: '#22C55E', borderColor: '#22C55E', color: '#fff' }}
              ><FileText size={14} /> Create or link proposal</button>
            </div>
          )}
          {proposals.map(p => (
            <div
              key={p.id}
              style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', padding: '10px 12px', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, marginBottom: 6 }}
            >
              {/* Header: number + client name + status pill on the left, price
                  pinned top-right. */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1, fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {p.number ? <span style={{ color: BRAND.muted, fontSize: 11 }}>{formatProposalNumber(p.number)}</span> : null}
                  <span>{p.clientName || p.contactBusinessName || 'Untitled'}</span>
                  {p.signed
                    ? <Badge color="green">Signed</Badge>
                    : <Badge color="grey">Unsigned</Badge>}
                </div>
                {(p.totalExVat ?? p.basePrice) != null && (
                  <div style={{ flexShrink: 0, textAlign: 'right', fontSize: 12.5, fontWeight: 700, color: BRAND.ink }}>
                    {formatGBP(p.totalExVat ?? p.basePrice)}
                    <span style={{ fontWeight: 400, color: BRAND.muted }}> ex VAT</span>
                    {p.signed && p.totalExVat != null && p.basePrice != null && p.totalExVat !== p.basePrice && (
                      <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: BRAND.muted }} title="Includes selected extras">(inc. extras)</span>
                    )}
                  </div>
                )}
              </div>
              {/* Footer: analytics pill on the left, in line with Edit/Preview
                  on the right. */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  {(p._views?.opens || 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => setAnalyticsProposal({ ...p, _number: p.number })}
                      title="View analytics"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', border: '1px solid ' + BRAND.border, borderRadius: 999, background: '#FFFBEB', color: '#92400E', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
                    >
                      <Eye size={11} />
                      <span>{p._views.opens} {p._views.opens === 1 ? 'view' : 'views'}</span>
                      <span style={{ opacity: 0.6 }}>·</span>
                      <Clock size={11} />
                      <span>{formatDuration(p._views.duration)}</span>
                      {p._views.lastActiveAt && (
                        <>
                          <span style={{ opacity: 0.6 }}>·</span>
                          <span>{formatRelativeTime(p._views.lastActiveAt)}</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 'auto' }}>
                  {/* Signed proposals are locked — the client has agreed to these
                      terms, so only Preview is offered. */}
                  {!p.signed && (
                    <button
                      type="button"
                      onClick={() => onOpenProposal?.(p.id, 'edit')}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: BRAND.ink }}
                    ><Edit2 size={13} /> Edit</button>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenProposal?.(p.id, 'preview')}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', background: BRAND.blue, border: '1px solid ' + BRAND.blue, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'white' }}
                  ><Eye size={13} /> Preview</button>
                </div>
              </div>
            </div>
          ))}
        </Card>

        {projectVideos.length > 0 && (
          <ScheduleCard deal={deal} onOpen={() => setScheduleOpen(true)} />
        )}

        <Card title="Tasks" count={tasks.filter(t => !t.doneAt).length}>
          <QuickAddTask
            dealId={dealId}
            onSchedule={(title) => { setPrefillTitle(title); setCreatingTask(true); }}
          />
          {tasks.length === 0 && <Empty text="No tasks yet" />}
          {milestoneTasks.length > 0 && (
            <>
              <TaskSection label="Milestones" color={BRAND.blue} />
              {milestoneTasks.map(t => (
                <TaskRow key={t.id} task={t} onToggle={() => actions.toggleTask(t.id)} onEdit={() => setEditingTask(t)} />
              ))}
            </>
          )}
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

        {/* PO-route deals always show the card (they're waiting on a PO); any other
            deal shows it once a PO has actually been uploaded/recorded against it. */}
        {(po?.isPo || !!po?.number || (po?.files || []).length > 0) && (
          <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
            <PurchaseOrderCard dealId={dealId} po={po} isMobile={isMobile} />
          </div>
        )}

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <InvoicesPaymentsCard
            dealId={dealId}
            proposals={proposals}
            contactName={company?.name || contact?.name || deal.title}
            poNumber={detail?.purchaseOrder?.number || null}
            onChanged={() => {
              setOrderRefresh((n) => n + 1);
              // Invoicing/paying changes the deal's sale status, which the
              // pipeline renders as a pill from the (server-computed) deals list.
              actions.refreshDeals?.();
            }}
          />
        </div>

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <RetainersCard
            dealId={dealId}
            contacts={Object.values(state.contacts || {})}
            onOpenVideo={onOpenVideo}
            refreshKey={`${projectVideos.length}:${detail?.creditProject?.used ?? ''}`}
          />
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
        </>)}

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <ProductionPanel dealId={dealId} deal={deal} videos={detail?.videos || []} creditProject={detail?.creditProject || null} hideCredits={hideFinancials} isMobile={isMobile} onOpenVideo={onOpenVideo} />
        </div>

        {/* Customer-portal extras offers + invite management (money — hidden
            from freelancers / finance-restricted views). */}
        {state.session?.role !== 'freelancer' && !hideFinancials && (
          <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
            <PortalDealCard dealId={dealId} />
          </div>
        )}

        {/* Freelancers don't use the CRM inbox / send client emails. */}
        {state.session?.role !== 'freelancer' && (
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
                  onUnlink={async (target) => {
                    if (!window.confirm('Unlink this conversation from this deal? It stays in your mailbox and on any other deals it’s linked to.')) return;
                    try {
                      await actions.unlinkEmail({ threadId: target.threadId, dealId, scope: 'thread' });
                      showMsg('Email unlinked from this deal');
                      actions.loadDealDetail(dealId);
                    } catch (err) {
                      showMsg('Could not unlink: ' + (err?.message || 'unknown error'));
                    }
                  }}
                />
              ))}
            </div>
          </Card>
        </div>
        )}

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <FilesCard dealId={dealId} files={detail?.files || []} driveEnabled={!!detail?.driveFiles} driveFolderId={detail?.driveFolderId || null} />
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
      {scheduleOpen && (
        <ScheduleModal
          deal={deal}
          dealId={dealId}
          company={company}
          primaryContact={contact}
          onClose={() => setScheduleOpen(false)}
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
        <ThreadViewerModal
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
      {choosingProposal && (
        <CreateOrLinkProposalModal
          deal={deal}
          contact={contact}
          company={company}
          onClose={() => setChoosingProposal(false)}
          onCreate={() => { setChoosingProposal(false); onCreateProposal?.(dealId); }}
          onLink={async (proposalId) => {
            try {
              await actions.linkProposalToDeal(proposalId, dealId);
              setChoosingProposal(false);
              showMsg('Proposal linked');
            } catch (e) {
              showMsg(e?.message || 'Could not link proposal');
            }
          }}
        />
      )}
      {newDealFromEmail && (
        <NewDealFromEmailFlow
          target={newDealFromEmail}
          onClose={() => setNewDealFromEmail(null)}
          onCreated={() => { setNewDealFromEmail(null); actions.loadDealDetail(dealId); }}
        />
      )}
      {analyticsProposal && (
        <ViewAnalyticsModal
          proposal={analyticsProposal}
          onClose={() => setAnalyticsProposal(null)}
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

function EmailRow({ email, onOpen, threadCount, hasAttachments, expandable, expanded, dealTitle, onLinkAnother, onCreateNewDeal, onUnlink }) {
  const inbound = email.direction === 'inbound';
  const arrow = inbound ? '↓' : '↑';
  const accent = inbound ? '#16A34A' : '#2BB8E6';
  const counterparty = inbound ? email.fromEmail : (email.toEmails?.[0] || '');
  // Hard cap snippet length even before CSS truncation, in case Gmail returned
  // a long one with embedded newlines that defeat single-line nowrap.
  const snippetTrim = email.snippet
    ? decodeHtmlEntities(email.snippet).replace(/\s+/g, ' ').trim().slice(0, 140)
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
      title={hasThreadChip ? (expanded ? 'Collapse thread' : 'Expand thread') : (expanded ? 'Collapse email' : 'Expand email')}
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
        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>{formatRelativeTime(email.sentAt)}{counterparty ? ` · ${inbound ? 'from' : 'to'} ${counterparty}` : ''}</span>
          {hasAttachments && (
            <span title="Has attachments" style={{ display: 'inline-flex', alignItems: 'center', color: BRAND.muted }}>
              <Paperclip size={12} />
            </span>
          )}
          {/* Reflect THIS (latest) email's own open state when it is itself a
              tracked send — so an unopened follow-up reads "Not opened" rather
              than inheriting the thread's earlier green opens. Falls back to the
              thread aggregate only when the latest message isn't itself tracked
              (e.g. the newest message is an inbound reply). */}
          <TrackingEye
            tracking={email.messageTracking?.tracked ? email.messageTracking : email.tracking}
            labelUnopened={!!email.messageTracking?.tracked}
          />
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
      {(hasThreadChip || expandable) && (
        <div style={{ flexShrink: 0, alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 4 }}>
          {hasThreadChip && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: BRAND.muted,
              background: '#EEF2F6', padding: '2px 6px', borderRadius: 999,
              letterSpacing: 0.3,
            }}>{threadCount} msgs</span>
          )}
          <span style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1 }}>{expanded ? '▾' : '▸'}</span>
        </div>
      )}
      {(onLinkAnother || onCreateNewDeal || onUnlink) && (
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
              onUnlink={onUnlink}
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
function EmailActionsMenu({ anchor, onClose, onLinkAnother, onCreateNewDeal, onUnlink }) {
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
    onUnlink && { label: 'Unlink from this deal', danger: true, onClick: () => { onClose(); onUnlink(); } },
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
            padding: '8px 10px', borderRadius: 6, fontSize: 13,
            color: it.danger ? '#DC2626' : BRAND.ink,
            fontFamily: 'inherit',
            borderTop: it.danger ? '1px solid ' + BRAND.border : undefined,
            marginTop: it.danger ? 4 : undefined,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = it.danger ? '#FEF2F2' : '#F4F8FB')}
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
export function ThreadRow({ messages, dealId, dealTitle, linkedEmails, defaultCompanyId, onOpenMessage, onLinkAnother, onCreateNewDeal, onUnlink }) {
  const { state, actions } = useStore();
  const [expanded, setExpanded] = useState(false);
  // Inline reply (Gmail-style) — when true, the composer renders at the foot of
  // the expanded thread instead of popping the floating dock composer. Keeps the
  // reply in context with the conversation, matching the full thread reader.
  const [replying, setReplying] = useState(false);
  // Whether the active inline reply was opened as "Reply all" (keeps every other
  // participant on Cc) vs a plain "Reply" (just the sender).
  const [replyAll, setReplyAll] = useState(false);
  const isMulti = messages.length > 1;
  const latest = messages[messages.length - 1];
  const threadId = latest.gmailThreadId || latest.gmailMessageId;

  // Re: subject shared by both reply variants.
  const replySubject = () => (/^re:/i.test(latest.subject || '') ? latest.subject : 'Re: ' + (latest.subject || '(no subject)'));

  // Our own addresses — never Cc ourselves on a reply-all.
  const ownAddresses = useMemo(() => {
    const own = new Set();
    if (state.session?.email) own.add(state.session.email.toLowerCase());
    if (state.gmailAccount?.gmailAddress) own.add(state.gmailAccount.gmailAddress.toLowerCase());
    return own;
  }, [state.session, state.gmailAccount]);

  // Seed draft for the inline reply: the other party of the latest message, a
  // "Re:" subject, and the thread id so the send stays in the same Gmail
  // conversation. Body is left empty — the thread is shown right above it.
  const replyDraft = () => {
    const to = latest.direction === 'inbound'
      ? (latest.fromEmail || '')
      : (latest.toEmails?.[0] || latest.fromEmail || '');
    return { to, cc: '', subject: replySubject(), body: '', gmailThreadId: latest.gmailThreadId || null };
  };

  // Everyone (besides us) who was on the latest message's To/Cc but isn't the
  // primary reply recipient — used to populate the Cc on a "Reply all".
  const replyAllCc = useMemo(() => {
    const toList = (latest.direction === 'inbound'
      ? [latest.fromEmail]
      : (latest.toEmails?.length ? latest.toEmails : [latest.fromEmail])).filter(Boolean);
    const exclude = new Set(toList.map(e => e.toLowerCase()));
    for (const e of ownAddresses) exclude.add(e);
    const seen = new Set();
    const cc = [];
    for (const raw of [...(latest.toEmails || []), ...(latest.ccEmails || [])]) {
      if (!raw || typeof raw !== 'string') continue;
      const lower = raw.trim().toLowerCase();
      if (!lower || seen.has(lower) || exclude.has(lower)) continue;
      seen.add(lower);
      cc.push(raw.trim());
    }
    return cc;
  }, [latest, ownAddresses]);
  const canReplyAll = replyAllCc.length > 0;

  // Reply-all draft = the plain reply plus every other participant on Cc.
  const replyAllDraft = () => ({ ...replyDraft(), cc: replyAllCc.join(', ') });

  const startReply = (all = false) => { setReplyAll(all); setExpanded(true); setReplying(true); };

  // Real participants on this thread that aren't already linked to this deal —
  // the person who emailed us (inbound `fromEmail`), the people we emailed
  // (outbound `toEmails`), and anyone Cc'd into a reply we received (inbound
  // `ccEmails`). These are the addresses worth prompting to add as a contact.
  // Outbound Cc's are the user's own choice and skipped; our own team is never
  // a candidate.
  const unknownParticipants = useMemo(() => {
    if (!linkedEmails) return [];
    // Our own team is never a "new contact" to add. Exclude CRM users, the
    // signed-in user, the connected mailbox, and anyone on our own email domain
    // (catches teammates + internal aliases like enquiries@ without CRM accounts).
    const internal = new Set();
    for (const u of Object.values(state.users || {})) if (u?.email) internal.add(u.email.toLowerCase());
    if (state.session?.email) internal.add(state.session.email.toLowerCase());
    if (state.gmailAccount?.gmailAddress) internal.add(state.gmailAccount.gmailAddress.toLowerCase());
    const sessionEmail = (state.session?.email || '').toLowerCase();
    const at = sessionEmail.lastIndexOf('@');
    const ownDomain = at >= 0 ? sessionEmail.slice(at + 1) : null;
    const seen = new Set();
    const out = [];
    const consider = (raw) => {
      if (!raw || typeof raw !== 'string') return;
      const lower = raw.trim().toLowerCase();
      if (!lower || seen.has(lower) || linkedEmails.has(lower) || internal.has(lower)) return;
      if (ownDomain && lower.endsWith('@' + ownDomain)) return;
      seen.add(lower);
      out.push(raw.trim());
    };
    for (const m of messages) {
      if (m.direction === 'inbound') {
        consider(m.fromEmail);
        for (const raw of (Array.isArray(m.ccEmails) ? m.ccEmails : [])) consider(raw);
      } else {
        for (const raw of (Array.isArray(m.toEmails) ? m.toEmails : [])) consider(raw);
      }
    }
    return out;
  }, [messages, linkedEmails, state.users, state.session, state.gmailAccount]);

  // Both single emails and threads now expand inline (a single email used to
  // open the standalone modal — you can still reach it via the row's
  // "open full" icon). Toggling shows the body(ies) in place.
  const handleHeaderClick = () => setExpanded(e => !e);

  return (
    <div>
      <EmailRow
        email={latest}
        onOpen={handleHeaderClick}
        threadCount={isMulti ? messages.length : null}
        hasAttachments={messages.some(m => Array.isArray(m.attachments) && m.attachments.length > 0)}
        expandable
        expanded={expanded}
        dealTitle={dealTitle}
        onLinkAnother={onLinkAnother ? () => onLinkAnother({ threadId, gmailMessageId: latest.gmailMessageId, subject: latest.subject }) : null}
        onCreateNewDeal={onCreateNewDeal ? () => onCreateNewDeal({ threadId, gmailMessageId: latest.gmailMessageId, subject: latest.subject }) : null}
        onUnlink={onUnlink ? () => onUnlink({ threadId, gmailMessageId: latest.gmailMessageId, subject: latest.subject }) : null}
      />
      {unknownParticipants.length > 0 && (
        <CcSuggestionStrip
          dealId={dealId}
          addresses={unknownParticipants}
          defaultCompanyId={defaultCompanyId}
        />
      )}
      {expanded && (
        <div style={{ marginTop: 8, marginLeft: 22, paddingLeft: 12, borderLeft: '2px solid ' + BRAND.border, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.map((m, i) => (
            <ExpandedMessage
              key={m.gmailMessageId}
              email={m}
              dealId={dealId}
              defaultOpen={i === messages.length - 1}
              isLast={i === messages.length - 1}
              onOpenFull={() => onOpenMessage(m.gmailMessageId)}
            />
          ))}
          {replying ? (
            <EmailComposerModal
              inline
              deal={{ id: dealId, title: dealTitle }}
              contact={null}
              initialDraft={replyAll ? replyAllDraft() : replyDraft()}
              onClose={() => setReplying(false)}
              onSent={() => { setReplying(false); actions.loadDealDetail(dealId); }}
            />
          ) : (
            <div style={{ display: 'flex', gap: 8, alignSelf: 'flex-start' }}>
              <button onClick={() => startReply(false)} className="btn-ghost">
                <Reply size={13} /> Reply
              </button>
              {canReplyAll && (
                <button onClick={() => startReply(true)} className="btn-ghost">
                  <ReplyAll size={13} /> Reply all
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One message inside an expanded thread. Loads its body on mount (cached in
// the store so re-opens are free), sanitises HTML, and falls back to plain
// text. Click the header to open the standalone modal.
function ExpandedMessage({ email, dealId = null, defaultOpen = false, isLast = false, onOpenFull }) {
  const { state, actions } = useStore();
  const connected = !!(state.gmailAccount && state.gmailAccount.connected);
  const cached = state.emailBodies?.[email.gmailMessageId] || null;
  // Collapsed by default for every message except the latest, so opening a
  // thread shows only the newest email's body (older ones are one click away).
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState(cached);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Re-sync open state when this message stops (or starts) being the latest —
  // e.g. after you send a reply, the message you replied to is no longer last,
  // so it collapses and only your new message stays open. Gated on an actual
  // change in defaultOpen so a manual expand/collapse is never overridden.
  const prevDefaultOpen = useRef(defaultOpen);
  useEffect(() => {
    if (prevDefaultOpen.current !== defaultOpen) {
      setOpen(defaultOpen);
      prevDefaultOpen.current = defaultOpen;
    }
  }, [defaultOpen]);

  // Lazy-load the body the first time the message is opened (and not before),
  // so collapsed messages cost nothing.
  useEffect(() => {
    if (!open || data) return;
    let cancelled = false;
    setLoading(true);
    actions.loadEmailBody(email.gmailMessageId)
      .then((res) => { if (!cancelled) { setData(res); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err?.message || 'Failed to load'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [open, email.gmailMessageId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sanitized = useMemo(() => {
    if (!data?.bodyHtml) return null;
    return sanitizeEmailBody(data.bodyHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
    }, { messageId: email.gmailMessageId });
  }, [data?.bodyHtml, email.gmailMessageId]);

  const inbound = email.direction === 'inbound';
  const accent = inbound ? '#16A34A' : '#2BB8E6';
  const counterparty = inbound ? email.fromEmail : (email.toEmails?.[0] || '');

  // Attachments ride along on the thread payload; the lazily-loaded full body
  // carries them too. Prefer whichever is populated so the cards appear as soon
  // as the message opens.
  const attachments = (data?.attachments?.length ? data.attachments : email.attachments) || [];
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

  return (
    <div style={{ background: '#FAFBFC', border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: open ? 8 : 0 }}>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          title={open ? 'Collapse message' : 'Expand message'}
          aria-expanded={open}
          style={{
            flex: 1, minWidth: 0, background: 'transparent', border: 'none', padding: 0,
            textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: 'inherit',
            display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          <span style={{
            display: 'inline-block', padding: '1px 5px', borderRadius: 3,
            background: accent + '22', color: accent,
            fontSize: 10, fontWeight: 700, flexShrink: 0,
          }}>{inbound ? 'IN' : 'OUT'}</span>
          <span style={{ flexShrink: 0, fontSize: 12, color: BRAND.ink }}>
            {inbound ? 'From' : 'To'} <strong>{counterparty || '—'}</strong>
          </span>
          {!open && email.snippet && (
            <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {decodeHtmlEntities(email.snippet)}
            </span>
          )}
          {/* Paperclip so an attachment is obvious with the message collapsed. */}
          {hasAttachments && (
            <span
              title={`${attachments.length} attachment${attachments.length > 1 ? 's' : ''}`}
              style={{ marginLeft: 'auto', flexShrink: 0, display: 'inline-flex', alignItems: 'center', color: BRAND.muted }}
            >
              <Paperclip size={12} />
            </span>
          )}
          <span
            style={{ marginLeft: hasAttachments ? 0 : 'auto', fontSize: 11, color: BRAND.muted, flexShrink: 0 }}
            title={email.sentAt ? new Date(email.sentAt).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' }) : undefined}
          >
            {formatRelativeTime(email.sentAt)}
          </span>
          <span style={{ fontSize: 11, color: BRAND.muted, flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
        </button>
        {/* This sent email's own open/click tracking, on the right of the row.
            For the latest sent email we fall back to the thread-level summary,
            so a teammate's email (whose tracking row may lack a per-message id,
            e.g. Gmail-composed) still shows its tracking here. Inbound messages
            and untracked sends render nothing. */}
        {(() => {
          if (inbound) return null;
          const t = email.messageTracking?.tracked
            ? email.messageTracking
            : (isLast ? email.tracking : null);
          return t?.tracked ? (
            <span style={{ flexShrink: 0 }}><TrackingEye tracking={t} /></span>
          ) : null;
        })()}
        <button
          type="button"
          onClick={onOpenFull}
          title="Open full message"
          aria-label="Open full message"
          style={{ flexShrink: 0, background: 'transparent', border: 'none', padding: 2, cursor: 'pointer', color: BRAND.muted, display: 'flex' }}
        >
          <ExternalLink size={13} />
        </button>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid ' + BRAND.border, paddingTop: 8, fontSize: 13, lineHeight: 1.5, maxHeight: 320, overflowY: 'auto', wordBreak: 'break-word' }}>
          {/* Full recipient list so every addressee — including everyone Cc'd —
              is visible, not just the first To. */}
          <div style={{ fontSize: 11.5, color: BRAND.muted, marginBottom: 8, lineHeight: 1.5 }}>
            {email.fromEmail && <div><span style={{ fontWeight: 600 }}>From:</span> {email.fromEmail}</div>}
            {email.toEmails?.length > 0 && <div><span style={{ fontWeight: 600 }}>To:</span> {email.toEmails.join(', ')}</div>}
            {email.ccEmails?.length > 0 && <div><span style={{ fontWeight: 600 }}>Cc:</span> {email.ccEmails.join(', ')}</div>}
          </div>
          {loading && <div style={{ color: BRAND.muted, fontSize: 12 }}>Loading…</div>}
          {error && <div style={{ color: '#DC2626', fontSize: 12 }}>{error}</div>}
          {!loading && !error && data && (
            sanitized
              ? <div className="email-body" dangerouslySetInnerHTML={{ __html: sanitized }} />
              : data.bodyText
                ? <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0 }}>{data.bodyText}</pre>
                : <div style={{ color: BRAND.muted, fontStyle: 'italic', fontSize: 12 }}>(no body stored — open in Gmail to read)</div>
          )}
          {hasAttachments && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid ' + BRAND.border, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {attachments.map((a, i) => (
                <EmailAttachmentCard key={i} att={a} messageId={email.gmailMessageId} connected={connected} dealId={dealId} />
              ))}
            </div>
          )}
        </div>
      )}
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

// Opens an email on a deal page as the FULL conversation reader (the same rich
// view used in the Emails inbox), not a cramped single-message popup — so admins
// /directors see other people's deal emails exactly as they see their own. The
// thread bodies load by thread id (not mailbox owner), so any deal you can see,
// you can read in full. Resolves the clicked message's thread from the loaded
// deal detail and hands it to the embedded ConversationView.
export function ThreadViewerModal({ gmailMessageId, dealId, onClose }) {
  const { state } = useStore();
  const detail = state.dealDetail?.[dealId];
  const deal = detail || state.deals?.[dealId] || null;
  const emails = detail?.emails || [];
  // The deal rows carry the gmail thread id; fall back to the message id (a
  // single-message "thread") if it isn't loaded yet.
  const threadId = useMemo(() => {
    const m = emails.find((e) => e.gmailMessageId === gmailMessageId);
    return m?.gmailThreadId || gmailMessageId;
  }, [emails, gmailMessageId]);
  const connected = !!(state.gmailAccount && state.gmailAccount.connected);
  const openRef = useMemo(() => ({ kind: 'db', threadId, unread: false }), [threadId]);

  return (
    <Modal onClose={onClose} maxWidth={920}>
      <ConversationView
        openRef={openRef}
        folder="deals"
        connected={connected}
        embedded
        contextDeal={deal}
        onBack={onClose}
      />
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

// Purchase-order card for PO-route deals. Records/edits the received PO number
// (which becomes the invoice reference) and stores the uploaded PO documents
// (multiple files, Blob-backed). Sits above the Invoices card.
function PurchaseOrderCard({ dealId, po, isMobile }) {
  const { actions, showMsg } = useStore();
  const received = !!po.receivedAt;
  const [editing, setEditing] = useState(false);
  const [poNumber, setPoNumber] = useState(po.number || '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  const files = po.files || [];

  useEffect(() => { setPoNumber(po.number || ''); }, [po.number]);

  const save = async () => {
    const num = poNumber.trim();
    if (!num) return;
    setSaving(true);
    try {
      await actions.markDealPoReceived(dealId, num);
      showMsg(received ? 'PO number updated' : 'PO marked received');
      setEditing(false);
    } catch (e) { showMsg(e.message || 'Could not save PO number'); }
    finally { setSaving(false); }
  };
  const clear = async () => {
    if (!window.confirm('Clear the PO number (mark this PO as not received)?')) return;
    try { await actions.clearDealPo(dealId); setEditing(false); showMsg('PO cleared'); }
    catch (e) { showMsg(e.message || 'Could not clear PO'); }
  };
  const handleFiles = async (fileList) => {
    const list = Array.from(fileList || []);
    if (!list.length) return;
    const tooBig = list.find(f => f.size > 20 * 1024 * 1024);
    if (tooBig) { showMsg(`"${tooBig.name}" is too large (max 20 MB)`); return; }
    setUploading(true);
    try {
      for (const f of list) await actions.uploadDealPoFile(dealId, f);
      showMsg(list.length === 1 ? 'PO uploaded' : `${list.length} files uploaded`);
    } catch (e) { showMsg(e.message || 'Upload failed'); }
    finally { setUploading(false); if (inputRef.current) inputRef.current.value = ''; }
  };
  const download = async (fileId) => {
    try { const { downloadUrl } = await actions.getPoFileDownloadUrl(dealId, fileId); window.open(downloadUrl, '_blank', 'noopener,noreferrer'); }
    catch { showMsg('Could not generate download link'); }
  };
  const remove = async (fileId, filename) => {
    if (!window.confirm(`Delete "${filename}"?`)) return;
    try { await actions.deleteDealPoFile(dealId, fileId); showMsg('File deleted'); }
    catch (e) { showMsg(e.message || 'Could not delete file'); }
  };

  return (
    <Card title="Purchase order" count={files.length}>
      {/* Status + number. Awaiting (amber) until received, then green with the number. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '4px 0 12px' }}>
        {!editing ? (
          <>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: received ? '#15803D' : '#B45309', background: received ? '#ECFDF3' : '#FFFBEB', padding: '3px 8px', borderRadius: 5 }}>
              {received ? 'Received' : 'Awaiting PO'}
            </span>
            {received && <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>PO {po.number}</span>}
            <span style={{ flex: 1 }} />
            <button onClick={() => setEditing(true)} className="btn-ghost" style={{ fontSize: 12 }}>
              <Edit2 size={12} /> {received ? 'Edit number' : 'Mark received'}
            </button>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', width: '100%' }}>
            <input
              type="text"
              value={poNumber}
              autoFocus
              onChange={(e) => setPoNumber(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditing(false); setPoNumber(po.number || ''); } }}
              className="input"
              placeholder="PO number (e.g. 4500012345)"
              style={{ flex: 1, minWidth: 160 }}
            />
            <button onClick={save} className="btn-primary" disabled={saving || !poNumber.trim()} style={{ fontSize: 12 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { setEditing(false); setPoNumber(po.number || ''); }} className="btn-ghost" style={{ fontSize: 12 }}>Cancel</button>
            {received && <button onClick={clear} className="btn-ghost" style={{ fontSize: 12, color: '#B91C1C' }}>Clear</button>}
          </div>
        )}
      </div>

      {/* Upload zone — accepts multiple files (clients sometimes raise more than one PO). */}
      <input ref={inputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => handleFiles(e.target.files)} />
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!uploading) handleFiles(e.dataTransfer.files); }}
        onClick={() => { if (!uploading) inputRef.current?.click(); }}
        style={{ border: '1px dashed ' + (dragOver ? BRAND.blue : BRAND.border), borderRadius: 8, padding: '12px 14px', textAlign: 'center', fontSize: 12, color: BRAND.muted, cursor: uploading ? 'not-allowed' : 'pointer', background: dragOver ? '#F0F9FF' : BRAND.paper }}
      >
        {uploading ? 'Uploading…' : 'Drop PO documents here or click to upload (PDF/images, multiple allowed, max 20 MB each)'}
      </div>

      <div style={{ marginTop: 8 }}>
        {files.length === 0 ? (
          <Empty text="No PO documents uploaded yet" />
        ) : files.map((f) => (
          <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderTop: '1px solid ' + BRAND.border }}>
            <FileText size={15} style={{ color: BRAND.muted, flexShrink: 0 }} />
            <button onClick={() => download(f.id)} title="Download" style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 13, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {f.filename}
            </button>
            <button onClick={() => download(f.id)} className="btn-icon" title="Download"><Download size={14} /></button>
            <button onClick={() => remove(f.id, f.filename)} className="btn-icon" title="Delete"><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function FilesCard({ dealId, files, driveEnabled, driveFolderId }) {
  const { actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null); // { loaded, total } in bytes
  const [dragOver, setDragOver] = useState(false);
  const inputRef = React.useRef(null);
  const abortRef = React.useRef(null);
  const [syncing, setSyncing] = useState(false);
  const [settingUp, setSettingUp] = useState(false);

  // Drive folder browser. path[0] is the deal root (id=null → the server uses
  // the deal's root folder); the last entry is the folder currently open.
  const [path, setPath] = useState([{ id: null, name: 'Files' }]);
  const [contents, setContents] = useState(null); // { folders, files } | null
  const [loadingContents, setLoadingContents] = useState(false);
  const currentFolderId = path[path.length - 1].id;
  const currentFolderName = path[path.length - 1].name;

  const cancelUpload = () => { abortRef.current?.abort(); };

  // Load one folder's contents (subfolders + files) from Drive.
  const loadContents = React.useCallback(async (folderId) => {
    if (!driveEnabled || !driveFolderId) { setContents(null); return; }
    setLoadingContents(true);
    try {
      const resp = await actions.loadDealFolderContents(dealId, folderId);
      setContents({ folders: resp?.folders || [], files: resp?.files || [] });
    } catch {
      setContents({ folders: [], files: [] });
    } finally {
      setLoadingContents(false);
    }
  }, [actions, dealId, driveEnabled, driveFolderId]);

  useEffect(() => { loadContents(currentFolderId); }, [loadContents, currentFolderId]);

  // Deal folders in Drive tagged with this deal but not the one we're using —
  // leftovers from the old create-race. Merge and trash them by hand in Drive;
  // they can hold real work, so nothing here deletes them.
  const [dupeFolders, setDupeFolders] = useState([]);
  useEffect(() => {
    if (!driveEnabled || !driveFolderId) { setDupeFolders([]); return; }
    let live = true;
    actions.loadDealDuplicateFolders(dealId)
      .then((resp) => { if (live) setDupeFolders(resp?.duplicates || []); })
      .catch(() => { if (live) setDupeFolders([]); });
    return () => { live = false; };
  }, [actions, dealId, driveEnabled, driveFolderId]);

  const openFolder = (folder) => setPath((p) => [...p, { id: folder.id, name: folder.name }]);
  const goToCrumb = (idx) => setPath((p) => p.slice(0, idx + 1));

  // Create the standard production subfolder template in the Drive folder.
  // Idempotent server-side, so it's safe to click more than once.
  const setupFolders = async () => {
    setSettingUp(true);
    try {
      await actions.setupDealFolders(dealId);
      await loadContents(currentFolderId);
      showMsg('Folder structure set up');
    } catch (e) {
      showMsg(e?.message || 'Could not set up folders');
    } finally {
      setSettingUp(false);
    }
  };

  // Re-pull the deal + current folder so the view reflects files added or
  // deleted directly in Drive.
  const syncFromDrive = async () => {
    setSyncing(true);
    try {
      await Promise.all([actions.loadDealDetail(dealId), loadContents(currentFolderId)]);
      showMsg('Synced with Drive');
    } catch {
      showMsg('Could not sync with Drive');
    } finally {
      setSyncing(false);
    }
  };

  // Drive uploads are chunked, so they're not bound by the serverless body
  // limit — allow large video files. Blob (Drive off) stays capped at 20 MB.
  const maxBytes = driveEnabled ? 5 * 1024 * 1024 * 1024 : 20 * 1024 * 1024;
  const maxLabel = driveEnabled ? '5 GB' : '20 MB';

  const handleFiles = async (fileList) => {
    const list = Array.from(fileList || []);
    if (!list.length) return;
    const tooBig = list.find(f => f.size > maxBytes);
    if (tooBig) { showMsg(`"${tooBig.name}" is too large (max ${maxLabel})`); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setUploading(true);
    // Upload one at a time so the count + progress are unambiguous. Files land in
    // whichever folder is currently open (currentFolderId; null = root).
    try {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        setProgress({ fileIndex: i, fileCount: list.length, loaded: 0, total: f.size || 0 });
        await actions.uploadDealFile(dealId, f, (loaded, total) => {
          setProgress({ fileIndex: i, fileCount: list.length, loaded, total: total || f.size || 0 });
        }, controller.signal, currentFolderId);
      }
      showMsg(list.length === 1 ? 'File uploaded' : `${list.length} files uploaded`);
      await loadContents(currentFolderId);
    } catch (err) {
      showMsg(err?.name === 'AbortError' ? 'Upload cancelled' : (err.message || 'Upload failed'));
    } finally {
      setUploading(false);
      setProgress(null);
      abortRef.current = null;
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
    : null;

  // Drive browser: download a file straight from Drive (uses the user's Google
  // session). Delete removes it from Drive (and any deal_files row).
  const downloadDriveFile = (f) => {
    const url = f.driveFileId
      ? `https://drive.google.com/uc?export=download&id=${f.driveFileId}`
      : f.webViewLink;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else showMsg('No download link for this file');
  };
  const deleteDriveFile = async (f) => {
    if (!window.confirm(`Delete "${f.name}"?`)) return;
    try {
      await actions.deleteDealDriveFile(dealId, f.driveFileId);
      await loadContents(currentFolderId);
      showMsg('File deleted');
    } catch (e) {
      showMsg(e?.message || 'Could not delete file');
    }
  };

  // Non-Drive (Blob) file rows still use the deal_files-keyed handlers.
  const handleDownloadBlob = async (fileId) => {
    try {
      const { downloadUrl } = await actions.getFileDownloadUrl(dealId, fileId);
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
    } catch {
      showMsg('Could not generate download link');
    }
  };
  const handleDeleteBlob = async (fileId, filename) => {
    if (!window.confirm(`Delete "${filename}"?`)) return;
    await actions.deleteDealFile(dealId, fileId);
    showMsg('File deleted');
  };

  const itemCount = driveEnabled
    ? (contents ? contents.folders.length + contents.files.length : 0)
    : files.length;
  const isEmptyHere = driveEnabled
    ? (contents && contents.folders.length === 0 && contents.files.length === 0)
    : files.length === 0;

  const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderTop: '1px solid ' + BRAND.border };

  return (
    <Card title="Files" count={itemCount} action={
      uploading
        ? <button className="btn-ghost" onClick={cancelUpload}><X size={12} /> Cancel</button>
        : (
          <div style={{ display: 'flex', gap: 6 }}>
            {driveEnabled && (
              <button className="btn-ghost" onClick={setupFolders} disabled={settingUp} title="Create the standard production folder structure in Drive">
                <FolderPlus size={12} /> {settingUp ? 'Setting up…' : 'Set up folders'}
              </button>
            )}
            {driveEnabled && (
              <button className="btn-ghost" onClick={syncFromDrive} disabled={syncing} title="Re-sync with the Drive folder">
                <RefreshCw size={12} /> {syncing ? 'Syncing…' : 'Sync'}
              </button>
            )}
            <button className="btn-ghost" onClick={() => inputRef.current?.click()}><Plus size={12} /> Upload</button>
          </div>
        )
    }>
      <input ref={inputRef} type="file" multiple style={{ display: 'none' }}
        onChange={(e) => handleFiles(e.target.files)} />
      {driveEnabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 11, color: BRAND.muted }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#1D4ED8' }} />
            Synced to your Team Drive
          </span>
          {driveFolderId && (
            <a
              href={`https://drive.google.com/drive/folders/${currentFolderId || driveFolderId}`}
              target="_blank" rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: BRAND.blue, fontWeight: 600, textDecoration: 'none' }}
            >
              Open in Drive <ExternalLink size={11} />
            </a>
          )}
        </div>
      )}
      {dupeFolders.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: '#FEF3C7', border: '1px solid #FCD34D', fontSize: 12, color: '#92400E' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              {dupeFolders.length === 1 ? 'A duplicate Drive folder' : dupeFolders.length + ' duplicate Drive folders'} for this project
            </div>
            <div style={{ marginBottom: 4 }}>
              Files above live in the folder the CRM is using. Move anything worth keeping out of the duplicates, then delete them in Drive.
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {dupeFolders.map((f) => (
                <a key={f.id} href={f.webViewLink || `https://drive.google.com/drive/folders/${f.id}`}
                  target="_blank" rel="noopener noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#92400E', fontWeight: 600 }}>
                  {f.name} <ExternalLink size={11} />
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
      {/* Breadcrumb — click a crumb to jump back up the folder path. */}
      {driveEnabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 8, fontSize: 12.5 }}>
          {path.map((seg, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {i > 0 && <ChevronRight size={12} color={BRAND.muted} />}
              {i < path.length - 1 ? (
                <button
                  onClick={() => goToCrumb(i)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 0, padding: 0, color: BRAND.blue, cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit' }}
                >
                  {i === 0 && <Folder size={13} />}{seg.name}
                </button>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600, color: BRAND.ink }}>
                  {i === 0 && <Folder size={13} color={BRAND.muted} />}{seg.name}
                </span>
              )}
            </span>
          ))}
        </div>
      )}
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
          textAlign: 'center', marginBottom: 10,
        }}
      >
        {uploading
          ? (
            <div onClick={(e) => e.stopPropagation()} style={{ cursor: 'default' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                <span>
                  {progress && progress.fileCount > 1
                    ? `Uploading file ${progress.fileIndex + 1} of ${progress.fileCount}…`
                    : 'Uploading…'}
                  {pct != null ? ` ${pct}%` : ''}
                </span>
                <button
                  onClick={cancelUpload}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent', color: '#DC2626', fontWeight: 600, fontSize: 12, cursor: 'pointer', padding: 0 }}
                >
                  <X size={12} /> Cancel
                </button>
              </div>
              <div style={{ height: 6, borderRadius: 999, background: BRAND.border, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: (pct != null ? pct : 0) + '%', background: BRAND.blue, borderRadius: 999, transition: 'width 0.2s ease' }} />
              </div>
            </div>
          )
          : driveEnabled
            ? `Drop files here — they'll save to "${currentFolderName}"`
            : 'Drop files here or click Upload'}
      </div>

      {/* Drive folder browser */}
      {driveEnabled ? (
        <>
          {loadingContents && !contents && <div style={{ padding: '10px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>}
          {isEmptyHere && !uploading && <Empty text="This folder is empty" />}
          {contents && contents.folders.map((folder) => (
            <button
              key={folder.id}
              onClick={() => openFolder(folder)}
              style={{ ...rowStyle, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderTop: '1px solid ' + BRAND.border, cursor: 'pointer', fontFamily: 'inherit' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = BRAND.paper)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 6, background: '#EFF4FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Folder size={16} color={BRAND.blue} />
              </div>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {folder.name}
              </div>
              <ChevronRight size={16} color={BRAND.muted} />
            </button>
          ))}
          {contents && contents.files.map((f) => (
            <div key={f.driveFileId} style={rowStyle}>
              <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 6, background: '#F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <FileTypeTag mimeType={f.mimeType} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                <div style={{ fontSize: 11, color: BRAND.muted }}>
                  {fileSizeLabel(f.size)}{f.size ? ' · ' : ''}{formatRelativeTime(f.createdTime)}
                </div>
              </div>
              <button onClick={() => downloadDriveFile(f)}
                style={{ padding: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: BRAND.muted, display: 'flex' }}
                title="Download">
                <Download size={14} />
              </button>
              <button onClick={() => deleteDriveFile(f)}
                style={{ padding: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: BRAND.muted, display: 'flex' }}
                title="Delete file">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </>
      ) : (
        <>
          {files.length === 0 && !uploading && <Empty text="No files attached yet" />}
          {files.map(f => (
            <div key={f.id} style={rowStyle}>
              <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 6, background: '#F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <FileTypeTag mimeType={f.mimeType} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filename}</div>
                <div style={{ fontSize: 11, color: BRAND.muted, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span>{fileSizeLabel(f.sizeBytes)}{f.sizeBytes ? ' · ' : ''}{formatRelativeTime(f.createdAt)}{f.source === 'email' ? ' · from email' : ''}</span>
                  {f.source === 'portal' && (
                    <span style={{ background: '#2BB8E622', color: '#0B6E93', fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                      Portal
                    </span>
                  )}
                </div>
              </div>
              {f.uploadedBy && <Avatar email={f.uploadedBy} size={20} />}
              <button onClick={() => handleDownloadBlob(f.id)}
                style={{ padding: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: BRAND.muted, display: 'flex' }}
                title="Download">
                <Download size={14} />
              </button>
              <button onClick={() => handleDeleteBlob(f.id, f.filename)}
                style={{ padding: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: BRAND.muted, display: 'flex' }}
                title="Delete file">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </>
      )}
    </Card>
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
    case 'email_linked':  return p.scope === 'message' ? 'Email linked to this deal' : 'Conversation linked to this deal';
    case 'email_unlinked':return p.scope === 'message' ? 'Email unlinked from this deal' : 'Conversation unlinked from this deal';
    case 'note':          return p.text || 'Note added';
    case 'revision_draft_uploaded': return `Revised video uploaded: ${p.video || 'video'}${p.draft ? ` (draft ${p.draft})` : ''}`;
    case 'revision_completed':   return `Revision complete: ${p.video || 'video'}${p.draft ? ` (draft ${p.draft})` : ''}`;
    case 'revision_reopened':    return `Revision reopened: ${p.video || 'video'}${p.draft ? ` (draft ${p.draft})` : ''}`;
    case 'revision_assigned':    return `Revisions assigned${p.assignee ? ` to ${p.assignee}` : ''}`;
    case 'storyboard_draft_uploaded': return `Revised storyboard uploaded: ${p.storyboard || 'storyboard'}${p.draft ? ` (draft ${p.draft})` : ''}`;
    case 'storyboard_revision_completed': return `Storyboard revision complete: ${p.storyboard || 'storyboard'}${p.draft ? ` (draft ${p.draft})` : ''}`;
    case 'storyboard_revision_reopened':  return `Storyboard revision reopened: ${p.storyboard || 'storyboard'}${p.draft ? ` (draft ${p.draft})` : ''}`;
    case 'storyboard_revision_assigned':  return `Storyboard revisions assigned${p.assignee ? ` to ${p.assignee}` : ''}`;
    default:              return e.eventType;
  }
}

function labelForStage(id) {
  return PIPELINE_STAGES.find(s => s.id === id)?.label || id || '—';
}

// Marketing attribution summary for the lead that became this deal.
const LEAD_CHANNEL_BADGE = {
  paid_search: { label: 'Paid search', bg: '#E0F2FE', fg: '#0369A1' },
  social:      { label: 'Social',      bg: '#F3E8FF', fg: '#7C3AED' },
  organic:     { label: 'Organic',     bg: '#DCFCE7', fg: '#166534' },
  referral:    { label: 'Referral',    bg: '#FEF3C7', fg: '#92400E' },
  direct:      { label: 'Direct',      bg: '#F1F5F9', fg: '#475569' },
};
function LeadSourceCard({ src }) {
  const ch = LEAD_CHANNEL_BADGE[src.channel] || { label: src.channel || 'Unknown', bg: '#F1F5F9', fg: '#475569' };
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null);
  const fields = [
    ['Campaign', src.campaign],
    ['Keyword', src.keyword],
    ['Source / Medium', src.source && src.medium ? `${src.source} / ${src.medium}` : (src.source || src.medium)],
    ['Submitted', fmtDate(src.submittedAt)],
  ].filter(([, v]) => v);
  return (
    <div style={{ marginTop: 16, border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Lead source</h3>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.3, padding: '3px 10px', borderRadius: 999, background: ch.bg, color: ch.fg }}>
          {ch.label}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 0.4, padding: '2px 8px', borderRadius: 999,
          background: src.returningClient ? '#FEF3C7' : '#ECFDF5', color: src.returningClient ? '#92400E' : '#166534',
        }}>
          {src.returningClient ? 'Returning client' : 'New lead'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px 20px' }}>
        {fields.map(([k, v]) => (
          <div key={k}>
            <div style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 }}>{k}</div>
            <div style={{ fontSize: 13, color: BRAND.ink, wordBreak: 'break-word' }}>{v}</div>
          </div>
        ))}
      </div>
      {src.landingUrl && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 }}>Landing page</div>
          <a href={src.landingUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: BRAND.blue, wordBreak: 'break-all' }}>{src.landingUrl}</a>
        </div>
      )}
    </div>
  );
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
  const { state, actions, showMsg } = useStore();
  const [title, setTitle] = useState(deal.title || '');
  const [value, setValue] = useState(deal.value != null ? String(deal.value) : '');
  // VAT rate is stored as a fraction (0.2); the field edits it as a percent.
  // Defaults to 20% when unset (the UK standard rate).
  const [vatPct, setVatPct] = useState(deal.vatRate != null ? String(+(deal.vatRate * 100).toFixed(2)) : '20');
  const [companyId, setCompanyId] = useState(deal.companyId || '');
  // Toggle + busy flag for linking the organisation from Xero (find-or-create a
  // local company from a Xero contact, then select it).
  const [linkingXero, setLinkingXero] = useState(false);
  const [importingXero, setImportingXero] = useState(false);
  const [primaryContactId, setPrimaryContactId] = useState(deal.primaryContactId || '');
  const [ownerEmail, setOwnerEmail] = useState(deal.ownerEmail || '');
  const [notes, setNotes] = useState(deal.notes || '');
  const [submitting, setSubmitting] = useState(false);

  // Inline "create a contact" within the Primary-contact field, so a new lead
  // doesn't have to be added on the Contacts page first.
  const [addingContact, setAddingContact] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactEmail, setNewContactEmail] = useState('');
  const [newContactCompanyId, setNewContactCompanyId] = useState(deal.companyId || '');
  const [newCompanyName, setNewCompanyName] = useState('');
  const [creatingContact, setCreatingContact] = useState(false);
  const [contactErr, setContactErr] = useState('');

  // Additional (secondary) contacts on the deal — managed live (added/removed
  // immediately, like the deal page's Contacts row), independent of the form's
  // Save. Read from the live detail so chips update as they're added/removed.
  const [pickingExtra, setPickingExtra] = useState(false);
  const [creatingExtra, setCreatingExtra] = useState(null); // { email?, name? } prefill
  const secondaryContacts = state.dealDetail?.[deal.id]?.secondaryContacts || [];

  const companies = Object.values(state.companies || {});
  const contacts = Object.values(state.contacts || {});
  const users = Object.values(state.users || {});

  const createContact = async () => {
    const name = newContactName.trim();
    const email = newContactEmail.trim();
    if (!name && !email) return;
    setCreatingContact(true);
    setContactErr('');
    try {
      // Resolve the company link. '' = None; '__new__' = create a company from
      // the typed name first, then link the contact (and the deal, if it has no
      // company yet) to it. Otherwise link to the chosen existing company.
      let linkCompanyId = newContactCompanyId;
      if (newContactCompanyId === '__new__') {
        const cn = newCompanyName.trim();
        if (!cn) { setContactErr('Enter a company name'); setCreatingContact(false); return; }
        const co = await actions.createCompany({ name: cn });
        if (!co?.id) throw new Error('Could not create company');
        linkCompanyId = co.id;
      }
      const c = await actions.createContact({ name: name || null, email: email || null, companyId: linkCompanyId || null });
      if (c?.id) {
        setPrimaryContactId(c.id);
        // If we created a company and the deal has none, link the deal to it too.
        if (linkCompanyId && !companyId) setCompanyId(linkCompanyId);
        setAddingContact(false);
        setNewContactName('');
        setNewContactEmail('');
        setNewCompanyName('');
      }
    } catch (e) {
      setContactErr(e?.message || 'Could not create contact');
    } finally {
      setCreatingContact(false);
    }
  };

  // Picked a Xero contact → find-or-create the matching local organisation and
  // select it on the deal. The new company lands in state.companies, so the
  // select below shows it immediately.
  const pickXeroOrg = async (xeroContact) => {
    if (!xeroContact?.id) return;
    setImportingXero(true);
    try {
      const co = await actions.importCompanyFromXero(xeroContact.id);
      if (co?.id) { setCompanyId(co.id); setLinkingXero(false); }
    } catch (err) {
      showMsg(err?.message || 'Could not link Xero organisation');
    } finally {
      setImportingXero(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    await actions.saveDeal(deal.id, {
      title: title.trim(),
      value: value === '' ? null : Number(value),
      vatRate: vatPct === '' ? null : Number(vatPct) / 100,
      companyId: companyId || null,
      primaryContactId: primaryContactId || null,
      ownerEmail: ownerEmail || null,
      notes: notes || null,
    });
    setSubmitting(false);
    onClose();
  };

  return (
    <Modal onClose={onClose} dismissible={false} showClose>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>Edit deal</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <FormRow label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></FormRow>
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 2 }}><FormRow label="Value (£, ex VAT)"><input className="input" type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} /></FormRow></div>
          <div style={{ flex: 1 }}><FormRow label="VAT rate (%)"><input className="input" type="number" min="0" max="100" step="0.1" value={vatPct} onChange={(e) => setVatPct(e.target.value)} /></FormRow></div>
        </div>
        <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Organisation</span>
          {!linkingXero ? (
            <>
              <select className="input" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                <option value="">—</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button type="button" onClick={() => setLinkingXero(true)} className="btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 12, marginTop: 2 }}>+ Link from Xero</button>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 10, background: BRAND.paper }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: BRAND.muted }}>Search Xero contacts — links (or creates) the matching organisation.</span>
              <XeroContactPicker
                value={null}
                onChange={(c) => { if (c) pickXeroOrg(c); }}
                autoFocus
                placeholder="Search Xero contacts…"
                creatingNew={importingXero}
              />
              <button type="button" onClick={() => setLinkingXero(false)} disabled={importingXero} className="btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 12 }}>Cancel</button>
            </div>
          )}
        </div>
        {/* Rendered as a div (not FormRow's <label>) so the nested inputs/buttons
            of the inline add-contact form don't fight the label association. */}
        <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Primary contact</span>
          {!addingContact ? (
            <>
              <select className="input" value={primaryContactId} onChange={(e) => setPrimaryContactId(e.target.value)}>
                <option value="">—</option>
                {contacts.map(c => <option key={c.id} value={c.id}>{c.name || c.email}</option>)}
              </select>
              <button type="button" onClick={() => { setAddingContact(true); setNewContactCompanyId(companyId || ''); setNewCompanyName(''); setContactErr(''); }} className="btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 12, marginTop: 2 }}>+ New contact</button>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 10, background: BRAND.paper }}>
              {/* autoComplete off + a non-standard name: stop Edge/Chrome autofill
                  from clobbering the typed value (it would replace a full name
                  with a single profile token on blur). */}
              <input className="input" autoFocus placeholder="Name" name="squideo-contact-name" autoComplete="off" value={newContactName} onChange={(e) => setNewContactName(e.target.value)} />
              <input className="input" type="email" placeholder="Email" name="squideo-contact-email" autoComplete="off" value={newContactEmail} onChange={(e) => setNewContactEmail(e.target.value)} />
              <label style={{ fontSize: 11, fontWeight: 600, color: BRAND.muted, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span>Organisation</span>
                <select className="input" value={newContactCompanyId} onChange={(e) => setNewContactCompanyId(e.target.value)}>
                  <option value="">None</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  <option value="__new__">+ New organisation…</option>
                </select>
              </label>
              {newContactCompanyId === '__new__' && (
                <input className="input" autoFocus placeholder="New company name" name="squideo-new-company" autoComplete="off" value={newCompanyName} onChange={(e) => setNewCompanyName(e.target.value)} />
              )}
              {contactErr && <div style={{ color: '#DC2626', fontSize: 12 }}>{contactErr}</div>}
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" onClick={createContact} disabled={creatingContact || (!newContactName.trim() && !newContactEmail.trim()) || (newContactCompanyId === '__new__' && !newCompanyName.trim())} className="btn" style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}>{creatingContact ? 'Adding…' : 'Add contact'}</button>
                <button type="button" onClick={() => { setAddingContact(false); setNewContactName(''); setNewContactEmail(''); setNewCompanyName(''); setContactErr(''); }} className="btn-ghost" style={{ fontSize: 12 }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
        {/* Additional contacts — added/removed immediately (like the deal page's
            Contacts row), so you can attach more people without leaving Edit. */}
        <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>Additional contacts</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {secondaryContacts.length === 0 && <span style={{ fontSize: 12, color: BRAND.muted }}>None yet</span>}
            {secondaryContacts.map((c) => (
              <ContactChip key={c.id} contact={c} label="secondary" removable onRemove={() => actions.removeDealContact(deal.id, c.id)} />
            ))}
            <button type="button" onClick={() => setPickingExtra(true)} className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}>
              <Plus size={12} /> Add contact
            </button>
          </div>
        </div>
        <FormRow label="Deal Owner">
          <select className="input" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)}>
            <option value="">—</option>
            {/* Marketers never own deals — keep them out of the picker (but never
                drop a marketer who's somehow already the set owner). */}
            {users.filter(u => u.role !== 'marketing' || u.email === ownerEmail).map(u => <option key={u.email} value={u.email}>{u.name || u.email}</option>)}
          </select>
        </FormRow>
        <FormRow label="Notes"><textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ fontFamily: 'inherit', resize: 'vertical' }} /></FormRow>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={submitting}>{submitting ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
      {pickingExtra && (
        <PickContactModal
          dealId={deal.id}
          excludeIds={new Set([primaryContactId, ...secondaryContacts.map(c => c.id)].filter(Boolean))}
          defaultCompanyId={companyId || null}
          onClose={() => setPickingExtra(false)}
          onPickExisting={async (contactId) => {
            try { await actions.addDealContact(deal.id, { contactId }); setPickingExtra(false); }
            catch (e) { setContactErr(e?.message || 'Could not add contact'); }
          }}
          onCreateNew={(prefill) => { setPickingExtra(false); setCreatingExtra(prefill || {}); }}
        />
      )}
      {creatingExtra && (
        <CreateContactModal
          dealId={deal.id}
          defaultCompanyId={companyId || null}
          prefill={creatingExtra}
          onClose={() => setCreatingExtra(null)}
          onCreated={() => setCreatingExtra(null)}
        />
      )}
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

// Modal for the deal's "Create or link proposal" button. Offers creating a
// fresh proposal, or linking an existing proposal. "Linkable" means a proposal
// with no deal, or one attached only to its own auto-created shadow deal
// (deterministic id `deal_<proposalId>`) — those shadows are just a side-effect
// of saving a standalone proposal, so they're fair game to re-point at a real
// deal. Proposals whose contact/company/name match this deal are surfaced as
// suggestions at the top.
function CreateOrLinkProposalModal({ deal, contact, company, onClose, onCreate, onLink }) {
  const { state } = useStore();
  const [query, setQuery] = useState('');
  const [linkingId, setLinkingId] = useState(null);

  // Why a proposal looks connected to this deal (null = no obvious link).
  const suggestionReason = (p) => {
    const norm = (s) => String(s || '').trim().toLowerCase();
    if (p._contactId && deal?.primaryContactId && p._contactId === deal.primaryContactId) return 'Same contact';
    if (p._companyId && deal?.companyId && p._companyId === deal.companyId) return 'Same company';
    const pc = norm(p.clientName);
    const pb = norm(p.contactBusinessName);
    if (pc && pc === norm(contact?.name)) return 'Matches contact name';
    if (pb && (pb === norm(company?.name) || pb === norm(deal?.title))) return 'Matches company';
    return null;
  };

  const linkable = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.entries(state.proposals || {})
      .map(([id, p]) => ({ id, ...p, _reason: null }))
      .filter((p) => !p.archived && (!p._dealId || p._dealId === 'deal_' + p.id))
      .map((p) => ({ ...p, _reason: suggestionReason(p) }))
      .filter((p) => {
        if (!q) return true;
        const hay = `${p.clientName || ''} ${p.contactBusinessName || ''} ${p.proposalTitle || ''} ${formatProposalNumber(p._number) || ''}`.toLowerCase();
        return hay.includes(q);
      })
      // Suggested first, then newest.
      .sort((a, b) => {
        if (!!a._reason !== !!b._reason) return a._reason ? -1 : 1;
        return String(b._createdAt || '').localeCompare(String(a._createdAt || ''));
      });
  }, [state.proposals, query, deal, contact, company]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderRow = (p) => {
    const num = formatProposalNumber(p._number);
    const signed = !!p._signature;
    const price = p.totalExVat ?? p.basePrice;
    return (
      <button
        key={p.id}
        disabled={!!linkingId}
        onClick={() => { setLinkingId(p.id); onLink(p.id); }}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          width: '100%', padding: '8px 10px', background: 'white',
          border: '1px solid ' + (p._reason ? '#86EFAC' : BRAND.border), borderRadius: 6,
          cursor: linkingId ? 'default' : 'pointer', textAlign: 'left', fontFamily: 'inherit',
          opacity: linkingId && linkingId !== p.id ? 0.5 : 1,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {num ? <span style={{ color: BRAND.muted, fontSize: 11 }}>{num}</span> : null}
            <span>{p.clientName || p.contactBusinessName || 'Untitled'}</span>
            {signed ? <Badge color="green">Signed</Badge> : <Badge color="grey">Unsigned</Badge>}
            {p._reason ? <Badge color="green">{p._reason}</Badge> : null}
          </div>
          {price != null && (
            <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>{formatGBP(price)} ex VAT</div>
          )}
        </div>
        <span style={{ fontSize: 12, color: BRAND.blue, fontWeight: 600, whiteSpace: 'nowrap' }}>
          {linkingId === p.id ? 'Linking…' : 'Link'}
        </span>
      </button>
    );
  };

  const suggested = linkable.filter((p) => p._reason);
  const others = linkable.filter((p) => !p._reason);

  return (
    <Modal onClose={onClose} maxWidth={520}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700 }}>Add a proposal</h2>
      <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 16px' }}>
        Create a new proposal for this deal, or link an existing one that isn't attached to a deal yet.
      </p>

      <button
        onClick={onCreate}
        className="btn"
        style={{ width: '100%', justifyContent: 'center', background: '#22C55E', borderColor: '#22C55E', color: '#fff', marginBottom: 18 }}
      ><FileText size={14} /> Create new proposal</button>

      <input
        className="input"
        placeholder="Search proposals to link…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ width: '100%', marginBottom: 10, boxSizing: 'border-box' }}
      />
      <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {linkable.length === 0 && (
          <div style={{ fontSize: 13, color: BRAND.muted, fontStyle: 'italic', padding: '8px 2px' }}>
            {query.trim() ? 'No matching proposals.' : 'No proposals available to link.'}
          </div>
        )}
        {suggested.length > 0 && (
          <div style={{ fontSize: 12, fontWeight: 600, color: '#16A34A', textTransform: 'uppercase', letterSpacing: 0.4, padding: '2px 2px' }}>
            Suggested — looks connected to this deal
          </div>
        )}
        {suggested.map(renderRow)}
        {others.length > 0 && (
          <div style={{ fontSize: 12, fontWeight: 600, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, padding: suggested.length ? '8px 2px 2px' : '2px 2px' }}>
            {suggested.length ? 'Other proposals' : 'Unassigned proposals'}
          </div>
        )}
        {others.map(renderRow)}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
        <button onClick={onClose} className="btn-ghost">Cancel</button>
      </div>
    </Modal>
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

export function EmailComposerModal({ deal, contact, initialDraft = null, onClose, onSent, onViewThread, inline = false, threadDraftKey = null, draftMode = null }) {
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
  // Undo-send: hitting Send starts an 8s countdown before the email actually
  // goes out, with an Undo to call it off. null = not counting down.
  const SEND_DELAY_SECONDS = 8;
  const [countdown, setCountdown] = useState(null);
  const sendTimeoutRef = useRef(null);
  const sendIntervalRef = useRef(null);
  // Holds the "Send & create follow-up" task payload while the undo window runs.
  // The task is only created once the email actually sends (in doSend), so an
  // Undo cancels the task too. A ref (not state) so the deferred doSend reads
  // the latest value without a stale closure.
  const pendingFollowUpRef = useRef(null);
  // Attachment refs uploaded to the temporary email-attachments blob store.
  // Each: { id, filename, mimeType, sizeBytes, blobUrl?, blobPathname?, uploading?, error? }.
  const [attachments, setAttachments] = useState(initialDraft?.attachments ?? []);
  const fileInputRef = useRef(null);
  // Shared by the body editor and its toolbar (the toolbar sits below the
  // signature but drives this same contentEditable element).
  const editorRef = useRef(null);
  // Scheduled-send popover state.
  const [showSchedule, setShowSchedule] = useState(false);
  // "Send & create follow-up" task-box state.
  const [showFollowUp, setShowFollowUp] = useState(false);
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

  // Esc closes the composer — preserves the Modal-era keyboard affordance
  // even though we no longer render through Modal.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Autosave as the user types, so navigating away or refreshing never loses
  // the draft. Debounced. The dock composer persists into composerContext (which
  // survives a reload) without changing sessionId, so the live editor isn't
  // remounted. The inline reply composer is unmounted on navigation, so it
  // instead mirrors its content into a per-thread draft slot (keyed by thread
  // id) — but only once there's something worth keeping, so an untouched reply
  // doesn't linger and auto-reopen.
  useEffect(() => {
    const t = setTimeout(() => {
      const cleanAttachments = attachments.filter(a => a.blobUrl && !a.uploading);
      if (inline) {
        if (!threadDraftKey) return;
        const bodyText = String(body || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
        const hasContent = !!bodyText || /<img\b/i.test(String(body || '')) || cleanAttachments.length > 0;
        if (hasContent) {
          actions.saveThreadDraft(threadDraftKey, {
            to, cc, bcc, subject, body,
            gmailThreadId: replyThreadId || threadDraftKey,
            extraDeals, attachments: cleanAttachments,
            mode: draftMode || 'reply',
          });
        } else {
          actions.clearThreadDraft(threadDraftKey);
        }
        return;
      }
      actions.autosaveComposerDraft({
        to, cc, bcc, subject, body,
        gmailThreadId: replyThreadId || null,
        extraDeals,
        attachments: cleanAttachments,
      });
    }, 500);
    return () => clearTimeout(t);
  }, [inline, threadDraftKey, draftMode, to, cc, bcc, subject, body, extraDeals, attachments]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Only adopt the template's subject when the composer doesn't already have
    // one — a reply (or anything mid-typed) keeps its subject rather than being
    // overwritten, so you never have to re-type "Re: …".
    if (t.subject && !subject.trim()) setSubject(t.subject);
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

  // Core send, returns true on success. Shared by the Send button and the
  // "send & create follow-up" flow.
  const doSend = async () => {
    if (!to.trim() || !subject.trim() || bodyEmpty || sending || anyUploading) return false;
    setError('');
    setSending(true);
    try {
      const resp = await actions.sendGmail(buildPayload());
      if (!resp?.ok) throw new Error('Send failed');
      // The email actually went out — only now create the deferred follow-up
      // task (if this was a "Send & create follow-up"). Doing it here, after the
      // undo window elapsed, means an Undo cancels the task as well. Created
      // before onSent so the deal reload it triggers already includes the task.
      let followUpFailed = false;
      if (pendingFollowUpRef.current) {
        const fu = pendingFollowUpRef.current;
        pendingFollowUpRef.current = null;
        try { await actions.createTask(fu); } catch { followUpFailed = true; }
      }
      showMsg(followUpFailed ? 'Email sent — but the follow-up task could not be created.' : 'Email sent');
      onSent?.();
      return true;
    } catch (err) {
      const msg = err?.message || 'Failed to send';
      if (msg.toLowerCase().includes('not connected') || msg.toLowerCase().includes('reauth') || msg.toLowerCase().includes('expired')) {
        setError(msg + ' Open Account → Gmail integration to connect.');
      } else {
        setError(msg);
      }
      return false;
    } finally {
      setSending(false);
    }
  };

  const clearSendTimers = () => {
    if (sendTimeoutRef.current) { clearTimeout(sendTimeoutRef.current); sendTimeoutRef.current = null; }
    if (sendIntervalRef.current) { clearInterval(sendIntervalRef.current); sendIntervalRef.current = null; }
  };

  // Start the undo window: count down from 8s, then actually send. doSend's
  // success path closes/refreshes; on failure the composer stays open.
  const beginSend = () => {
    if (!canSend || countdown != null) return;
    setError('');
    setCountdown(SEND_DELAY_SECONDS);
    sendIntervalRef.current = setInterval(() => {
      setCountdown((c) => (c != null && c > 1 ? c - 1 : c));
    }, 1000);
    sendTimeoutRef.current = setTimeout(async () => {
      clearSendTimers();
      setCountdown(null);
      await doSend();
    }, SEND_DELAY_SECONDS * 1000);
  };

  const undoSend = () => {
    clearSendTimers();
    setCountdown(null);
    // Cancel any deferred follow-up task — the send didn't happen, so neither
    // should the task.
    pendingFollowUpRef.current = null;
  };

  // "Send now": skip the rest of the undo window and fire immediately. Same
  // path doSend would have taken when the timer elapsed.
  const sendNow = () => {
    if (countdown == null) return;
    clearSendTimers();
    setCountdown(null);
    doSend();
  };

  // Cancel a pending send if the composer unmounts (closed/navigated away) so a
  // half-counted email never fires after the UI is gone.
  useEffect(() => clearSendTimers, []);

  const submit = (e) => { e.preventDefault(); beginSend(); };

  // "Send & create follow-up": open the task box (prefilled for this deal, a few
  // days out) to set the follow-up; once the task is created we send the email.
  const canSend = gmailConnected && !sending && !anyUploading && !!to.trim() && !!subject.trim() && !bodyEmpty;
  const openFollowUp = () => { if (canSend) setShowFollowUp(true); };
  // The follow-up task box hands its values back here (it does NOT create the
  // task itself). We stash them and start the same 8-second undo window as the
  // plain Send; doSend creates the task only once the email truly goes out, and
  // Undo discards both. The footer then shows "Sending in Ns… / Undo send".
  const onFollowUpValues = (values) => {
    pendingFollowUpRef.current = values;
    setShowFollowUp(false);
    beginSend();
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
                  <div style={{ padding: '2px 12px 10px', fontSize: 13 }}>
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
            {/* View thread: replies don't quote the conversation in the body
                (it's kept clean between message and signature), so this opens
                the full thread in the Emails section. The composer dock stays
                open with the draft intact, so the user can keep writing there. */}
            {!inline && replyThreadId && onViewThread && (
              <button
                type="button"
                onClick={() => onViewThread(replyThreadId)}
                className="btn-ghost"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
                title="Open the full conversation in the Emails section — your draft stays open"
              >
                <Mail size={14} /> View thread
              </button>
            )}
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
            {countdown != null ? (
              // Undo window: the email is on its way in N seconds unless cancelled.
              // The countdown lives inside the bright-green "Send now" button,
              // which also skips the wait when clicked.
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  onClick={sendNow}
                  style={{
                    whiteSpace: 'nowrap', border: 'none', cursor: 'pointer',
                    background: '#16A34A', color: 'white', fontWeight: 700,
                    fontFamily: 'inherit', fontSize: 13, padding: '7px 14px', borderRadius: 8,
                  }}
                  title="Skip the wait and send right now"
                >
                  Send now ({countdown}s)
                </button>
                <button type="button" onClick={undoSend} className="btn-ghost" autoFocus style={{ whiteSpace: 'nowrap' }}>
                  Undo send
                </button>
              </div>
            ) : (
              <>
                <button type="button" onClick={onClose} className="btn-ghost" style={{ whiteSpace: 'nowrap' }}>Discard</button>
                {/* Split Send button: the main half sends now (after the undo
                    window), the ▾ half opens a popover to schedule for later. */}
                <div style={{ display: 'flex' }}>
                  <button
                    type="submit"
                    className="btn"
                    disabled={!canSend}
                    style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                  >
                    {sending ? 'Sending…' : 'Send'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={openFollowUp}
                    disabled={!canSend}
                    aria-label="Send and create follow-up"
                    title="Send & create follow-up task"
                    style={{ borderRadius: 0, borderLeft: '1px solid rgba(255,255,255,0.35)', padding: '0 8px', display: 'inline-flex', alignItems: 'center' }}
                  >
                    <CheckSquare size={14} />
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
                    disabled={!canSend}
                    aria-label="Schedule send"
                    title="Schedule send"
                    style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: '1px solid rgba(255,255,255,0.35)', padding: '0 8px', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                  >
                    <Clock size={14} /> ▾
                  </button>
                </div>
              </>
            )}
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
      {showFollowUp && (
        <TaskFormModal
          defaults={{
            dealId: deal?.id || null,
            title: 'Follow up' + (subject ? ': ' + subject.replace(/^(re|fwd?):\s*/i, '').trim() : ''),
            // Default the follow-up 3 days out at 08:00 (matches the task default).
            dueAt: (() => { const d = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); d.setHours(8, 0, 0, 0); return d.toISOString(); })(),
          }}
          onClose={() => setShowFollowUp(false)}
          onSubmitValues={onFollowUpValues}
          submitLabel="Create & send"
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
  // `style` is allowed so the toolbar's text/highlight colours survive (DOMPurify
  // still strips dangerous CSS); `font` + `color` covers the <font> tags older
  // browsers emit for foreColor/backColor.
  ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'p', 'br', 'span', 'div', 'font'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'style', 'color'],
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
  // Streak-style link bubble: hovering a link shows a small bar to visit/change/
  // remove it. Anchored to the link via a fixed-position portal so it isn't
  // clipped by the editor's scroll box. `el` is the live <a> node so edits write
  // straight back into the contentEditable.
  const [bubble, setBubble] = useState(null); // { el, href, left, top }
  const hideTimer = useRef(null);

  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = initialHtml || '';
    // Seed once on mount; remounts (new draft) come with a fresh key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = () => { if (editorRef.current) onChange(editorRef.current.innerHTML); };

  const showBubbleFor = (a) => {
    clearTimeout(hideTimer.current);
    const r = a.getBoundingClientRect();
    const href = a.getAttribute('href') || a.href || '';
    setBubble({ el: a, href, left: Math.max(8, Math.min(r.left, window.innerWidth - 320)), top: r.bottom + 6 });
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setBubble(null), 200);
  };

  // In a contentEditable, clicking a link just moves the caret. Mirror Gmail/
  // word processors: Ctrl/Cmd+click opens it in a new tab.
  const onEditorClick = (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener,noreferrer');
    }
  };
  const onEditorOver = (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    a.style.cursor = 'pointer';
    if (!a.title) a.title = `${a.href}\n(Ctrl/Cmd+click to open)`;
    if (!bubble || bubble.el !== a) showBubbleFor(a);
  };
  const onEditorOut = (e) => {
    if (e.target.closest && e.target.closest('a[href]')) scheduleHide();
  };

  const visitLink = () => { if (bubble?.href) window.open(bubble.href, '_blank', 'noopener,noreferrer'); };
  const changeLink = () => {
    if (!bubble?.el) return;
    const next = window.prompt('Link URL (include https://):', bubble.href || 'https://');
    if (next == null) return;
    const url = next.trim();
    if (!url) return;
    bubble.el.setAttribute('href', url);
    emit();
    setBubble((b) => (b ? { ...b, href: url } : b));
  };
  const removeLink = () => {
    if (!bubble?.el) return;
    const a = bubble.el;
    const parent = a.parentNode;
    if (parent) {
      while (a.firstChild) parent.insertBefore(a.firstChild, a);
      parent.removeChild(a);
      emit();
    }
    setBubble(null);
  };

  const bubbleBtn = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', cursor: 'pointer', color: BRAND.muted,
    padding: 4, borderRadius: 4,
  };

  return (
    <>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={() => editorRef.current && onChange(editorRef.current.innerHTML)}
        onClick={onEditorClick}
        onMouseOver={onEditorOver}
        onMouseOut={onEditorOut}
        className="email-body"
        style={{
          // Match the To/Subject inputs: same font stack and normal weight.
          // Without an explicit weight the editor inherits the FormRow <label>'s
          // font-weight:500, which made typed text look bold.
          outline: 'none', padding: '10px 12px 4px',
          fontFamily: '-apple-system, system-ui, sans-serif', fontSize: 14, fontWeight: 400,
          lineHeight: 1.5, minHeight: 72, maxHeight: 280, overflowY: 'auto',
          color: BRAND.ink, background: 'transparent',
        }}
      />
      {bubble && createPortal(
        <div
          onMouseEnter={() => clearTimeout(hideTimer.current)}
          onMouseLeave={scheduleHide}
          style={{
            position: 'fixed', left: bubble.left, top: bubble.top, zIndex: 3000,
            display: 'flex', alignItems: 'center', gap: 4, maxWidth: 320,
            background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8,
            boxShadow: '0 6px 24px rgba(15,42,61,0.18)', padding: '4px 6px', fontSize: 12.5,
          }}
        >
          <a
            href={bubble.href}
            target="_blank"
            rel="noopener noreferrer"
            title={bubble.href}
            style={{ color: BRAND.blue, textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}
          >
            {bubble.href}
          </a>
          <span style={{ width: 1, alignSelf: 'stretch', background: BRAND.border, margin: '0 2px' }} />
          <button type="button" title="Visit link" onMouseDown={(e) => e.preventDefault()} onClick={visitLink} style={bubbleBtn}><ExternalLink size={14} /></button>
          <button type="button" title="Change link" onMouseDown={(e) => e.preventDefault()} onClick={changeLink} style={bubbleBtn}><Edit2 size={14} /></button>
          <button type="button" title="Remove link" onMouseDown={(e) => e.preventDefault()} onClick={removeLink} style={bubbleBtn}><Unlink size={14} /></button>
        </div>,
        document.body,
      )}
    </>
  );
}

// Formatting toolbar driven by document.execCommand (deprecated but universally
// supported and dependency-free), plus the attach-files button. Acts on the
// shared editorRef. Rendered at the bottom of the message box, below the
// signature (Gmail-style).
function RichTextToolbar({ editorRef, onChange, onAttach }) {
  // Which colour palette (if any) is open. Single value so opening one closes
  // the other.
  const [openPalette, setOpenPalette] = useState(null); // 'text' | 'highlight' | null
  const barRef = useRef(null);
  // Dismiss an open palette when clicking anywhere outside the toolbar.
  useEffect(() => {
    if (!openPalette) return undefined;
    const onDocDown = (e) => { if (barRef.current && !barRef.current.contains(e.target)) setOpenPalette(null); };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [openPalette]);
  const emit = () => { if (editorRef.current) onChange(editorRef.current.innerHTML); };
  const exec = (cmd, val = null) => {
    document.execCommand(cmd, false, val);
    if (editorRef.current) editorRef.current.focus();
    emit();
  };
  // Colour commands need styleWithCSS on so Chromium emits inline-style spans
  // (which the sanitizer keeps) rather than legacy <font> tags.
  const execColor = (kind, color) => {
    try { document.execCommand('styleWithCSS', false, true); } catch { /* unsupported */ }
    if (kind === 'text') {
      document.execCommand('foreColor', false, color);
    } else {
      // hiliteColor is the standard; Chromium older builds need backColor.
      const ok = document.execCommand('hiliteColor', false, color);
      if (!ok) document.execCommand('backColor', false, color);
    }
    try { document.execCommand('styleWithCSS', false, false); } catch { /* unsupported */ }
    if (editorRef.current) editorRef.current.focus();
    emit();
    setOpenPalette(null);
  };
  const addLink = () => {
    const url = window.prompt('Link URL (include https://):', 'https://');
    if (url && url !== 'https://') exec('createLink', url);
  };
  // Swatches for the two pickers. Text defaults back to the body ink; highlight
  // "none" clears via transparent.
  const TEXT_COLORS = ['#0F2A3D', '#5B7282', '#E11D48', '#EA580C', '#CA8A04', '#16A34A', '#2563EB', '#7C3AED'];
  const HILITE_COLORS = ['transparent', '#FEF08A', '#FDE68A', '#BBF7D0', '#BAE6FD', '#FBCFE8', '#FED7AA', '#E9D5FF'];
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
  // Trigger + swatch popover for a colour picker. `colors` are CSS values;
  // 'transparent' renders as a "no colour" checker swatch.
  const ColorBtn = ({ kind, title, colors, swatch, label }) => (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        title={title}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpenPalette((p) => (p === kind ? null : kind))}
        style={{ ...toolBtn, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, lineHeight: 1 }}
        onMouseEnter={(e) => { e.currentTarget.style.background = '#EEF3F6'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <span style={{ fontSize: 13 }}>{label}</span>
        <span style={{ width: 14, height: 3, borderRadius: 1, background: swatch }} />
      </button>
      {openPalette === kind && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, zIndex: 20,
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, padding: 6,
            background: '#fff', border: '1px solid ' + BRAND.border, borderRadius: 6,
            boxShadow: '0 4px 16px rgba(15,42,61,0.18)',
          }}
        >
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              title={c === 'transparent' ? 'No highlight' : c}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => execColor(kind, c)}
              style={{
                width: 20, height: 20, borderRadius: 4, cursor: 'pointer',
                border: '1px solid ' + BRAND.border,
                background: c === 'transparent'
                  ? 'repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 50% / 10px 10px'
                  : c,
              }}
            />
          ))}
        </div>
      )}
    </span>
  );
  return (
    <div ref={barRef} style={{
      display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center',
      padding: '4px 6px', borderTop: '1px solid ' + BRAND.border, background: '#FAFBFC',
    }}>
      <Btn cmd="bold" title="Bold"><strong>B</strong></Btn>
      <Btn cmd="italic" title="Italic"><em>I</em></Btn>
      <Btn cmd="underline" title="Underline"><span style={{ textDecoration: 'underline' }}>U</span></Btn>
      <span style={{ width: 1, alignSelf: 'stretch', background: BRAND.border, margin: '2px 4px' }} />
      <ColorBtn kind="text" title="Text colour" colors={TEXT_COLORS} swatch="#E11D48" label="A" />
      <ColorBtn kind="highlight" title="Highlight colour" colors={HILITE_COLORS} swatch="#FEF08A" label="🖍" />
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
export function EmailComposerHost({ onViewThread }) {
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
      onViewThread={onViewThread}
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
  const [editing, setEditing] = useState(null); // the contact being edited

  const remove = async (contactId) => {
    try {
      await actions.removeDealContact(dealId, contactId);
    } catch (e) {
      showMsg(e?.message || 'Could not remove contact');
    }
  };

  // Open the shared contact editor, preferring the full CRM record (phone,
  // title, company, notes) over the slimmed-down chip the deal carries.
  const edit = (c) => setEditing((c && state.contacts?.[c.id]) || c);

  // Promote the edited contact to this deal's primary. The server demotes the
  // old primary to a secondary, so no one is dropped.
  const makePrimary = async (contactId) => {
    try {
      await actions.saveDeal(dealId, { primaryContactId: contactId });
      setEditing(null);
      actions.loadDealDetail(dealId);
    } catch (e) {
      showMsg(e?.message || 'Could not set primary contact');
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
          onEdit={() => edit(primaryContact)}
        />
      )}
      {secondaryContacts.map((c) => (
        <ContactChip
          key={c.id}
          contact={c}
          label="secondary"
          removable
          onRemove={() => remove(c.id)}
          onEdit={() => edit(c)}
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
      {editing && (
        <ContactModal
          contact={editing}
          dealContext={{
            isPrimary: !!primaryContact && editing.id === primaryContact.id,
            onMakePrimary: () => makePrimary(editing.id),
          }}
          onClose={() => { setEditing(null); actions.loadDealDetail(dealId); }}
        />
      )}
    </div>
  );
}

function ContactChip({ contact, label, removable, onRemove, onEdit }) {
  const display = contact.name || contact.email || '(no email)';
  const subtitle = contact.name && contact.email ? contact.email : null;
  const clickable = !!onEdit;
  return (
    <span
      onClick={clickable ? () => onEdit() : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(); } } : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 10px', borderRadius: 999,
        border: '1px solid ' + BRAND.border,
        background: 'white', fontSize: 12, maxWidth: 320,
        cursor: clickable ? 'pointer' : 'default',
      }}
      onMouseEnter={clickable ? (e) => { e.currentTarget.style.background = '#F4F8FB'; e.currentTarget.style.borderColor = BRAND.blue; } : undefined}
      onMouseLeave={clickable ? (e) => { e.currentTarget.style.background = 'white'; e.currentTarget.style.borderColor = BRAND.border; } : undefined}
      title={subtitle ? `${display} · ${subtitle} — click to edit` : `${display} — click to edit`}
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

  // Prefill the create form from whatever was typed: an email goes in the email
  // field, anything else seeds the name. Hidden only when the typed email is an
  // exact match for an existing contact (already offered in the list above).
  const createPrefill = looksLikeEmail ? { email: trimmed } : (trimmed ? { name: trimmed } : {});
  const createLabel = trimmed ? `Create new contact "${trimmed}"` : 'Create a new contact';

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
      {!alreadyExists && (
        <button
          type="button"
          onClick={() => onCreateNew(createPrefill)}
          className="btn"
          style={{ marginTop: 12, width: '100%' }}
        >
          <Plus size={14} /> {createLabel}
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
        {/* autoComplete off + non-standard names: stop Edge/Chrome autofill
            replacing a typed full name with a single profile token on blur. */}
        <label style={{ fontSize: 12, color: BRAND.muted }}>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} required name="squideo-contact-email" autoComplete="off" className="input" style={{ width: '100%', marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12, color: BRAND.muted }}>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" name="squideo-contact-name" autoComplete="off" className="input" style={{ width: '100%', marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12, color: BRAND.muted }}>
          Job title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" name="squideo-contact-title" autoComplete="off" className="input" style={{ width: '100%', marginTop: 4 }} />
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

  // When at least one address has no contact record at all, frame the strip as
  // "not in your contacts" (the CRM has never seen them); otherwise these are
  // known contacts simply not yet linked to this deal.
  const anyUnknown = addresses.some((e) => !contactByEmail.get(e.toLowerCase()));

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
      <span style={{ color: '#9A3412', fontWeight: 600 }}>{anyUnknown ? 'Not in your contacts — add?' : 'New on this thread:'}</span>
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

