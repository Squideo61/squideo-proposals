// The furniture that makes a long form feel short: a stepper, a time estimate,
// a reassurance line and a welcome-back card.
//
// ── THE LOOK ────────────────────────────────────────────────────────────────
// Restrained. Hairlines rather than borders, one accent colour used sparingly,
// near-black headings with tight tracking, generous space, and motion that is
// short and never bounces. The rule of thumb: if an element is competing for
// attention with the question being asked, it is wrong.
//
// This is the second pass. The first copied the marketing quote form's chrome
// wholesale — saturated green circles, gradient pills, a bright banner — which
// is right on a landing page that has to grab someone in two seconds, and wrong
// on a document they will sit with for ten minutes across three sittings.
// Twenty-five questions is already intimidating; chrome shouting alongside it
// makes it worse.
//
// The quote form has since been brought over to match — same accent, same
// hairlines, same near-black headings, same mascot. They are the same product
// to the person who fills in both, this one as a prospect and the brief later
// as a client, so restyle one and look at the other:
// src/components/QuoteRequestForm.css.
//
// One accent, and it is the brand blue. The green said "done" loudly, but two
// signal colours on one screen is one more than the content can carry.

import React, { useEffect, useRef } from 'react';
import { Check, Clock } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useIsMobile } from '../utils.js';

const ACCENT = BRAND.blue;
const INK = BRAND.ink;
const MUTED = '#6E7B87';
// A hairline, not a border: at 10% the line separates without drawing a box
// around everything. Borrowed straight from how Apple's own tables read.
const HAIRLINE = 'rgba(15, 42, 61, 0.11)';
const SURFACE = '#F7F9FB';

// Short, ease-out, no overshoot. Motion here is meant to explain that something
// moved, not to perform.
export const EASE = 'cubic-bezier(.22,.61,.36,1)';

/**
 * The stepper.
 *
 * Circles on desktop; on a phone a single swipeable row of pills, because eight
 * circles with connectors and labels need roughly 600px and a phone has 360.
 * Shrinking them to fit gives eight grey dots nobody can read, which is
 * decoration rather than navigation.
 *
 * Every step is clickable. This is a document people fill in over days, not a
 * checkout: jumping to "Style" because that is the bit you finally have an
 * answer for is the normal way to use it.
 */
