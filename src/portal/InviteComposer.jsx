// Staff-only (manage mode): write the portal invite email without leaving the
// client's portal.
//
// Deliberately NOT the CRM's full composer — that one is welded to the CRM
// store (drafts, threading, attachments, scheduling, follow-up tasks) and can't
// be mounted here. This is the small subset an invite needs: to, subject, an
// editable body prefilled from the "Client portal invite" template with the
// invite link in it, and your Gmail signature.
//
// It talks to the STAFF CRM API on the same origin — minting the invite,
// reading the template and signature, and sending — all authorised by the staff
// session cookie that manage mode already requires.
import React, { useEffect, useRef, useState } from 'react';
import { BRAND } from '../theme.js';
import { Modal } from '../components/ui.jsx';
import { crmApi } from './api.js';
import { portalInviteTemplate, fillPortalInvite } from '../lib/portalInviteEmail.js';
import { sanitizeEmailHtml, htmlToPlainText, isHtmlEmpty } from '../lib/emailHtml.js';
import { Send } from 'lucide-react';

export default function InviteComposer({ companyId, email, name, senderName, onClose, onSent }) {
  const bodyRef = useRef(null);
  const [subject, setSubject] = useState('');
  const [to, setTo] = useState(email || '');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  // Seeded into the contentEditable once, then owned by the DOM — re-rendering
  // from state on every keystroke would fight the caret.
  const [seed, setSeed] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Mint the invite first: without a link there's no email worth writing.
        const invite = await crmApi('POST', '/api/crm/portal-admin?op=invite', {
          companyId, email, name, compose: true,
        });
        // The template and signature are nice-to-haves — a failure on either
        // shouldn't cost the draft.
        const [templates, sig] = await Promise.all([
          crmApi('GET', '/api/crm/templates').catch(() => []),
          crmApi('GET', '/api/crm/gmail/signature').catch(() => null),
        ]);
        if (cancelled) return;
        const filled = fillPortalInvite(portalInviteTemplate(templates), {
          inviteUrl: invite.inviteUrl,
          email: invite.email || email,
          name,
          companyName: invite.companyName,
          senderName,
        });
        setSubject(filled.subject);
        setTo(invite.email || email);
        setSeed(filled.bodyHtml + (sig?.signatureHtml ? `<br>${sig.signatureHtml}` : ''));
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

  const send = async () => {
    const html = bodyRef.current?.innerHTML || '';
    if (!to.trim() || !subject.trim() || isHtmlEmpty(html)) {
      setError('Add a recipient, a subject and a message.');
      return;
    }
    setSending(true);
    setError(null);
    try {
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
      </p>

      {error && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {loading ? (
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
          <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.ink, marginBottom: 4 }}>Message</div>
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

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn-ghost" onClick={onClose} disabled={sending}>Cancel</button>
        <button
          className="btn"
          onClick={send}
          disabled={loading || sending || !!error && !seed}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          <Send size={15} /> {sending ? 'Sending…' : 'Send invite'}
        </button>
      </div>
    </Modal>
  );
}
