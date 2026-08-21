// The furniture that makes a long form feel short: a numbered stepper, a
// time-remaining badge, a reassurance strip and a welcome-back banner.
//
// ── WHERE THIS DESIGN COMES FROM ────────────────────────────────────────────
// src/components/QuoteRequestForm.css, which is the marketing quote form on
// squideo.com. That form converts, the shapes below are lifted from it
// deliberately, and the values here are its values: the green #7ac943 rail, the
// pale-blue time pill, the 28px blue step title. If you restyle one, look at the
// other — they are the same product to anyone who fills in both, first as a
// prospect and then as a client.
//
// The one number that differs is the circle: 42px here against the quote form's
// 50px, because this form has eight steps to its four. The brief page widened to
// 880 for the same reason (BRIEF_MAX in pages/Brief.jsx) and the circles still
// had to come down — eight of them at 50px with connectors and labels crowds
// even that.
//
// ── WHY NOT JUST IMPORT THAT CSS ────────────────────────────────────────────
// Two reasons. The portal is inline-styled from top to bottom, so a class-based
// island in it would be the odd one out and would need its own scope class to
// avoid leaking into the CRM. And that stylesheet belongs to the form that
// brings the work in: reworking its selectors to be shareable puts a live
// conversion path at risk for a cosmetic win. Copied on purpose, with this
// comment as the link between them.

import React, { useEffect, useRef } from 'react';
import { Check, Clock } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useIsMobile } from '../utils.js';

// The quote form's palette for progress. Green rather than the Squideo blue:
// blue is the brand and is already doing the work in titles, buttons and links,
// so a blue rail reads as more chrome. Green reads as "done".
const DONE = '#7ac943';
const DONE_DEEP = '#6bb635';
const IDLE_RING = '#e5e7eb';
const IDLE_FILL = '#f3f4f6';
const IDLE_TEXT = '#9ca3af';

/**
 * The numbered stepper.
 *
 * Circles on desktop, exactly as the quote form draws them. On a phone they are
 * replaced by a single swipeable row of pills, because eight 40px circles with
 * seven connectors need roughly 600px and a phone has 360 — the quote form gets
 * away with circles only because it has four steps. Shrinking them to fit would
 * produce eight grey dots with unreadable labels, which is decoration rather
 * than navigation.
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
          display: 'flex', gap: 6, overflowX: 'auto', margin: '0 -16px 22px',
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
                padding: '6px 12px', borderRadius: 999, cursor: 'pointer',
                fontSize: 12.5, fontFamily: 'inherit', flexShrink: 0,
                scrollSnapAlign: 'start', display: 'inline-flex', alignItems: 'center', gap: 6,
                fontWeight: active ? 700 : 500,
                border: `1px solid ${active ? BRAND.blue : (done ? DONE : '#E0E7ED')}`,
                background: active ? '#EAF7FD' : '#fff',
                color: active ? BRAND.ink : (done ? '#4B7A1F' : '#7E8B96'),
              }}
            >
              <span style={{
                width: 17, height: 17, borderRadius: '50%', flexShrink: 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 800,
                background: done ? DONE : (active ? BRAND.blue : '#EEF3F7'),
                color: done || active ? '#fff' : IDLE_TEXT,
              }}>
                {done ? <Check size={11} strokeWidth={3.5} /> : i + 1}
              </span>
              {s.label}
              {markers[s.key] && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#F59E0B' }} />
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 40 }}>
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <React.Fragment key={s.key}>
            <button
              type="button"
              onClick={() => onJump(i)}
              title={s.title || s.label}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                fontFamily: 'inherit', position: 'relative', zIndex: 2, flexShrink: 0,
              }}
            >
              <span style={{
                width: 42, height: 42, borderRadius: '50%', position: 'relative',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: done || active ? DONE : IDLE_FILL,
                border: `3px solid ${done || active ? DONE : IDLE_RING}`,
                // The active circle is the one thing on the row that should be
                // findable without reading, so it gets size as well as colour.
                transform: active ? 'scale(1.1)' : 'none',
                boxShadow: active ? `0 0 0 4px ${DONE}33` : 'none',
                transition: 'all .4s cubic-bezier(.4,0,.2,1)',
              }}>
                {done
                  ? <Check size={20} strokeWidth={3} color="#fff" />
                  : (
                    <span style={{
                      fontSize: 16, fontWeight: 700,
                      color: active ? '#fff' : IDLE_TEXT,
                    }}>{i + 1}</span>
                  )}
                {/* Someone else is typing in this screen right now. */}
                {markers[s.key] && (
                  <span style={{
                    position: 'absolute', top: -2, right: -2, width: 10, height: 10,
                    borderRadius: '50%', background: '#F59E0B', border: '2px solid #fff',
                  }} />
                )}
              </span>
              <span style={{
                fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                color: done || active ? DONE : IDLE_TEXT,
              }}>{s.label}</span>
            </button>
            {i < steps.length - 1 && (
              <span style={{
                flex: 1, height: 3, background: IDLE_RING, marginBottom: 26,
                marginLeft: 6, marginRight: 6, position: 'relative', overflow: 'hidden',
              }}>
                <span style={{
                  position: 'absolute', inset: 0, width: done ? '100%' : '0%',
                  background: `linear-gradient(90deg, ${DONE} 0%, ${DONE_DEEP} 100%)`,
                  transition: 'width .8s cubic-bezier(.4,0,.2,1)',
                }} />
              </span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** "About 6 minutes left" — the quote form's pale-blue pill. */
export function TimeBadge({ minutes }) {
  if (!minutes) return null;
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 17px',
      background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
      border: '2px solid #bae6fd', borderRadius: 30, marginBottom: 20,
      fontSize: 13.5, fontWeight: 600, color: '#0369a1',
      boxShadow: '0 2px 8px rgba(3,105,161,.1)',
    }}>
      <Clock size={17} color="#0284c7" />
      {/* "About", because unlike the quote form this is not a five-minute job
          and a flat number reads as a promise. */}
      <span>About {minutes === 1 ? '1 minute' : `${minutes} minutes`} left</span>
    </div>
  );
}

