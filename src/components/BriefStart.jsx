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
import { ArrowRight } from 'lucide-react';
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

export function BriefStart({ getAttribution }) {
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
    <form onSubmit={submit} style={CARD}>
      <h2 style={H2}>Build your video brief</h2>
      <p style={P}>
        A guided tool that turns a rough idea into a document any production company
        could work from. It saves as you type, so you can stop halfway and come back.
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

      <div style={{ marginTop: 12, fontSize: 12, color: BRAND.muted }}>
        Free. No card. No password to remember.
      </div>
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
