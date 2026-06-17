import React, { useEffect, useMemo, useState } from 'react';
import { Mail } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Card, Empty } from './Card.jsx';
import {
  CommentThread, CommentInput, EventRow, ThreadRow,
  ThreadViewerModal, LinkEmailModal, NewDealFromEmailFlow,
} from './DealDetailView.jsx';

// Reusable Emails + Activity + Comments panel for a deal, lifted out of the deal
// page so the production Video/Project cards can show the same conversation
// without the sales chrome. Self-loads the deal detail; mirrors the deal page's
// derivations + handlers exactly so behaviour stays consistent.
// `sections` controls which cards render (Emails / Activity / Comments), so a
// caller can split them across a layout. Defaults to all three.
export function DealConversation({ dealId, isMobile, sections = ['emails', 'activity', 'comments'] }) {
  const { state, actions } = useStore();

  const [replyingTo, setReplyingTo] = useState(null);
  const [editingCommentId, setEditingCommentId] = useState(null);
  const [openEmailId, setOpenEmailId] = useState(null);
  const [linkEmailTarget, setLinkEmailTarget] = useState(null);
  const [newDealFromEmail, setNewDealFromEmail] = useState(null);

  useEffect(() => { if (dealId) actions.loadDealDetail(dealId); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const detail = state.dealDetail[dealId];
  const deal = detail || state.deals[dealId];
  const contact = deal?.primaryContactId ? state.contacts[deal.primaryContactId] : null;

  const events = detail?.events || [];
  const comments = detail?.comments || [];
  const emails = detail?.emails || [];

  const openComposerForDeal = () => actions.openComposer({
    dealId: deal?.id,
    dealTitle: deal?.title,
    contactEmail: contact?.email || null,
  });

  const linkedEmails = useMemo(() => {
    const set = new Set();
    if (state.session?.email) set.add(state.session.email.toLowerCase());
    if (contact?.email) set.add(contact.email.toLowerCase());
    for (const sc of (detail?.secondaryContacts || [])) {
      if (sc.email) set.add(sc.email.toLowerCase());
    }
    return set;
  }, [state.session?.email, contact?.email, detail?.secondaryContacts]);

  const timeline = useMemo(() =>
    [...events]
      .map(e => ({ kind: 'event', when: e.occurredAt, data: e }))
      .sort((a, b) => new Date(b.when) - new Date(a.when)),
  [events]);

  const threadGroups = useMemo(() => {
    const byThread = new Map();
    for (const em of emails) {
      const tid = em.gmailThreadId || em.gmailMessageId;
      if (!byThread.has(tid)) byThread.set(tid, []);
      byThread.get(tid).push(em);
    }
    const groups = Array.from(byThread.entries()).map(([threadId, msgs]) => {
      const sorted = msgs.slice().sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
      return { threadId, messages: sorted, latestSentAt: sorted[sorted.length - 1]?.sentAt || null };
    });
    groups.sort((a, b) => new Date(b.latestSentAt) - new Date(a.latestSentAt));
    return groups;
  }, [emails]);

  if (!deal) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
      {sections.includes('emails') && (
      <Card title="Emails" count={emails.length} action={
        <button onClick={openComposerForDeal} className="btn-ghost"><Mail size={12} /> Send email</button>
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
      )}

      {sections.includes('activity') && (
      <Card title="Activity" count={timeline.length}>
        {timeline.length === 0 && <Empty text="No activity yet" />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {timeline.map((item) => (
            <EventRow key={'ev_' + item.data.id} event={item.data} users={state.users} />
          ))}
        </div>
      </Card>
      )}

      {sections.includes('comments') && (
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
            if (window.confirm('Delete this comment?')) actions.deleteDealComment(commentId, dealId);
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
      )}

      {openEmailId && (
        <ThreadViewerModal gmailMessageId={openEmailId} dealId={dealId} onClose={() => setOpenEmailId(null)} />
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
