// Write the "your video/storyboard is ready to review" email yourself, then
// submit — one action. Mirrors the portal invite composer (InviteComposer.jsx):
// to, subject, an editable body prefilled from a saved template with the review
// link already in it, and "Save as template" to keep your wording.
//
// Why it's tied to the submit rather than being a separate email: submitting is
// the moment the client is meant to hear from us. Sending the covering note
// afterwards, by hand, is the step that gets forgotten — and a bare portal
// notification with no email behind it is how a review sits untouched for a
// week.
//
// The submit runs FIRST and the email second, so a message can never go out
// carrying a link to a draft the client isn't allowed to open yet. That does
// mean the submit stands even if the send fails; the modal says so plainly and
// offers to retry just the email.
import React, { useEffect, useRef, useState } from 'react';
import { Send, FileText, Users } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { Modal } from '../ui.jsx';
import { EmojiPickerButton, insertEmojiIntoEditable } from '../EmojiPicker.jsx';
import { useStore } from '../../store.jsx';
import { crmApi } from '../../lib/crmFetch.js';
import { reviewTemplate, fillReview, unfillReview, REVIEW_TEMPLATE_ID } from '../../lib/reviewEmail.js';
import { sanitizeEmailHtml, htmlToPlainText, isHtmlEmpty } from '../../lib/emailHtml.js';

const SOURCE_LABEL = {
  primary: 'Main contact',
  portal: 'Portal login',
  contact: 'Contact',
  viewer: 'Reviewed last round',
};

