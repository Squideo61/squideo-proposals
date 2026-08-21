// The Squideo mascot, sat on top of a form.
//
// He is decoration with a job: a long form is a long way to walk on your own,
// and something reacting when you answer a question is the cheapest possible
// company. He performs on arrival and once more each time you move on.
//
// Shared by the brief builder in the portal and the quote form on squideo.com.
// Those two are the same product to the person filling in both — this one as a
// prospect, the brief later as a client — so the same character greets them.
//
// ── WHY LOTTIE, AND WHY THE LIGHT BUILD ─────────────────────────────────────
// lottie-web renders the After Effects export as SVG, so it stays sharp at any
// size and inherits nothing from the page. `lottie_light` is the smallest build
// that can draw this file — 70KB gzipped against 112KB for the full player —
// and it is the one that works here anyway: the full build evaluates AE
// expressions at runtime, which needs 'unsafe-eval', and the portal's CSP is
// script-src 'self'. Nothing in this animation uses expressions.
//
// BOTH THE PLAYER AND THE ARTWORK LOAD LAZILY. The player is a dynamic import
// so it lands in its own chunk and only the brief pays for it; the animation is
// fetched from /public rather than bundled, so it is cached by the browser and
// never re-parsed as JavaScript. Nothing on this page waits for either: until
// they arrive the mascot is an empty box, and if they never arrive it stays one.

import React, { useEffect, useRef, useState } from 'react';
import { useIsMobile } from '../utils.js';

const SRC = '/mascot/squideo-desk.json';

// The file is 180 frames at 30fps. The pose at the last frame matches the pose
// at the first, so playing the whole thing is always seamless — starting from
// the middle is not, because the eyebrows and arms sit somewhere else there.
// Hence one full performance per trigger rather than a clipped "reaction".
const FRAMES = [0, 180];

/**
 * @param {number} trigger  change this to make him perform again. Ignored while
 *                          he is already performing, so holding down Next does
 *                          not machine-gun him.
 */
export default function Mascot({ trigger = 0, size = 132 }) {
  const boxRef = useRef(null);
  const animRef = useRef(null);
  const playingRef = useRef(false);
  const [ready, setReady] = useState(false);
  const isMobile = useIsMobile();

  // Someone who has asked for less motion has asked for less of this most of
  // all — it is the only thing on the page that moves for its own sake.
  const still = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (isMobile) return undefined;
    let dead = false;

    (async () => {
      try {
        const [{ default: lottie }, animationData] = await Promise.all([
          import('lottie-web/build/player/lottie_light'),
          fetch(SRC).then((r) => (r.ok ? r.json() : Promise.reject(new Error('no mascot')))),
        ]);
        if (dead || !boxRef.current) return;

        const anim = lottie.loadAnimation({
          container: boxRef.current,
          renderer: 'svg',
          loop: false,
          autoplay: false,
          animationData,
          rendererSettings: { progressiveLoad: true },
        });
        anim.addEventListener('complete', () => { playingRef.current = false; });
        animRef.current = anim;
        setReady(true);

        if (still) anim.goToAndStop(FRAMES[1] - 1, true);
        else { playingRef.current = true; anim.playSegments(FRAMES, true); }
      } catch {
        /* A missing mascot is a missing mascot. The form is the point. */
      }
    })();

    return () => {
      dead = true;
      animRef.current?.destroy();
      animRef.current = null;
    };
  }, [isMobile, still]);

  // Perform again when the form moves on. Skips the first run: the mount
  // effect above has already started him, and two performances at once reads as
  // a glitch rather than as enthusiasm.
  const seen = useRef(trigger);
  useEffect(() => {
    if (seen.current === trigger) return;
    seen.current = trigger;
    const anim = animRef.current;
    if (!anim || still || playingRef.current) return;
    playingRef.current = true;
    anim.playSegments(FRAMES, true);
  }, [trigger, still]);

  // He belongs to the card he sits on, so he is hidden from the accessibility
  // tree entirely — announcing "graphic" between the heading and the first
  // question is noise to anyone who cannot see him perform.
  if (isMobile) return null;
  return (
    <div
      ref={boxRef}
      aria-hidden
      style={{
        width: size, height: size, pointerEvents: 'none',
        // Reserved before he loads so the card does not jump when he arrives.
        opacity: ready ? 1 : 0,
        transition: 'opacity .4s ease',
      }}
    />
  );
}