/**
 * The green reassurance strip.
 *
 * On the quote form this says "your details are private". Here the anxiety is a
 * different one — twenty-five questions is enough to make anyone wonder what
 * happens if they stop — so it answers that instead. Same shape, same place, the
 * worry that actually belongs to this form.
 */
export function ReassuranceBadge({ children, tone = 'good' }) {
  // It changes colour because it doubles as the save indicator, and a green tick
  // sitting over the words "unsaved changes" is worse than no indicator at all —
  // it teaches people to stop reading it.
  const skin = {
    good: {
      background: 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)',
      rail: DONE, text: '#166534', icon: <Check size={18} strokeWidth={3} color={DONE} />,
    },
    busy: {
      background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
      rail: '#38bdf8', text: '#075985', icon: <Clock size={18} color="#0284c7" />,
    },
    warn: {
      background: 'linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)',
      rail: '#f59e0b', text: '#92400e', icon: <Clock size={18} color="#d97706" />,
    },
  }[tone];

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
      background: skin.background,
      borderLeft: `4px solid ${skin.rail}`, borderRadius: 8, marginBottom: 24,
      fontSize: 13, fontWeight: 500, color: skin.text, lineHeight: 1.5,
      boxShadow: '0 1px 3px rgba(0,0,0,.05)',
    }}>
      <span style={{ flexShrink: 0, display: 'inline-flex' }}>{skin.icon}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * "Welcome back — you're 12 of 25 in."
 *
 * The quote form's version is a fixed bar over the whole page because it is one
 * form on an otherwise empty marketing page. This one sits in the flow: the
 * portal already has a header, a rail and a bell, and a fifth fixed thing on
 * top of those is a page nobody can see past.
 *
 * One action, not two. The quote form offers "start fresh" because its draft is
 * a local one nobody else can see; a brief is a shared server document that
 * colleagues may have contributed to, and a button that reads as "discard it"
 * has no business being one tap from a document that isn't only yours.
 */
export function ResumeBanner({ name, done, total, onResume, onDismiss }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      padding: '14px 18px', marginBottom: 20, borderRadius: 12,
      background: `linear-gradient(135deg, ${DONE} 0%, ${DONE_DEEP} 100%)`,
      boxShadow: '0 4px 16px rgba(107,182,53,.25)', color: '#fff',
    }}>
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div style={{ fontSize: 15.5, fontWeight: 700, marginBottom: 2 }}>
          {name ? `Welcome back, ${name}!` : 'Welcome back!'}
        </div>
        <div style={{ fontSize: 13, opacity: 0.95 }}>
          You've answered {done} of {total}. Pick up where you left off?
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button" onClick={onResume}
          style={{
            background: '#fff', color: '#4B7A1F', border: 'none', borderRadius: 8,
            padding: '9px 16px', fontSize: 13.5, fontWeight: 700,
            fontFamily: 'inherit', cursor: 'pointer',
          }}
        >Continue where I left off</button>
        <button
          type="button" onClick={onDismiss}
          style={{
            background: 'rgba(255,255,255,.18)', color: '#fff',
            border: '1px solid rgba(255,255,255,.45)', borderRadius: 8,
            padding: '9px 16px', fontSize: 13.5, fontWeight: 600,
            fontFamily: 'inherit', cursor: 'pointer',
          }}
        >Start at the top</button>
      </div>
    </div>
  );
}

/** The quote form's big blue step heading and its grey subtitle. */
export function StepTitle({ title, children }) {
  return (
    <>
      <h2 style={{
        margin: '0 0 8px', fontSize: 'clamp(21px, 3.2vw, 28px)', fontWeight: 700,
        color: BRAND.blue, lineHeight: 1.3,
      }}>{title}</h2>
      {/* The paragraph is capped independently of the card. The page got wider
          so the stepper could breathe; body copy following it out to 880px
          would just be harder to read. */}
      {children && (
        <p style={{ margin: '0 0 28px', maxWidth: '68ch', fontSize: 15, lineHeight: 1.6, color: '#6b7280' }}>
          {children}
        </p>
      )}
    </>
  );
}

/**
 * "Good morning" / "Good afternoon" / "Good evening".
 *
 * Same three windows as the quote form's timeBasedGreeting(), which cannot be
 * imported here: it lives in QuoteRequestForm.jsx alongside 1,100 lines of
 * marketing form, and the portal bundle should not carry that to say hello.
 */
export function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning!';
  if (h < 18) return 'Good afternoon!';
  return 'Good evening!';
}