// `resendOnly` = the client already has this draft; this is just the covering
// email again (a lost link, a chase). Nothing is re-submitted and they aren't
// re-notified in the portal.
export default function ReviewEmailComposer({ kind, contextUrl, onSubmit, onClose, onDone, resendOnly = false }) {
  const { state } = useStore();
  const bodyRef = useRef(null);
  const [ctx, setCtx] = useState(null);
  const [subject, setSubject] = useState('');
  const [to, setTo] = useState('');
  const [via, setVia] = useState('gmail');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [pendingTemplate, setPendingTemplate] = useState(null);
  const [seed, setSeed] = useState(null);
  const [signature, setSignature] = useState('');
  // True once the gate has run. A retry after a failed send must not submit
  // twice (it would re-notify the client and re-open an approval) — and a
  // resend never submits at all.
  const [submitted, setSubmitted] = useState(resendOnly);
  const varsRef = useRef(null);

  const isSb = kind === 'storyboard';
  const senderName = state.session?.name || null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const context = await crmApi('GET', contextUrl);
        // Template and signature are nice-to-haves; a failure on either
        // shouldn't cost the draft.
        const [templates, sig] = await Promise.all([
          crmApi('GET', '/api/crm/templates').catch(() => []),
          crmApi('GET', '/api/crm/gmail/signature').catch(() => null),
        ]);
        if (cancelled) return;
        const first = context.recipients?.[0] || {};
        const vars = {
          reviewUrl: context.reviewUrl,
          email: first.email || '',
          name: first.name || '',
          companyName: context.companyName,
          title: context.title,
          projectTitle: context.projectTitle,
          version: context.version,
          senderName,
        };
        varsRef.current = vars;
        const filled = fillReview(reviewTemplate(templates, kind), vars);
        setCtx(context);
        setSubject(filled.subject);
        setTo(first.email || '');
        setVia(context.gmail?.connected ? 'gmail' : 'system');
        setSignature(sig?.signatureHtml || '');
        setSeed(filled.bodyHtml);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not prepare the email');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [contextUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (seed != null && bodyRef.current) bodyRef.current.innerHTML = seed;
  }, [seed]);

  const addRecipient = (email) => {
    const current = to.split(',').map((s) => s.trim()).filter(Boolean);
    if (current.some((c) => c.toLowerCase() === email.toLowerCase())) {
      setTo(current.filter((c) => c.toLowerCase() !== email.toLowerCase()).join(', '));
    } else {
      setTo([...current, email].join(', '));
    }
  };

  const reviewTemplateEdits = () => {
    const html = bodyRef.current?.innerHTML || '';
    setPendingTemplate({
      subject: subject.trim(),
      bodyHtml: unfillReview(html, varsRef.current || {}),
    });
    setError(null);
  };

  const saveTemplate = async () => {
    setSending(true);
    try {
      await crmApi('PATCH', `/api/crm/templates/${REVIEW_TEMPLATE_ID[isSb ? 'storyboard' : 'video']}`, {
        subject: pendingTemplate.subject,
        bodyHtml: pendingTemplate.bodyHtml,
      });
      setPendingTemplate(null);
      setNotice('Template updated — the next one of these starts from this.');
    } catch (err) {
      setError(err.message || 'Could not save the template');
    } finally {
      setSending(false);
    }
  };

  // `withEmail` false = submit the draft to the client without a covering email
  // (they still get the portal notification).
  const submit = async (withEmail = true) => {
    const html = bodyRef.current?.innerHTML || '';
    if (withEmail && (!to.trim() || !subject.trim() || isHtmlEmpty(html))) {
      setError('Add a recipient, a subject and a message.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const payload = withEmail ? {
        to: to.split(',').map((s) => s.trim()).filter(Boolean),
        subject: subject.trim(),
        html: sanitizeEmailHtml(html),
        text: htmlToPlainText(html),
        via,
        // Retry after a failed send: the draft is already live, so don't
        // re-notify the client just to get the email out.
        emailOnly: submitted,
      } : null;
      const wasSubmitted = submitted;
      const result = await onSubmit(payload);
      setSubmitted(true);
      if (withEmail && result?.emailSent === false && result?.emailError) {
        // Submitted, but the mail leg failed — say so rather than closing on a
        // half-done action.
        setError(result.emailError + (wasSubmitted ? '' : ' The draft IS now live for the client.'));
        setSending(false);
        return;
      }
      onDone(!withEmail ? 'Submitted to the client'
        : wasSubmitted ? `Email sent to ${to.trim()}`
        : `Submitted — email sent to ${to.trim()}`);
    } catch (err) {
      setError(err.message || 'Could not submit');
      setSending(false);
    }
  };

  const noun = isSb ? 'storyboard' : 'video';
  const recipients = ctx?.recipients || [];
  const chosen = new Set(to.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

  return (
    <Modal onClose={onClose} maxWidth={640}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 800, color: BRAND.ink }}>
        {resendOnly ? `Email the ${noun} review link again` : `Submit the ${noun} to the client`}
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 12.5, color: BRAND.muted }}>
        {ctx?.title ? <><strong style={{ color: BRAND.ink }}>{ctx.title}</strong>{ctx.version != null ? ` · v${ctx.version}` : ''} — </> : null}
        {resendOnly
          ? 'they already have this draft, so nothing changes on their side — this just sends the link again.'
          : 'sending makes this draft visible in their portal and notifies them. The review link is already in the message.'}
      </p>

      {error && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ background: '#EAF7FC', border: '1px solid #A9E1F5', color: '#0B6E93', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>
          {notice}
        </div>
      )}

      {pendingTemplate ? (
        <>
          <div style={{ fontSize: 12.5, color: BRAND.muted, marginBottom: 10, lineHeight: 1.5 }}>
            This is what will be saved. The client's details, the {noun} title and the review link
            have been put back as placeholders, so the next one fills in its own.
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.ink, marginBottom: 4 }}>Subject</div>
          <div style={{ border: `1px solid ${BRAND.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 13.5, marginBottom: 10 }}>
            {pendingTemplate.subject}
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.ink, marginBottom: 4 }}>Message</div>
          <div
            style={{
              border: `1px solid ${BRAND.border}`, borderRadius: 8, padding: 12,
              maxHeight: '40vh', overflowY: 'auto', fontSize: 14, lineHeight: 1.6, color: BRAND.ink,
            }}
            dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(pendingTemplate.bodyHtml) }}
          />
        </>
      ) : loading ? (
        <div style={{ color: BRAND.muted, fontSize: 13, padding: '30px 0', textAlign: 'center' }}>Preparing the email…</div>
      ) : (
        <>
          <label style={{ display: 'block', marginBottom: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.ink, marginBottom: 4 }}>To</div>
            <input className="input" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: '100%' }} />
          </label>
          {recipients.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              <Users size={13} color={BRAND.muted} />
              {recipients.map((r) => {
                const on = chosen.has(r.email.toLowerCase());
                return (
                  <button key={r.email} type="button" onClick={() => addRecipient(r.email)}
                    title={SOURCE_LABEL[r.source] || 'Contact'}
                    style={{
                      fontSize: 11.5, fontWeight: 600, borderRadius: 999, padding: '3px 10px', cursor: 'pointer',
                      border: '1px solid ' + (on ? BRAND.blue : BRAND.border),
                      background: on ? '#EAF7FC' : 'white', color: on ? BRAND.blue : BRAND.muted,
                    }}>
                    {r.name || r.email}
                  </button>
                );
              })}
            </div>
          )}
          <label style={{ display: 'block', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.ink, marginBottom: 4 }}>Subject</div>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} style={{ width: '100%' }} />
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.ink }}>Message</div>
            <div style={{ flex: 1 }} />
            {/* The body is read straight off the element at send, so dropping
                an emoji into the DOM is all this needs. */}
            <EmojiPickerButton
              placement="bottom"
              align="right"
              onPick={(char) => insertEmojiIntoEditable(bodyRef.current, char)}
            />
          </div>
          <div
            ref={bodyRef}
            contentEditable
            suppressContentEditableWarning
            style={{
              border: `1px solid ${BRAND.border}`, borderRadius: 8, padding: 12,
              minHeight: 200, maxHeight: '40vh', overflowY: 'auto',
              fontSize: 14, lineHeight: 1.6, color: BRAND.ink, background: '#fff', outline: 'none',
            }}
          />
          <SenderRow
            gmail={ctx?.gmail} via={via} setVia={setVia} signature={signature}
          />
        </>
      )}

      {pendingTemplate ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn-ghost" onClick={() => setPendingTemplate(null)} disabled={sending}>Back to the email</button>
          <button className="btn" onClick={saveTemplate} disabled={sending}>
            {sending ? 'Saving…' : 'Save template'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn-ghost"
            onClick={reviewTemplateEdits}
            disabled={loading || sending}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}
            title="Save this wording as the template every future review email starts from"
          >
            <FileText size={14} /> Save as template
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose} disabled={sending} style={{ fontSize: 12.5 }}>Cancel</button>
          {!submitted && (
            <button className="btn-ghost" onClick={() => submit(false)} disabled={loading || sending}
              style={{ fontSize: 12.5 }}
              title="Make the draft live for the client and notify them in the portal, without an email">
              Submit without emailing
            </button>
          )}
          <button
            className="btn"
            onClick={() => submit(true)}
            disabled={loading || sending || !ctx?.hasDraft}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <Send size={15} /> {sending ? 'Sending…'
              : resendOnly ? 'Resend email'
              : submitted ? 'Retry email' : 'Submit & send'}
          </button>
        </div>
      )}
    </Modal>
  );
}

// Which mailbox this goes out from. Production staff who've never connected
// Gmail used to have no way to send at all — they get the Squideo address with
// their own email as the reply-to instead, so the client still replies to them.
function SenderRow({ gmail, via, setVia, signature }) {
  const connected = !!gmail?.connected;
  if (!connected) {
    return (
      <div style={{ marginTop: 10, fontSize: 12, color: BRAND.muted, lineHeight: 1.6 }}>
        Your Gmail isn't connected, so this goes from the Squideo address with your own email as the
        reply-to — the client still replies to you. Connect Gmail in Account settings to send it from
        your own mailbox and have it filed on the project.
      </div>
    );
  }
  return (
    <div style={{ marginTop: 10, fontSize: 12, color: BRAND.muted, lineHeight: 1.6 }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <input type="checkbox" checked={via === 'gmail'} onChange={(e) => setVia(e.target.checked ? 'gmail' : 'system')} />
        Send from your Gmail{gmail.address ? ` (${gmail.address})` : ''} and file it on the project
      </label>
      <div style={{ marginTop: 2 }}>
        {via === 'gmail'
          ? (signature ? 'Your Gmail signature is added automatically.' : null)
          : 'Untick means it goes from the Squideo address with your email as the reply-to, and won’t appear in the project’s conversation.'}
      </div>
    </div>
  );
}
