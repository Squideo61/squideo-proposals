import React, { useEffect, useRef, useState } from 'react';
import { Eye, CheckCircle2, X } from 'lucide-react';
import { BRAND } from '../../theme.js';

// Live "another client is already reviewing this draft" banner, used by both
// the Video and Storyboard public revision viewers.
//
// State machine:
//   • If I am the *only* active viewer or I was here first → no banner.
//   • If someone else joined the page before me → yellow warning naming them
//     (auto-dismisses ~20s later so it doesn't linger).
//   • If they leave while my warning is still up → goes green for ~5s
//     ("…has finished") then disappears.
//   • The X dismisses the banner immediately and it stays hidden for the rest
//     of the session.
//
// `activeViewers` shape: [{ name, you, sessionStartedAt, ... }] from the
// publicView/poll response.
export function ConflictBanner({ activeViewers }) {
  const [phase, setPhase] = useState(null); // null | 'warning' | 'cleared'
  const [otherName, setOtherName] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const warningTimer = useRef(null);
  const clearedTimer = useRef(null);

  // Recompute the "earlier other viewer" each render. Compare on
  // sessionStartedAt (server-set) so a long-lived idle session doesn't
  // out-rank a fresh one.
  const me = activeViewers?.find(v => v.you) || null;
  const earlierOther = (() => {
    if (!me?.sessionStartedAt || !activeViewers) return null;
    const myStart = new Date(me.sessionStartedAt).getTime();
    const others = activeViewers.filter(v => !v.you && v.sessionStartedAt);
    let earliest = null;
    for (const o of others) {
      const oStart = new Date(o.sessionStartedAt).getTime();
      if (oStart < myStart && (!earliest || oStart < new Date(earliest.sessionStartedAt).getTime())) {
        earliest = o;
      }
    }
    return earliest;
  })();

  useEffect(() => {
    if (dismissed) return;

    // Earlier viewer appears for the first time → show the yellow warning,
    // and schedule a soft auto-dismiss so it doesn't linger.
    if (earlierOther && phase === null) {
      setOtherName(earlierOther.name);
      setPhase('warning');
      clearTimeout(warningTimer.current);
      warningTimer.current = setTimeout(() => {
        setPhase(p => (p === 'warning' ? null : p));
      }, 20000);
      return;
    }

    // Earlier viewer leaves while we're still showing the warning → flip
    // to "they've finished" green for a short beat, then disappear.
    if (!earlierOther && phase === 'warning') {
      clearTimeout(warningTimer.current);
      setPhase('cleared');
      clearTimeout(clearedTimer.current);
      clearedTimer.current = setTimeout(() => setPhase(null), 5000);
    }
  }, [earlierOther?.sessionStartedAt, earlierOther?.name, phase, dismissed]);

  useEffect(() => () => {
    clearTimeout(warningTimer.current);
    clearTimeout(clearedTimer.current);
  }, []);

  if (dismissed || !phase) return null;

  const isWarning = phase === 'warning';
  const styles = isWarning
    ? { bg: '#FEF3C7', border: '#FCD34D', fg: '#92400E', accent: '#B45309' }
    : { bg: '#ECFDF5', border: '#A7F3D0', fg: '#065F46', accent: '#047857' };
  const Icon = isWarning ? Eye : CheckCircle2;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 16px', background: styles.bg,
      borderBottom: '1px solid ' + styles.border,
      color: styles.fg, fontSize: 13,
    }}>
      <Icon size={16} color={styles.accent} />
      <div style={{ flex: 1, lineHeight: 1.4 }}>
        {isWarning ? (
          <>
            <strong>{otherName}</strong> is currently reviewing this draft. We recommend
            waiting for <strong>{otherName}</strong>’s comments before adding your own to
            avoid repeated similar comments.
          </>
        ) : (
          <>
            <strong>{otherName}</strong> has finished — you have the floor.
          </>
        )}
      </div>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        title="Dismiss"
        style={{ background: 'transparent', border: 'none', cursor: 'pointer',
          color: styles.fg, padding: 2, display: 'inline-flex' }}
      >
        <X size={15} />
      </button>
    </div>
  );
}
