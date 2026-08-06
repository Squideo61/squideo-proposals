// Email composer — the CRM's rich-text email composer plus its recipient input,
// rich-text editor/toolbar, extra-deal picker, signature hint and the HTML /
// scheduling helpers. Extracted verbatim from DealDetailView.jsx (formerly
// ~5,700 lines) so the deal page reads as the deal page rather than "the deal
// page plus an entire email client". No behaviour changes.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckSquare, Clock, Edit2, ExternalLink, FileText, Mail, Plus, Trash2, Unlink, X } from 'lucide-react';
import DOMPurify from 'dompurify';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile, fileSizeLabel } from '../../utils.js';
import { Modal, FormRow } from '../ui.jsx';
import { sanitizeEmailHtml, htmlToPlainText, isHtmlEmpty } from '../../lib/emailHtml.js';
import { NewDealModal } from './PipelineView.jsx';
import { DealSearchPicker } from './DealSearchPicker.jsx';
import { TaskFormModal } from './TaskFormModal.jsx';

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

  // Generate a per-client portal link for this deal and drop it into the body
  // at the cursor. The link signs the recipient up (or logs them in) and takes
  // them to their portal to complete tasks (choose a voiceover, book kick-off).
  const [insertingLink, setInsertingLink] = useState(false);
  const insertPortalLink = async () => {
    if (!deal?.id) return showMsg('Open this from a deal to add a portal link.');
    const email = (to || '').split(',')[0].trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showMsg('Add the client’s email in “To” first.');
    setInsertingLink(true);
    try {
      const { url } = await actions.generatePortalLink(deal.id, email);
      const anchor = `<a href="${url}" style="color:#2BB8E6;font-weight:600;">Open your Squideo portal &rarr;</a>`;
      const el = editorRef.current;
      if (el) {
        el.focus();
        // Insert at the caret if it's inside the editor, else append.
        const sel = window.getSelection();
        const inEditor = sel && sel.rangeCount && el.contains(sel.anchorNode);
        if (inEditor) document.execCommand('insertHTML', false, '&nbsp;' + anchor + '&nbsp;');
        else el.innerHTML = (el.innerHTML || '') + `<p>${anchor}</p>`;
        setBody(el.innerHTML);
      }
      showMsg('Portal link inserted');
    } catch (err) {
      showMsg(err.message || 'Could not generate the portal link');
    } finally {
      setInsertingLink(false);
    }
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
            {/* Insert a per-client portal link for this deal — for intro emails
                that send the client to their portal to complete tasks. */}
            {deal?.id && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={insertPortalLink}
                disabled={insertingLink}
                className="btn-ghost"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                title="Insert a portal link for the client (they can choose a voiceover & book a kick-off call)"
              >
                <ExternalLink size={14} /> {insertingLink ? 'Linking…' : 'Portal link'}
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
          // Who this email is going to — the first that's already a contact
          // becomes the new deal's primary contact.
          suggestContactEmails={String(to || '').split(',').map((s) => s.trim()).filter(Boolean)}
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
  return (
    <Modal onClose={onClose} maxWidth={520} fullScreenOnMobile>
      <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>Add to another deal</h2>
      {/* Search-and-suggest rather than a select of every deal. Creating one is
          the composer's own "Create new deal" button, which opens the full
          form — this picker only finds existing ones. */}
      <DealSearchPicker
        excludeIds={[currentDealId, ...(excludeIds || [])].filter(Boolean)}
        onPick={(d) => onPicked({ id: d.id, title: d.title })}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
      </div>
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

// sanitizeEmailHtml / htmlToPlainText / isHtmlEmpty / EMAIL_HTML_SANITIZE now
// live in src/lib/emailHtml.js — the portal's invite composer sends through the
// same helpers, and two sanitisers would eventually diverge.

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
