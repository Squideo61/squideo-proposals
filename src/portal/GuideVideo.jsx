// The guide videos, playable anywhere in the portal.
//
// WHY THIS FILE EXISTS: the brief builder points at a guide video from six of
// its questions ("Video 2 — the one-message rule"), and clicking one used to
// navigate to #/course. That is the worst possible moment to take someone off
// the page: they are mid-answer, the question they were thinking about is gone,
// and coming back means finding their place again. A half-answered brief is the
// thing this whole page exists to prevent losing.
//
// So the same player opens in a modal over the brief instead. The brief keeps
// its state — it is never unmounted — and closing the modal puts them back on
// the exact question that prompted the click.
//
// The player itself is shared with the course page rather than copied, because
// progress tracking is the part that would silently rot in a copy: someone
// watching video 2 from inside the brief has to count as having watched it, or
// the nudge emails keep telling them to.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, RotateCcw, PlayCircle } from 'lucide-react';
import { BRAND } from '../theme.js';
import { Modal } from '../components/ui.jsx';
import { portalApi, mediaUrl } from './api.js';
import { isDemoMode } from './demo/portalDemo.js';
import { LEAD_MAGNET } from '../lib/leadMagnet.js';
import { usePortal } from './PortalContext.jsx';

const HEARTBEAT_MS = 15000;

export const fmtDuration = (s) => {
  if (!s && s !== 0) return null;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
};

/**
 * Which video this is, how long it runs, and whether it has been watched.
 * Shared by the real player and the demo placeholder — the metadata is real in
 * both, and duplicating it is how the two quietly stop matching.
 */
function GuideMeta({ module: m, onRestart = null }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', color: BRAND.blue }}>
          Video {m.moduleNumber}
        </span>
        <span style={{ fontSize: 16.5, fontWeight: 700, color: BRAND.ink }}>{m.title}</span>
        {m.durationSeconds && <span style={{ fontSize: 12.5, color: BRAND.muted }}>{fmtDuration(m.durationSeconds)}</span>}
        {m.completed && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: '#15803D' }}>
            <Check size={12} /> Watched
          </span>
        )}
        {onRestart && (
          <button className="btn-ghost" onClick={onRestart} style={{ fontSize: 12, marginLeft: 'auto' }}>
            <RotateCcw size={13} /> Start again
          </button>
        )}
      </div>

      {(m.subtitle || m.description) && (
        <p style={{ margin: '8px 0 0', fontSize: 13.5, lineHeight: 1.6, color: BRAND.muted }}>
          {m.description || m.subtitle}
        </p>
      )}
      {onRestart && (
        <div style={{ marginTop: 8, fontSize: 12, color: BRAND.muted }}>
          Picking up from {fmtDuration(m.resumeSeconds)}.
        </div>
      )}
    </>
  );
}

/**
 * One guide video: the player, its heading, and the progress heartbeat.
 *
 * Deliberately renders no card or panel of its own — the course page puts it in
 * a Card and the modal puts it in a dialog, and a component that brings its own
 * container can only be used in one of those.
 */
