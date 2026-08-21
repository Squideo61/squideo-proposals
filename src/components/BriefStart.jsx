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
import { ArrowRight, Check } from 'lucide-react';
import { BRAND } from '../theme.js';
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

// Two shapes, one page — the same trick /reviews uses with ?theme and ?speed,
// so a second embed costs a query param rather than another rollup input,
// rewrite, CSP block and lookahead entry.
//
//   compact (default) — just the card. For the dedicated landing page, where
//                       the page around it is already doing the selling.
//   full              — card plus the pitch. For dropping into a homepage or a
//                       process page, where nothing else explains what this is.
export function BriefStart({ getAttribution, variant = 'compact' }) {
  const full = variant === 'full';
  const form = <BriefStartForm getAttribution={getAttribution} full={full} />;
  return full ? <BriefPromo>{form}</BriefPromo> : form;
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
        <div style={{
          display: 'inline-block', fontSize: 11.5, fontWeight: 700, letterSpacing: 1.1,
          textTransform: 'uppercase', color: BRAND.blue, marginBottom: 12,
        }}>
          {/* Names the thing, because the button that sent them here names it
              too. An eyebrow reading "Free planning tool" after a click on
              "Free Online Brief Builder" leaves people checking they landed in
              the right place. "Free" stays: it is the offer. */}
          Free · Online Brief Builder
        </div>
        <h2 style={{
          margin: '0 0 14px', fontSize: 'clamp(25px, 3.4vw, 34px)', lineHeight: 1.15,
          fontWeight: 800, letterSpacing: '-0.02em', color: BRAND.ink,
        }}>
          You know you need a video.<br />Briefing it is the hard part.
        </h2>
        <p style={{ margin: '0 0 20px', fontSize: 15.5, lineHeight: 1.65, color: '#5A7382' }}>
          The brief builder walks you through the same questions we'd ask on a kick-off
          call — what it's for, who it's for, and the one thing it has to land. Answer
          what you can; we can work from as little as a list of key points.
        </p>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 11 }}>
          {[
            'Saves as you type — stop halfway and come back whenever',
            'Twenty-five questions, and only five that really matter',
            'Ends with a document any production company could work from',
            'Free, no card, and no password to remember',
          ].map((line) => (
            <li key={line} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14.5, lineHeight: 1.5 }}>
              <Check size={17} strokeWidth={3} style={{ color: BRAND.blue, flexShrink: 0, marginTop: 2 }} />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
      <div style={{ flex: '1 1 340px', minWidth: 0, maxWidth: 460, width: '100%' }}>
        {children}
      </div>
    </div>
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
