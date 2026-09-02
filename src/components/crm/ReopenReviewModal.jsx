// "Reopen for feedback" — the team's undo for a client's "Finalise and send
// revisions".
//
// Finalising is deliberately one-way for the client: it locks every draft of a
// video (and the signed-off draft and older ones of a storyboard) so the
// production team is working from a settled list of comments. But it's one
// button on a link shared with a whole review committee, and the common failure
// is one reviewer pressing it while their colleagues are still typing. Without
// this, the only ways back were a new draft upload or a hand-written SQL update.
//
// It's a modal rather than a window.confirm because the consequential part is
// the optional email: these reviewers are anonymous share-link viewers, so
// telling them it's open again is usually the whole point — but sending mail to
// a client's committee off a stray click isn't, hence opt-in and off by default.
import React, { useState } from 'react';
import { RotateCcw, Mail } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { Modal } from '../ui.jsx';

// `viewers` is the project's reviewer list where the caller has it (the
// Revisions/Storyboards sections), so the checkbox can name who'd be emailed.
// Pass null where it isn't loaded (the deal's video page) — the send still
// works, we just can't preview the recipients.
export function ReopenReviewModal({
  kind = 'video', itemTitle, viewers = null, onReopen, onClose, showMsg,
}) {
  const label = kind === 'storyboard' ? 'storyboard' : 'video';
  const [notifyViewers, setNotifyViewers] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Our own team shows up in the viewer list whenever a producer opens the
  // client link to check it — they aren't the audience for the reopen notice,
  // and the server filters them out of the send too.
  const knownViewers = Array.isArray(viewers);
  const recipients = knownViewers
    ? viewers.map(v => (v.email || '').trim())
        .filter(e => e && !e.toLowerCase().endsWith('@squideo.co.uk'))
    : [];
  const canEmail = !knownViewers || recipients.length > 0;

  async function go() {
    setBusy(true);
    try {
      const res = await onReopen({ notifyViewers, note: note.trim() || null });
      showMsg?.(res?.notified
        ? `Reopened — ${res.notified} reviewer${res.notified === 1 ? '' : 's'} emailed`
        : 'Reopened for feedback');
      onClose();
    } catch (err) {
      showMsg?.(err.message || 'Could not reopen');
      setBusy(false);
    }
  }

  return (
    <Modal onClose={busy ? undefined : onClose} maxWidth={520}>
      <h3 style={{ margin: '0 0 6px', fontSize: 17, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 8 }}>
        <RotateCcw size={17} color={BRAND.blue} /> Reopen for feedback
      </h3>
      <p style={{ margin: '0 0 14px', fontSize: 13.5, color: BRAND.muted, lineHeight: 1.5 }}>
        Unlocks <strong style={{ color: BRAND.ink }}>{itemTitle || `this ${label}`}</strong> so the client can carry
        on commenting on the same draft. Every comment they've already left stays exactly where it is — this only
        clears the finalisation, so their team can add the rest and finalise again when they're done.
      </p>

      <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: BRAND.ink, marginBottom: 5 }}>
        Note to the client <span style={{ fontWeight: 400, color: BRAND.muted }}>(optional)</span>
      </label>
      <textarea
        value={note}
        onChange={e => setNote(e.target.value)}
        maxLength={500}
        rows={2}
        placeholder="e.g. Reopened so the rest of your team can add their comments."
        style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
          border: '1px solid ' + BRAND.border, fontSize: 13.5, fontFamily: 'inherit', resize: 'vertical',
          marginBottom: 14 }}
      />

      <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '10px 12px',
        border: '1px solid ' + BRAND.border, borderRadius: 8, cursor: canEmail ? 'pointer' : 'default',
        opacity: canEmail ? 1 : 0.6, marginBottom: 16 }}>
        <input type="checkbox" checked={notifyViewers} disabled={!canEmail}
          onChange={e => setNotifyViewers(e.target.checked)} style={{ marginTop: 2 }} />
        <span style={{ fontSize: 13, color: BRAND.ink, lineHeight: 1.45 }}>
          <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Mail size={13} color={BRAND.muted} /> Email the reviewers that it's open again
          </span>
          <span style={{ display: 'block', color: BRAND.muted, marginTop: 3 }}>
            {!knownViewers
              ? 'Goes to everyone who has opened the review link for this project.'
              : recipients.length
                ? `Goes to the ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'} who have opened the review link: ${recipients.join(', ')}`
                : 'Nobody has opened the review link yet, so there’s no one to email.'}
          </span>
        </span>
      </label>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn" onClick={go} disabled={busy}>
          {busy ? 'Reopening…' : 'Reopen for feedback'}
        </button>
      </div>
    </Modal>
  );
}

// The chip-sized trigger that sits next to an "Approved" pill. Keeps the
// open/close state so callers only supply the reopen call itself.
export function ReopenReviewButton({ kind, itemTitle, viewers = null, onReopen, showMsg, style }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="btn-ghost"
        title="Undo the client's finalisation so they can add more comments"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, ...style }}>
        <RotateCcw size={13} /> Reopen for feedback
      </button>
      {open && (
        <ReopenReviewModal
          kind={kind} itemTitle={itemTitle} viewers={viewers}
          onReopen={onReopen} showMsg={showMsg} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