export function StepProgress({ steps, current, onJump, markers = {} }) {
  const isMobile = useIsMobile();
  const rowRef = useRef(null);

  // Moving on with Next would otherwise leave the active pill off-screen — so
  // the one cue telling you how far through you are disappears at the exact
  // moment you use it.
  useEffect(() => {
    if (!isMobile || !rowRef.current) return;
    rowRef.current.children[current]?.scrollIntoView({
      behavior: 'smooth', inline: 'center', block: 'nearest',
    });
  }, [current, isMobile]);

  if (isMobile) {
    return (
      <div
        ref={rowRef}
        className="hide-scrollbar"
        style={{
          display: 'flex', gap: 7, overflowX: 'auto', margin: '0 -16px',
          padding: '0 16px', scrollSnapType: 'x proximity',
        }}
      >
        {steps.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <button
              key={s.key} type="button" onClick={() => onJump(i)}
              style={{
                padding: '7px 13px', borderRadius: 999, cursor: 'pointer',
                fontSize: 12.5, fontFamily: 'inherit', flexShrink: 0,
                letterSpacing: '-0.01em', scrollSnapAlign: 'start',
                display: 'inline-flex', alignItems: 'center', gap: 7,
                fontWeight: active ? 600 : 500,
                border: `1px solid ${active ? 'transparent' : HAIRLINE}`,
                background: active ? ACCENT : '#fff',
                color: active ? '#fff' : (done ? INK : MUTED),
                transition: `background .25s ${EASE}, color .25s ${EASE}`,
              }}
            >
              <span style={{
                width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9.5, fontWeight: 700,
                background: active ? 'rgba(255,255,255,.24)' : (done ? ACCENT : '#EDF1F5'),
                color: active || done ? '#fff' : MUTED,
              }}>
                {done ? <Check size={10} strokeWidth={3.5} /> : i + 1}
              </span>
              {s.label}
              {markers[s.key] && (
                <span style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: active ? 'rgba(255,255,255,.8)' : '#E9A23B',
                }} />
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        const filled = done || active;
        return (
          <React.Fragment key={s.key}>
            <button
              type="button"
              onClick={() => onJump(i)}
              title={s.title || s.label}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9,
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                fontFamily: 'inherit', position: 'relative', zIndex: 2, flexShrink: 0,
              }}
            >
              <span style={{
                width: 32, height: 32, borderRadius: '50%', position: 'relative',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: filled ? ACCENT : '#fff',
                border: `1.5px solid ${filled ? ACCENT : HAIRLINE}`,
                // A soft halo rather than a scale-up. Growing the active circle
                // nudges its neighbours a pixel each time you move, which reads
                // as the row twitching.
                boxShadow: active ? `0 0 0 5px ${ACCENT}22` : 'none',
                transition: `background .3s ${EASE}, border-color .3s ${EASE}, box-shadow .3s ${EASE}`,
              }}>
                {done
                  ? <Check size={15} strokeWidth={3} color="#fff" />
                  : (
                    <span style={{
                      fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em',
                      color: active ? '#fff' : MUTED,
                    }}>{i + 1}</span>
                  )}
                {/* Someone else is typing in this screen right now. */}
                {markers[s.key] && (
                  <span style={{
                    position: 'absolute', top: -1, right: -1, width: 9, height: 9,
                    borderRadius: '50%', background: '#E9A23B', border: '2px solid #fff',
                  }} />
                )}
              </span>
              <span style={{
                fontSize: 11.5, fontWeight: active ? 600 : 500, whiteSpace: 'nowrap',
                letterSpacing: '-0.01em',
                color: filled ? INK : MUTED,
                transition: `color .3s ${EASE}`,
              }}>{s.label}</span>
            </button>
            {i < steps.length - 1 && (
              <span style={{
                flex: 1, height: 2, borderRadius: 2, background: HAIRLINE,
                marginBottom: 22, marginLeft: 8, marginRight: 8,
                position: 'relative', overflow: 'hidden',
              }}>
                <span style={{
                  position: 'absolute', inset: 0, width: done ? '100%' : '0%',
                  background: ACCENT, borderRadius: 2,
                  transition: `width .55s ${EASE}`,
                }} />
              </span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/**
 * Where you are WITHIN a screen: one segment per part, filling as they are
 * answered.
 *
 * Wordless on purpose. "Step 2 of 8" plus "Question 3 of 4" is two counters to
 * hold in your head, and the answered rows in the body already show progress in
 * a form you can read. This is peripheral vision only — how much of this screen
 * is left, at a glance, with no arithmetic.
 *
 * Clickable, because it sits directly under a stepper that is, and one row of
 * marks navigating while the row below it is decorative is the kind of
 * inconsistency people quietly stop trusting.
 */
export function PartProgress({ parts, current, answered = [], onJump }) {
  return (
    <div style={{ display: 'flex', gap: 5, marginTop: 18 }}>
      {parts.map((pt, i) => {
        const isNow = i === current;
        const done = answered[i];
        return (
          <button
            key={pt.key}
            type="button"
            onClick={() => onJump(i)}
            aria-label={pt.questions[0]?.label || `Question ${i + 1}`}
            title={pt.questions[0]?.label}
            style={{
              flex: 1, height: 4, padding: 0, borderRadius: 2, border: 'none',
              cursor: 'pointer',
              background: isNow ? ACCENT : (done ? `${ACCENT}66` : HAIRLINE),
              transition: `background .3s ${EASE}`,
            }}
          />
        );
      })}
    </div>
  );
}

/** "About 6 minutes left", said quietly. */
export function TimeBadge({ minutes }) {
  if (!minutes) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px 5px 10px',
      background: SURFACE, border: `1px solid ${HAIRLINE}`, borderRadius: 999,
      fontSize: 12.5, fontWeight: 500, color: MUTED, letterSpacing: '-0.01em',
    }}>
      <Clock size={13} strokeWidth={2} />
      {/* "About", because unlike a two-minute quote form this is a real sit-down
          and a flat number reads as a promise. */}
      About {minutes === 1 ? '1 minute' : `${minutes} minutes`} left
    </span>
  );
}

/**
 * The one-line reassurance under the heading, which doubles as the save state.
 *
 * The worry this form raises is not "who sees my phone number" — it is "what
 * happens if I stop". So it answers that, and it earns the answer by showing
 * the actual save: "Saved at 14:32", not "we save your work".
 */
export function ReassuranceBadge({ children, tone = 'good' }) {
  // It changes colour because it is a status, and a green tick sitting over the
  // words "unsaved changes" teaches people to stop reading it. The tints are
  // deliberately close to white — this is a footnote, not an alert.
  const skin = {
    good: { bg: '#F3FAF6', border: '#DCEDE3', fg: '#356B4C', icon: <Check size={14} strokeWidth={2.6} /> },
    busy: { bg: '#F4F8FB', border: '#DEE9F1', fg: '#4A6B80', icon: <Clock size={14} strokeWidth={2.2} /> },
    warn: { bg: '#FDF8F0', border: '#F0E3CA', fg: '#8A6320', icon: <Clock size={14} strokeWidth={2.2} /> },
  }[tone];

  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 14px 7px 11px',
      background: skin.bg, border: `1px solid ${skin.border}`, borderRadius: 999,
      fontSize: 12.5, fontWeight: 500, color: skin.fg, lineHeight: 1.45,
      letterSpacing: '-0.01em',
    }}>
      <span style={{ flexShrink: 0, display: 'inline-flex' }}>{skin.icon}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * "Welcome back — you're 12 of 25 in."
 *
 * A quiet card, not a coloured banner. Someone returning to a half-finished
 * brief does not need to be congratulated; they need one sentence and one
 * button, and then to be left alone with the form.
 *
 * One real action. A "start fresh" alongside it would read as "discard", and a
 * brief is a shared document colleagues may have contributed to — that button
 * has no business being one tap away.
 */
export function ResumeBanner({ name, done, total, onResume, onDismiss, reserveRight = 0 }) {
  return (
    // `reserveRight` keeps the buttons out from under whatever overlaps this
    // banner's right end — the mascot, who is perched on the card below and
    // pokes up into it. The banner keeps its full width so it still lines up
    // with that card; only its contents stop short, which leaves him sitting on
    // an empty corner of it rather than on top of the Continue button.
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      padding: '15px 18px', paddingRight: 18 + reserveRight,
      marginBottom: 22, borderRadius: 14,
      background: '#fff', border: `1px solid ${HAIRLINE}`,
      boxShadow: '0 1px 2px rgba(15,42,61,.04), 0 10px 26px rgba(15,42,61,.05)',
    }}>
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div style={{
          fontSize: 15, fontWeight: 600, color: INK, letterSpacing: '-0.015em', marginBottom: 2,
        }}>
          {name ? `Welcome back, ${name}` : 'Welcome back'}
        </div>
        <div style={{ fontSize: 13.5, color: MUTED, letterSpacing: '-0.01em' }}>
          You've answered {done} of {total}. Pick up where you left off?
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button" onClick={onDismiss}
          style={{
            background: 'none', color: MUTED, border: 'none', borderRadius: 10,
            padding: '9px 12px', fontSize: 13.5, fontWeight: 500,
            fontFamily: 'inherit', cursor: 'pointer', letterSpacing: '-0.01em',
          }}
        >Start at the top</button>
        <button
          type="button" onClick={onResume}
          style={{
            background: ACCENT, color: '#fff', border: 'none', borderRadius: 10,
            padding: '9px 16px', fontSize: 13.5, fontWeight: 600,
            fontFamily: 'inherit', cursor: 'pointer', letterSpacing: '-0.01em',
          }}
        >Continue</button>
      </div>
    </div>
  );
}

