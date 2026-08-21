// The signup step for the brief builder, sized to be iframed into a marketing
// page — the same shape as /quote and /contact, which the marketing site already
// embeds.
//
// WHY ONLY THE SIGNUP IS EMBEDDED, not the builder itself: the brief builder
// needs a portal session, and the portal cookie is SameSite=Lax. A Lax cookie is
// never sent on a cross-site iframe's requests — that's the cookie spec, not a
// browser policy — so the builder inside an iframe would be permanently signed
// out. This form is stateless, so it embeds fine, and hands off to a TOP-LEVEL
// navigation where the session is first-party and works everywhere.
//
// Two fields and a button, deliberately. No password: removing it (and the
// "check your email" wall behind it) is the biggest conversion lever on a page
// like this, and the asset is a planning tool, not a bank account.

import React, { useState } from 'react';
import { ArrowRight, Check, Star } from 'lucide-react';
import { BRAND } from '../theme.js';
import { SUMMARY } from '../reviewsData.js';
import { MARKETING_CONSENT_TEXT, consentRecord } from '../lib/courseConsent.js';

const PORTAL_ORIGIN = window.location.origin;

// Where to send the top window once the account exists. `loginToken` is what
// makes this work in a third-party context — see the handoff comment in
// api/portal.js. Falls back to a plain portal URL when there's no token, which
// still works for a direct (first-party) visit where the cookie did land.
function landingUrl({ to, loginToken }) {
  const hash = to || '#/brief';
  return loginToken
    ? `${PORTAL_ORIGIN}/portal?login=${encodeURIComponent(loginToken)}${hash}`
    : `${PORTAL_ORIGIN}/portal${hash}`;
}

// Break out of the iframe to the real portal.
//
// Writing window.top.location IS permitted cross-origin under user activation
// (reading it is not), and a form submit is user activation — so this works in a
// normal iframe. It fails only if the embed added a `sandbox` attribute without
// allow-top-navigation, so the caller always renders a visible target="_top"
// link as well: never leave someone stranded in a 400px frame.
function goTop(url) {
  try {
    if (window.top && window.top !== window) { window.top.location.href = url; return true; }
  } catch { /* sandboxed — fall through to the visible link */ }
  try { window.location.href = url; return true; } catch { return false; }
}

// The pitch, in one place, because three variants render it and copy that
// drifts between two embeds of the same offer is worse than copy that is merely
// wrong — at least wrong copy is wrong consistently.
//
// EYEBROW names the thing, because the button that sent them here names it too.
// An eyebrow reading "Free planning tool" after a click on "Free Online Brief
// Builder" leaves people checking they landed in the right place. "Free" stays:
// it is the offer, not decoration.
const PITCH = {
  eyebrow: 'Free · Online Brief Builder',
  intro: "The brief builder walks you through the same questions we'd ask on a kick-off "
    + 'call — what it’s for, who it’s for, and the one thing it has to land. Answer '
    + 'what you can; we can work from as little as a list of key points.',
  bullets: [
    'Saves as you type — stop halfway and come back whenever',
    'Twenty-five questions, and only five that really matter',
    'Ends with a document any production company could work from',
    'Free, no card, and no password to remember',
  ],
};

// Word for word the "How it works" steps on squideo.com/online-brief-builder.
// Two pages selling one thing in two different sets of words is how a visitor
// ends up wondering whether they are the same thing.
const STEPS = [
  {
    title: 'Answer the questions',
    body: 'Who the video is for, what it has to make them do, what already exists. Plain '
      + 'questions, no jargon, and you can skip the ones you don’t know yet.',
  },
  {
    title: 'Come back whenever',
    body: 'It saves as you type and it’s tied to your account, so a brief started on a '
      + 'Tuesday lunchtime is still there on Thursday. Your colleagues can add to it too.',
  },
  {
    title: 'Take the document',
    body: 'You end up with a written brief you own — usable with us, with another studio, '
      + 'or as the thing that finally gets your own team agreeing on what the video is.',
  },
];