export function GuidePlayer({ module: m, onProgress, showToast, autoPlay = false }) {
  const videoRef = useRef(null);
  const [resumed, setResumed] = useState(false);
  // Only offer "start again" when they're far enough in that resuming would be
  // a surprise — jumping someone 4 seconds into a 45-second video isn't worth
  // an interface element.
  const canResume = m.resumeSeconds > 5 && !m.completed;

  const send = useCallback((extra = {}) => {
    const v = videoRef.current;
    if (!v) return;
    portalApi.post('course-progress', {
      slug: m.slug,
      positionSeconds: Math.floor(v.currentTime || 0),
      durationSeconds: Math.floor(v.duration || m.durationSeconds || 0),
      ...extra,
    }).then(() => { if (extra.ended) onProgress?.(); }).catch(() => {});
  }, [m.slug, m.durationSeconds, onProgress]);

  // Heartbeat while playing, and one last send when the tab is hidden — a
  // closed laptop lid is the most common way a session ends, and beforeunload
  // is unreliable on mobile Safari.
  useEffect(() => {
    const timer = setInterval(() => {
      const v = videoRef.current;
      if (v && !v.paused && !v.ended) send();
    }, HEARTBEAT_MS);
    const onHide = () => { if (document.visibilityState === 'hidden') send(); };
    document.addEventListener('visibilitychange', onHide);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onHide); };
  }, [send]);

  // The modal opens on a click, so autoplay is a user gesture and browsers allow
  // it with sound. It still catches: an autoplay rejection must not surface as
  // an error on a free marketing video — the controls are right there.
  const onLoaded = () => {
    const v = videoRef.current;
    if (!v) return;
    if (canResume && !resumed) { v.currentTime = m.resumeSeconds; setResumed(true); }
    if (autoPlay) v.play?.().catch(() => {});
  };

  const restart = () => {
    const v = videoRef.current;
    if (v) { v.currentTime = 0; v.play?.().catch(() => {}); }
    setResumed(true);
  };

  // Demo mode intercepts the API, not mediaUrl — so a <video src> here would be
  // a real request for a real file on behalf of a client who does not exist, and
  // would fail. Everything around the player is real; the player says so.
  if (isDemoMode()) {
    return (
      <>
        <div style={{
          borderRadius: 10, aspectRatio: '16 / 9', background: '#0B1E2B',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 12, textAlign: 'center', padding: 20,
        }}>
          <PlayCircle size={38} strokeWidth={1.5} color="#5B7A8C" />
          <div style={{ fontSize: 13.5, color: '#9FB4C2', maxWidth: 330, lineHeight: 1.55 }}>
            The videos don&rsquo;t play in the demo. Everything around this — which
            question offered it, the numbering, that it opens over the brief
            instead of navigating away — is exactly what a client gets.
          </div>
        </div>
        <GuideMeta module={m} />
      </>
    );
  }

  return (
    <>
      <div style={{ borderRadius: 10, overflow: 'hidden', background: '#000', aspectRatio: '16 / 9' }}>
        <video
          ref={videoRef}
          controls
          playsInline
          preload="metadata"
          controlsList="nodownload"
          poster={m.posterUrl || undefined}
          src={mediaUrl(`download?scope=course&id=${encodeURIComponent(m.id)}`)}
          onLoadedMetadata={onLoaded}
          onPause={() => send()}
          onEnded={() => { send({ ended: true }); showToast?.('Nice one — that one\'s ticked off.'); }}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
      </div>

      <GuideMeta module={m} onRestart={canResume ? restart : null} />
    </>
  );
}

/**
 * A guide video over whatever page asked for it.
 *
 * Takes a module NUMBER, not a slug, because that is what the brief questions
 * carry (`videoRef: 2`) and what the copy beside them says out loud ("Video 2").
 * Slugs are an implementation detail of the course tables and would have to be
 * kept in step with the question set by hand.
 *
 * Loads on open rather than with the page: six questions can each offer a video
 * and almost nobody clicks one, so fetching the course list up front would be a
 * request per brief for the benefit of the few who do.
 */
export function GuideVideoModal({ moduleNumber, onClose }) {
  const { showToast } = usePortal();
  const [module, setModule] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    portalApi.get('course')
      .then((data) => {
        if (!live) return;
        const found = (data.modules || []).find((m) => m.moduleNumber === moduleNumber);
        if (found) setModule(found);
        else setError(`We couldn't find that video — it may have been renumbered. All of them are under "${LEAD_MAGNET.navLabel}" in the menu.`);
      })
      .catch((err) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [moduleNumber]);

  return (
    // Wide enough that a 16:9 video is worth watching rather than politely
    // acknowledged. fullScreenOnMobile is the Modal default and right here: a
    // video in a cramped phone card is the one thing worse than navigating away.
    <Modal onClose={onClose} maxWidth={760}>
      {error && (
        <div style={{ padding: '30px 4px', fontSize: 14, lineHeight: 1.6, color: BRAND.muted }}>
          {error}
        </div>
      )}
      {!error && !module && (
        <div style={{
          aspectRatio: '16 / 9', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#0B1E2B', borderRadius: 10, color: '#7E97A8', fontSize: 13.5,
        }}>
          Loading video {moduleNumber}…
        </div>
      )}
      {module && (
        <GuidePlayer module={module} showToast={showToast} autoPlay />
      )}
    </Modal>
  );
}