/**
 * The heading block: where you are, what this screen is, and why.
 *
 * Centred, and the title is near-black rather than the accent. A coloured
 * heading on every screen makes the accent meaningless by the third one, and
 * the thing that should be loudest on this page is the question.
 *
 * "Step 3 of 8" is not decoration. Being told the count is the single cheapest
 * way to make a long form feel finite, and finite is the whole battle here.
 */
export function StepTitle({ step, total, title, children, meta = null }) {
  // `children && …` is not enough: a caller passing {cond && text}{other && more}
  // hands us an ARRAY of falses, which is truthy, and we render an empty
  // paragraph with 28px of margin under it. That is exactly what the brief does
  // once the screen blurb stops showing after the first part.
  const body = React.Children.toArray(children).filter((c) => c !== false && c != null && c !== '');
  const hasBody = body.length > 0;
  return (
    <div style={{ textAlign: 'center', maxWidth: 640, margin: '0 auto 30px' }}>
      {step != null && total != null && (
        <div style={{
          fontSize: 12, fontWeight: 600, color: MUTED,
          letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10,
        }}>
          Step {step} of {total}
        </div>
      )}
      <h2 style={{
        margin: '0 0 10px', fontSize: 'clamp(23px, 3vw, 31px)', fontWeight: 600,
        color: INK, lineHeight: 1.18, letterSpacing: '-0.025em',
      }}>{title}</h2>
      {hasBody && (
        <p style={{
          margin: '0 auto', maxWidth: '58ch', fontSize: 15, lineHeight: 1.6,
          color: MUTED, letterSpacing: '-0.005em',
        }}>
          {body}
        </p>
      )}
      {meta && <div style={{ marginTop: 16 }}>{meta}</div>}
    </div>
  );
}

/**
 * "Good morning" / "Good afternoon" / "Good evening".
 *
 * Same three windows as timeBasedGreeting() in QuoteRequestForm.jsx, which
 * cannot be imported here: it sits alongside 1,100 lines of marketing form, and
 * the portal bundle should not carry that to say hello.
 */
export function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