// Three shapes, one page — the same trick /reviews uses with ?theme and ?speed,
// so another embed costs a query param rather than another rollup input,
// rewrite, CSP block and lookahead entry.
//
//   compact (default) — just the card. For a page whose own copy is already
//                       doing the selling.
//   full              — card plus the pitch, on one transparent band. For
//                       dropping into a homepage or a process page section
//                       where nothing around it explains what this is.
//   landing           — the whole landing page, minus the site chrome, for
//                       iframing into Duda. Mirrors
//                       squideo.com/online-brief-builder so the two sites make
//                       the same offer in the same words until Duda retires.
export function BriefStart({ getAttribution, variant = 'compact' }) {
  const carded = variant === 'full' || variant === 'landing';
  const form = <BriefStartForm getAttribution={getAttribution} full={carded} />;
  if (variant === 'landing') return <BriefLanding>{form}</BriefLanding>;
  if (variant === 'full') return <BriefPromo>{form}</BriefPromo>;
  return form;
}

// Deliberately no JS breakpoints: inside an iframe the useful width is the
// frame's, not the device's, and the host controls that. Letting the two
// columns wrap on their own basis means it lays out correctly at any width
// without knowing anything about where it's been embedded.
function BriefPromo({ children }) {
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 34, alignItems: 'center',
      justifyContent: 'center', maxWidth: 1060, margin: '0 auto',
      padding: '38px 22px', boxSizing: 'border-box',
      fontFamily: 'inherit', color: BRAND.ink,
    }}>
      <div style={{ flex: '1 1 380px', minWidth: 0, maxWidth: 520 }}>
        <div style={EYEBROW}>{PITCH.eyebrow}</div>
        <h2 style={{
          margin: '0 0 14px', fontSize: 'clamp(25px, 3.4vw, 34px)', lineHeight: 1.15,
          fontWeight: 800, letterSpacing: '-0.02em', color: BRAND.ink,
        }}>
          You know you need a video.<br />Briefing it is the hard part.
        </h2>
        <p style={{ margin: '0 0 20px', fontSize: 15.5, lineHeight: 1.65, color: '#5A7382' }}>
          {PITCH.intro}
        </p>
        <Bullets tone="light" />
      </div>
      <div style={{ flex: '1 1 340px', minWidth: 0, maxWidth: 460, width: '100%' }}>
        {children}
      </div>
    </div>
  );
}

/**
 * The full landing page with no header, footer or logo, so Duda's own chrome
 * wraps it and it reads as a page on squideo.com rather than a widget.
 *
 * WHY THE FORM SITS IN THE HERO rather than below the steps, which is the order
 * the page on the new site uses: this is embedded in an auto-height iframe, so
 * the frame has no scrollbar of its own — the parent page does the scrolling.
 * An in-page "Start your brief" button jumping to an anchor further down would
 * scroll a viewport that isn't scrollable and appear to do nothing. Putting the
 * card in the hero removes the need for one.
 *
 * WHY <h2> AND NOT <h1>: the Duda page around it carries the h1, and an iframe's
 * headings are a separate document anyway. Give the Duda page a real heading —
 * nothing in here can do that job for it.
 *
 * Each band paints its own background. The page background stays transparent
 * (see brief-start.html), which is right for the other two variants and
 * invisible here because the bands cover the frame edge to edge.
 */
