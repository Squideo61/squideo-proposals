// Write the portal invite email yourself. Mounted by the CRM (company and
// contact pages) and by the client portal's Team page in manage mode, so an
// invite behaves identically wherever it starts.
//
// Deliberately NOT the CRM's full composer — that one is welded to the CRM
// store (drafts, threading, attachments, scheduling, follow-up tasks) and can't
// mount in the portal bundle. This is the subset an invite needs: to, subject,
// an editable body prefilled from the "Client portal invite" template with the
// invite link in it, and your Gmail signature.
//
// The invite itself is created only when the email actually sends. Opening this
// and thinking better of it leaves nothing behind — and can't re-key the live
// link of someone who already has one.
import React, { useEffect, useRef, useState } from 'react';
import { Send, FileText } from 'lucide-react';
import { BRAND } from '../theme.js';
import { Modal } from './ui.jsx';
import { EmojiPickerButton, insertEmojiIntoEditable } from './EmojiPicker.jsx';
import { crmApi } from '../lib/crmFetch.js';
import {
  portalInviteTemplate, fillPortalInvite, unfillPortalInvite, wrapSignature,
  PORTAL_INVITE_TEMPLATE_ID,
} from '../lib/portalInviteEmail.js';
import { sanitizeEmailHtml, htmlToPlainText, isHtmlEmpty } from '../lib/emailHtml.js';

export default function InviteComposer({ companyId, email, name, senderName, onClose, onSent }) {
  const bodyRef = useRef(null);
  const [subject, setSubject] = useState('');
  const [to, setTo] = useState(email || '');
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // What "Save as template" would store, shown for confirmation before it's
  // written — the placeholders going back in shouldn't be a silent transform.
  const [pendingTemplate, setPendingTemplate] = useState(null);
  // The values that were substituted in, needed to reverse them on save.
  const varsRef = useRef(null);
  // Seeded into the contentEditable once, then owned by the DOM — re-rendering
  // it from state on every keystroke would fight the caret.
  const [seed, setSeed] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Prepare only — this reserves a token and writes nothing.
        const invite = await crmApi('POST', '/api/crm/portal-admin?op=invite', {
          companyId, email, name, compose: true,
        });
        // Template and signature are nice-to-haves; a failure on either
        // shouldn't cost the draft.
        const [templates, sig] = await Promise.all([
          crmApi('GET', '/api/crm/templates').catch(() => []),
          crmApi('GET', '/api/crm/gmail/signature').catch(() => null),
        ]);
        if (cancelled) return;
        const vars = {
          inviteUrl: invite.inviteUrl,
          email: invite.email || email,
          name,
          companyName: invite.companyName,
          senderName,
        };
        varsRef.current = vars;
        const filled = fillPortalInvite(portalInviteTemplate(templates), vars);
        setToken(invite.token);
        setSubject(filled.subject);
        setTo(invite.email || email);
        setSeed(filled.bodyHtml + (sig?.signatureHtml ? `<br>${wrapSignature(sig.signatureHtml)}` : ''));
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not prepare the invite');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [companyId, email]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (seed != null && bodyRef.current) bodyRef.current.innerHTML = seed;
  }, [seed]);

  // Turn the current draft back into a template and show it for confirmation.
  const reviewTemplate = () => {
    const html = bodyRef.current?.innerHTML || '';
    const vars = varsRef.current || {};
    setPendingTemplate({
      subject: subject.trim(),
      bodyHtml: unfillPortalInvite(html, vars),
    });
    setError(null);
  };

  const saveTemplate = async () => {
    setSending(true);
    try {
      await crmApi('PATCH', `/api/crm/templates/${PORTAL_INVITE_TEMPLATE_ID}`, {
        subject: pendingTemplate.subject,
        bodyHtml: pendingTemplate.bodyHtml,
      });
      setPendingTemplate(null);
      setNotice('Template updated — the next invite starts from this.');
    } catch (err) {
      setError(err.message || 'Could not save the template');
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    const html = bodyRef.current?.innerHTML || '';
    if (!to.trim() || !subject.trim() || isHtmlEmpty(html)) {
      setError('Add a recipient, a subject and a message.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      // Make the link real BEFORE sending: if this fails, no email goes out
      // carrying a dead link. The reverse order would be worse.
      await crmApi('POST', '/api/crm/portal-admin?op=invite-commit', {
        companyId, email: (invitedAddress(to) || email), name, token,
      });
      await crmApi('POST', '/api/crm/gmail/send', {
        to: to.split(',').map((s) => s.trim()).filter(Boolean),
        subject: subject.trim(),
        html: sanitizeEmailHtml(html),
        text: htmlToPlainText(html),
      });
      onSent(to.trim());
    } catch (err) {
      setError(err.message || 'Send failed');
      setSending(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={620}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 800, color: BRAND.ink }}>Invite to the portal</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12.5, color: BRAND.muted }}>
        Sends from your Gmail. Their invite link is already in the message — edit the rest as you like.
        Nothing is created until you send.
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
            This is what will be saved. The recipient's details and their one-time link have been
            put back as placeholders, so the next invite fills in its own.
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
        <div style={{ color: BRAND.muted, fontSize: 13, padding: '30px 0', textAlign: 'center' }}>Preparing the invite…</div>
      ) : (
        <>
          <label style={{ display: 'block', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.ink, marginBottom: 4 }}>To</div>
            <input className="input" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: '100%' }} />
          </label>
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
              minHeight: 220, maxHeight: '45vh', overflowY: 'auto',
              fontSize: 14, lineHeight: 1.6, color: BRAND.ink, background: '#fff', outline: 'none',
            }}
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 }}>
          {/* Editing the wording here is usually editing it for good, so the
              way to keep it is right next to the draft. */}
          <button
            type="button"
            className="btn-ghost"
            onClick={reviewTemplate}
            disabled={loading || sending}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}
            title="Save this wording as the template every future invite starts from"
          >
            <FileText size={14} /> Save as template
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose} disabled={sending}>Cancel</button>
          <button
            className="btn"
            onClick={send}
            disabled={loading || sending || !token}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <Send size={15} /> {sending ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      )}
    </Modal>
  );
}

// The invite is bound to ONE address. If the To field was edited to a list, the
// first entry is the one being invited; the rest are just copied in.
function invitedAddress(to) {
  return String(to || '').split(',')[0].trim() || null;
}