function BriefLanding({ children }) {
  return (
    <div style={{ fontFamily: 'inherit', color: BRAND.ink }}>

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <section style={{ background: BRAND.ink, padding: '52px 22px 56px' }}>
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 40, alignItems: 'center',
          justifyContent: 'center', maxWidth: 1060, margin: '0 auto',
        }}>
          <div style={{ flex: '1 1 380px', minWidth: 0, maxWidth: 520 }}>
            <div style={{ ...EYEBROW, color: '#7FD5F2' }}>{PITCH.eyebrow}</div>
            <h2 style={{
              margin: '0 0 16px', fontSize: 'clamp(27px, 3.6vw, 38px)', lineHeight: 1.12,
              fontWeight: 800, letterSpacing: '-0.02em', color: '#fff',
            }}>
              You know you need a video.<br />Briefing it is the hard part.
            </h2>
            {/* Not pure white: on a saturated navy it vibrates and is genuinely
                harder to read. Same call the new site's ink sections make. */}
            <p style={{ margin: '0 0 22px', fontSize: 16, lineHeight: 1.65, color: '#B9CEDB' }}>
              {PITCH.intro}
            </p>
            <Bullets tone="dark" />
          </div>
          <div style={{ flex: '1 1 340px', minWidth: 0, maxWidth: 460, width: '100%' }}>
            {children}
          </div>
        </div>
      </section>

      {/* ── How it works ───────────────────────────────────────────────────── */}
      <section style={{ background: '#fff', padding: '52px 22px' }}>
        <div style={{ maxWidth: 1060, margin: '0 auto' }}>
          <h3 style={{
            margin: '0 0 30px', fontSize: 'clamp(21px, 2.4vw, 26px)', fontWeight: 800,
            letterSpacing: '-0.01em', color: BRAND.ink,
          }}>
            How it works
          </h3>
          <ol style={{
            margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 30,
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          }}>
            {STEPS.map((step, i) => (
              <li key={step.title} style={{ borderTop: `1px solid ${BRAND.border}`, paddingTop: 18 }}>
                <div style={{
                  fontSize: 12.5, fontWeight: 800, letterSpacing: 1, color: BRAND.blue,
                  marginBottom: 8,
                }}>
                  {String(i + 1).padStart(2, '0')}
                </div>
                <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 8, color: BRAND.ink }}>
                  {step.title}
                </div>
                <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: '#5A7382' }}>
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Proof ──────────────────────────────────────────────────────────── */}
      <section style={{ background: BRAND.paper, borderTop: `1px solid ${BRAND.border}`, padding: '30px 22px' }}>
        <div style={{
          maxWidth: 1060, margin: '0 auto', display: 'flex', flexWrap: 'wrap',
          alignItems: 'center', gap: '10px 16px', justifyContent: 'center',
          textAlign: 'center', fontSize: 14.5, color: '#5A7382',
        }}>
          <span style={{ display: 'inline-flex', gap: 2 }} aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <Star key={i} size={17} strokeWidth={0} style={{ fill: '#F5A623' }} />
            ))}
          </span>
          <span>
            <strong style={{ color: BRAND.ink, fontWeight: 700 }}>{SUMMARY.rating}</strong>
            {' '}from {SUMMARY.count} reviews ·{' '}
            {/* _blank, not _top: reading a review should not throw away the
                half-filled form behind it. */}
            <a
              href={SUMMARY.href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: BRAND.blue, fontWeight: 600 }}
            >
              read them
            </a>
          </span>
        </div>
      </section>
    </div>
  );
}

const EYEBROW = {
  display: 'inline-block', fontSize: 11.5, fontWeight: 700, letterSpacing: 1.1,
  textTransform: 'uppercase', color: BRAND.blue, marginBottom: 12,
};

function Bullets({ tone }) {
  const dark = tone === 'dark';
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 11 }}>
      {PITCH.bullets.map((line) => (
        <li
          key={line}
          style={{
            display: 'flex', gap: 10, alignItems: 'flex-start',
            fontSize: 14.5, lineHeight: 1.5, color: dark ? '#DCEAF2' : 'inherit',
          }}
        >
          <Check
            size={17}
            strokeWidth={3}
            style={{ color: dark ? '#7FD5F2' : BRAND.blue, flexShrink: 0, marginTop: 2 }}
          />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

function BriefStartForm({ getAttribution, full = false }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState('');   // honeypot
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);       // { mode: 'go' | 'email', url? }

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/auth?op=brief-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name, email, website,
          handoff: true,                 // mint the one-time login token
          marketingConsent: consent,
          consentText: consentRecord(consent),
          attribution: getAttribution ? getAttribution() : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong — try again.');

      if (data.next === 'portal') {
        const url = landingUrl(data);
        setDone({ mode: 'go', url });
        goTop(url);
        return;
      }
      setDone({ mode: 'email' });      // address already had an account
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (done?.mode === 'email') {
    return (
      <div style={CARD}>
        <h2 style={H2}>Check your email</h2>
        <p style={P}>
          You already have a Squideo account, so the brief builder is already there —
          along with anything you'd started before. We've sent a sign-in link to <strong>{email}</strong>.
        </p>
      </div>
    );
  }

  if (done?.mode === 'go') {
    // goTop has already fired; this is what someone sees if the embed is
    // sandboxed and the navigation was refused. The anchor is the reliable
    // escape hatch — target="_top" works where scripted navigation doesn't.
    return (
      <div style={CARD}>
        <h2 style={H2}>You're in</h2>
        <p style={P}>Taking you to your brief…</p>
        <a href={done.url} target="_top" style={{ ...BTN, textDecoration: 'none', marginTop: 4 }}>
          Open my brief <ArrowRight size={16} />
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={full ? { ...CARD, boxShadow: '0 14px 40px rgba(15,42,61,.10)' } : CARD}>
      {/* In the full variant the column beside this has already made the pitch,
          so repeating it here would just push the fields below the fold. */}
      <h2 style={H2}>{full ? 'Start your brief' : 'Build your video brief'}</h2>
      <p style={P}>
        {full
          ? 'Two details and you\'re in. Nothing to install, nothing to pay.'
          : 'A guided tool that turns a rough idea into a document any production company could work from. It saves as you type, so you can stop halfway and come back.'}
      </p>

      {error && (
        <div style={{
          background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C',
          borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 14,
          lineHeight: 1.45, textAlign: 'left',
        }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 380, margin: '0 auto' }}>
        <input
          required value={name} autoComplete="name" style={INPUT}
          onChange={(e) => setName(e.target.value)} placeholder="Your name"
        />
        <input
          required type="email" value={email} autoComplete="email" style={INPUT}
          onChange={(e) => setEmail(e.target.value)} placeholder="Work email"
        />
        {/* Off-screen, not display:none — some bots skip hidden fields but fill
            anything they can read in the DOM. Real people never see it. */}
        <input
          type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true"
          value={website} onChange={(e) => setWebsite(e.target.value)}
          style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
        />
        <button type="submit" disabled={busy} style={{ ...BTN, opacity: busy ? 0.7 : 1 }}>
          {busy ? 'Setting it up…' : <>Start my brief <ArrowRight size={16} /></>}
        </button>
      </div>

      <label style={{
        display: 'flex', gap: 9, alignItems: 'flex-start', maxWidth: 380,
        margin: '14px auto 0', textAlign: 'left', fontSize: 12.5,
        color: BRAND.muted, lineHeight: 1.5, cursor: 'pointer',
      }}>
        <input
          type="checkbox" checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          style={{ marginTop: 2, flexShrink: 0 }}
        />
        <span>{MARKETING_CONSENT_TEXT}</span>
      </label>

      {/* The full variant already says this as a bullet in the column beside
          the card, and saying it twice in one eyeful reads as protesting. */}
      {!full && (
        <div style={{ marginTop: 12, fontSize: 12, color: BRAND.muted }}>
          Free. No card. No password to remember.
        </div>
      )}
    </form>
  );
}

// Styles are inline rather than className="input"/"btn": those classes live in
// src/styles.css, which only main.jsx and portal.jsx import. /course learned
// this the hard way — its signup button renders unstyled because it reaches for
// a class its own bundle never loads.
const CARD = {
  background: '#fff',
  border: `1px solid ${BRAND.border}`,
  borderRadius: 14,
  padding: '26px 22px',
  textAlign: 'center',
  maxWidth: 520,
  margin: '0 auto',
  boxSizing: 'border-box',
};

const H2 = { margin: '0 0 8px', fontSize: 21, fontWeight: 800, color: BRAND.ink };

const P = {
  margin: '0 auto 18px', maxWidth: 440, fontSize: 14,
  lineHeight: 1.6, color: BRAND.muted,
};

// 16px: below it, iOS Safari zooms the page on focus and does not zoom back out
// — worse inside an iframe, where the parent page zooms with it.
const INPUT = {
  width: '100%', boxSizing: 'border-box', padding: '12px 13px',
  border: `1px solid ${BRAND.border}`, borderRadius: 9, fontSize: 16,
  fontFamily: 'inherit', color: BRAND.ink, background: '#fff', lineHeight: 1.4,
};

const BTN = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
  width: '100%', boxSizing: 'border-box', padding: '13px 18px',
  borderRadius: 9, border: 'none', cursor: 'pointer',
  background: BRAND.blue, color: '#fff', fontSize: 16, fontWeight: 700,
  fontFamily: 'inherit',
};
