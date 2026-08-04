// The public landing page for The Explainer Video Crash Course.
//
// The whole conversion strategy is the order of this page: module 1 plays
// immediately, with no form anywhere above it. The signup only appears once
// someone has watched something and knows whether we're any good. Asking first
// converts on a promise; asking after converts on evidence.
//
// Locked modules are fully described — title, summary, duration, thumbnail —
// and only the bytes are withheld. Curiosity converts; a paywall doesn't.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, Play, Check, ArrowRight } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { SQUIDEO_LOGO } from '../../defaults.js';
import { storedAttribution } from '../../lib/attribution.js';
import { MARKETING_CONSENT_TEXT, COURSE_EMAILS_NOTICE, consentRecord } from '../../lib/courseConsent.js';

const NAVY = BRAND.ink;
const PALE = '#DCEEF7';
const MUTED = '#8FA9BA';
const ACCENT = '#9FDFF5';

const fmtDuration = (s) => {
  if (!s) return null;
  const mins = Math.floor(s / 60);
  const secs = Math.round(s % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
};

// "48 minutes" reads better than "0:48:12" in the hero, and a known finite
// commitment is one of the few things that reliably lifts course starts.
const fmtTotal = (s) => {
  if (!s) return null;
  const mins = Math.round(s / 60);
  return mins < 60 ? `${mins} minutes` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

export function CoursePage({ track }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  // Which free video the hero player is showing. null = the first one, not yet
  // touched; `auto` means the visitor chose it, so it should start playing
  // rather than sitting behind a play button.
  const [chosen, setChosen] = useState(null);
  const signupRef = useRef(null);
  const playerRef = useRef(null);

  useEffect(() => {
    fetch('/api/course?action=public')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('unavailable'))))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  // Someone who already has a session shouldn't be asked to sign up again —
  // they get "continue the course" instead. A 401 here is the normal answer for
  // an anonymous visitor, not an error.
  useEffect(() => {
    fetch('/api/portal/me', { credentials: 'include' })
      .then((r) => setSignedIn(r.ok))
      .catch(() => {});
  }, []);

  useEffect(() => { track('page_view'); }, [track]);

  const scrollToSignup = useCallback(() => {
    track('signup_open');
    signupRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [track]);

  const modules = data?.modules || [];
  const freeModules = modules.filter((m) => m.free);
  const gatedCount = modules.length - freeModules.length;
  const total = fmtTotal(data?.totalSeconds);

  const active = freeModules.find((m) => m.slug === chosen?.slug) || freeModules[0] || null;

  // Clicking a free tile swaps the hero player and scrolls back to it, rather
  // than playing inline in the grid — one player keeps the page calm, and the
  // hero is where the eye already is.
  const playFree = useCallback((slug) => {
    setChosen({ slug, auto: true });
    playerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // Roll straight on to the next free video, and only when they run out show
  // the signup. Someone who has just watched all three unprompted is the
  // warmest this page ever gets them.
  const onFreeEnded = useCallback((slug) => {
    const i = freeModules.findIndex((m) => m.slug === slug);
    const next = i >= 0 ? freeModules[i + 1] : null;
    if (next) { setChosen({ slug: next.slug, auto: true }); return; }
    if (!signedIn) scrollToSignup();
  }, [freeModules, signedIn, scrollToSignup]);

  return (
    <div style={{ background: NAVY, minHeight: '100vh', color: PALE }}>
      <div style={{ maxWidth: 940, margin: '0 auto', padding: '36px 20px 72px' }}>

        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <header style={{ textAlign: 'center', marginBottom: 28 }}>
          <img src={SQUIDEO_LOGO} alt="Squideo" style={{ height: 34, marginBottom: 18 }} />
          <div style={{
            color: ACCENT, fontSize: 12.5, fontWeight: 700, letterSpacing: 1.4,
            textTransform: 'uppercase', marginBottom: 12,
          }}>
            Brief to Broadcast
          </div>
          <h1 style={{
            margin: '0 0 14px', fontSize: 'clamp(28px, 5vw, 44px)', lineHeight: 1.12,
            fontWeight: 800, color: '#fff', letterSpacing: '-0.02em',
          }}>
            The Explainer Video<br />Crash Course
          </h1>
          <p style={{ margin: '0 auto', maxWidth: 560, fontSize: 16, lineHeight: 1.6, color: PALE }}>
            This is the same thinking we walk every client through before we start.
            We've put all of it here, free.
          </p>
          {(total || modules.length > 0) && (
            <div style={{ marginTop: 14, fontSize: 13.5, color: MUTED }}>
              {modules.length > 0 && `${modules.length} videos`}
              {total && modules.length > 0 && ' · '}
              {total}
              {' · no card'}
            </div>
          )}
        </header>

        {/* ── The free videos ──────────────────────────────────────────────── */}
        <div ref={playerRef}>
          {active
            ? (
              <FreePlayer
                // Remount on change so the <video> reloads rather than keeping
                // the previous source's buffered state.
                key={active.slug}
                module={active}
                autoStart={!!chosen?.auto}
                freeCount={freeModules.length}
                track={track}
                onEnded={() => onFreeEnded(active.slug)}
              />
            )
            : <PlayerPlaceholder failed={failed} loading={!data} />}
        </div>

        {/* ── The grid ─────────────────────────────────────────────────────── */}
        {modules.length > 0 && (
          <section style={{ marginTop: 40 }}>
            <h2 style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: ACCENT, margin: '0 0 16px' }}>
              What's inside
            </h2>
            <div style={{
              display: 'grid', gap: 12,
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            }}>
              {modules.map((m) => (
                <ModuleTile
                  key={m.slug}
                  module={m}
                  playing={m.slug === active?.slug}
                  onClick={m.locked ? scrollToSignup : () => playFree(m.slug)}
                />
              ))}
            </div>
          </section>
        )}

        {/* ── Signup / continue ────────────────────────────────────────────── */}
        <section ref={signupRef} style={{ marginTop: 44 }}>
          {signedIn ? <ContinueCard /> : <SignupCard gatedCount={gatedCount} />}
        </section>

        {/* ── What else you get ────────────────────────────────────────────── */}
        <section style={{ marginTop: 44 }}>
          <h2 style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: ACCENT, margin: '0 0 16px' }}>
            And when you sign up
          </h2>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            <Perk title="A brief you can actually use">
              A guided brief builder that turns what you've learnt into a document any
              production company could work from — including us.
            </Perk>
            <Perk title="A look inside the real thing">
              You get an account on the same portal our clients use. Have a proper look
              round: storyboard reviews, timestamped video feedback, the lot.
            </Perk>
            <Perk title="No sales call required">
              Watch it, use it, and get on with your day. If you want a quote or a chat
              afterwards it's one click — but nobody will chase you.
            </Perk>
          </div>
        </section>

        <footer style={{ marginTop: 48, textAlign: 'center', fontSize: 12.5, color: MUTED, lineHeight: 1.7 }}>
          Squideo · <a href="mailto:enquiries@squideo.co.uk" style={{ color: ACCENT }}>enquiries@squideo.co.uk</a> · 01482 738 656
        </footer>
      </div>
    </div>
  );
}

// ── The free player ──────────────────────────────────────────────────────────
// Poster-first with preload="none": this page is served to anonymous traffic,
// and preloading a video for every visitor who never presses play is the one
// easy way to run up a blob egress bill on a free lead magnet.
function FreePlayer({ module: m, track, onEnded, autoStart = false, freeCount = 1 }) {
  // autoStart means the visitor picked this one (a tile click, or it auto-
  // advanced from the previous video), so waiting behind a play button would
  // just be a second click for the same decision.
  const [playing, setPlaying] = useState(autoStart);
  const played = useRef(false);

  const start = () => {
    setPlaying(true);
    if (!played.current) { played.current = true; track('play', { slug: m.slug }); }
  };

  useEffect(() => { if (autoStart && !played.current) { played.current = true; track('play', { slug: m.slug }); } },
    [autoStart, m.slug, track]);

  return (
    <div>
      <div style={{
        position: 'relative', borderRadius: 14, overflow: 'hidden', background: '#000',
        aspectRatio: '16 / 9', boxShadow: '0 24px 60px rgba(0,0,0,0.42)',
      }}>
        {playing ? (
          <video
            controls
            autoPlay
            playsInline
            preload="metadata"
            controlsList="nodownload"
            poster={m.posterUrl || undefined}
            src={`/api/course?action=stream&slug=${encodeURIComponent(m.slug)}`}
            onEnded={() => { track('progress', { slug: m.slug, ended: true }); onEnded?.(); }}
            style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
          />
        ) : (
          <button
            onClick={start}
            aria-label={`Play ${m.title}`}
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%', padding: 0,
              border: 'none', cursor: 'pointer', background: m.posterUrl ? '#000' : '#12384F',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {m.posterUrl && (
              <img src={m.posterUrl} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.72 }} />
            )}
            <span style={{
              position: 'relative', width: 76, height: 76, borderRadius: '50%',
              background: BRAND.blue, display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
            }}>
              <Play size={30} color="#fff" fill="#fff" style={{ marginLeft: 4 }} />
            </span>
          </button>
        )}
      </div>
      <div style={{ marginTop: 14, display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: '#7FE0A8' }}>
          Video {m.moduleNumber} · {freeCount > 1 ? `${freeCount} free to watch` : 'watch now'}
        </span>
        <span style={{ fontSize: 17, fontWeight: 700, color: '#fff' }}>{m.title}</span>
        {fmtDuration(m.durationSeconds) && (
          <span style={{ fontSize: 12.5, color: MUTED }}>{fmtDuration(m.durationSeconds)}</span>
        )}
      </div>
      {m.subtitle && (
        <p style={{ margin: '6px 0 0', fontSize: 14, lineHeight: 1.6, color: PALE, maxWidth: 640 }}>{m.subtitle}</p>
      )}
    </div>
  );
}

function PlayerPlaceholder({ failed, loading }) {
  return (
    <div style={{
      borderRadius: 14, aspectRatio: '16 / 9', background: '#12384F',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: MUTED, fontSize: 14, textAlign: 'center', padding: 24,
    }}>
      {loading ? 'Loading…'
        : failed ? "We couldn't load the course just now — please refresh."
        : 'The first video is being uploaded — check back shortly.'}
    </div>
  );
}

// ── A grid tile ──────────────────────────────────────────────────────────────
function ModuleTile({ module: m, onClick, playing = false }) {
  const [hover, setHover] = useState(false);
  const interactive = !!onClick;
  const duration = fmtDuration(m.durationSeconds);
  const highlight = playing || (hover && interactive);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      style={{
        background: highlight ? '#194A66' : '#153E56',
        border: `1px solid ${playing ? BRAND.blue : (highlight ? '#2E6E90' : '#204F6B')}`,
        borderRadius: 12, overflow: 'hidden', cursor: interactive ? 'pointer' : 'default',
        transition: 'background 120ms, border-color 120ms',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{ position: 'relative', aspectRatio: '16 / 9', background: '#0B2536' }}>
        {m.posterUrl && (
          <img src={m.posterUrl} alt="" loading="lazy" style={{
            width: '100%', height: '100%', objectFit: 'cover',
            opacity: m.locked ? 0.42 : 0.85,
          }} />
        )}
        <span style={{
          position: 'absolute', top: 8, left: 8, fontSize: 10.5, fontWeight: 800,
          padding: '2px 7px', borderRadius: 999, letterSpacing: 0.4,
          background: m.locked ? 'rgba(11,37,54,0.82)' : (playing ? BRAND.blue : '#7FE0A8'),
          color: m.locked ? PALE : (playing ? '#fff' : '#0B2536'),
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          {m.locked ? <Lock size={9} /> : (playing ? <Play size={9} fill="currentColor" /> : <Check size={10} />)}
          {m.locked ? `Video ${m.moduleNumber}` : (playing ? 'Now playing' : 'Free')}
        </span>
        {duration && (
          <span style={{
            position: 'absolute', bottom: 8, right: 8, fontSize: 11, fontWeight: 600,
            padding: '1px 6px', borderRadius: 4, background: 'rgba(11,37,54,0.85)', color: PALE,
          }}>
            {duration}
          </span>
        )}
      </div>
      <div style={{ padding: '11px 13px 13px' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', lineHeight: 1.35 }}>{m.title}</div>
        {m.subtitle && (
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>{m.subtitle}</div>
        )}
      </div>
    </div>
  );
}

// ── Signup ───────────────────────────────────────────────────────────────────
// Two fields and a button. No password: the account is created and signed in on
// submit, and a magic link covers return visits. Removing the password field
// and the "check your email" wall behind it is the biggest single conversion
// lever on this page, and there is nothing here worth protecting with one — the
// asset is a free marketing video, not a bank account.
function SignupCard({ gatedCount }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState('');   // honeypot
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/auth?op=course-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',       // the session cookie comes back on this response
        body: JSON.stringify({
          name, email, website,
          marketingConsent: consent,
          consentText: consentRecord(consent),
          attribution: storedAttribution(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong — try again.');
      if (data.next === 'portal') { window.location.href = '/portal#/course'; return; }
      setSent(true);                  // address already had an account
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div style={CARD}>
        <h2 style={{ margin: '0 0 8px', fontSize: 21, fontWeight: 800 }}>Check your email</h2>
        <p style={{ margin: '0 auto', maxWidth: 420, fontSize: 14, lineHeight: 1.6, color: BRAND.muted }}>
          You already have a Squideo account, so the course is waiting for you.
          We've sent a sign-in link to <strong>{email}</strong>.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={CARD}>
      <h2 style={{ margin: '0 0 8px', fontSize: 21, fontWeight: 800 }}>
        {gatedCount > 0 ? `Unlock the last ${gatedCount}` : 'Get the brief builder'}
      </h2>
      <p style={{ margin: '0 auto 18px', maxWidth: 470, fontSize: 14, lineHeight: 1.6, color: BRAND.muted }}>
        {/* The remaining videos are barely three minutes, so they can't carry
            the ask on their own — the account is what's actually worth having. */}
        A free account unlocks the rest and gives you the brief builder: a guided
        tool that turns all this into a document any production company could work
        from. You'll also get a proper look inside the portal we run projects in.
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
          className="input" required value={name} autoComplete="name"
          onChange={(e) => setName(e.target.value)} placeholder="Your name"
          style={{ fontSize: 15, padding: '11px 13px' }}
        />
        <input
          className="input" required type="email" value={email} autoComplete="email"
          onChange={(e) => setEmail(e.target.value)} placeholder="Work email"
          style={{ fontSize: 15, padding: '11px 13px' }}
        />
        {/* Off-screen, not display:none — some bots skip hidden fields but fill
            anything they can read in the DOM. Real people never see it. */}
        <input
          type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true"
          value={website} onChange={(e) => setWebsite(e.target.value)}
          style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
        />
        <button className="btn" type="submit" disabled={busy} style={{ fontSize: 15, padding: '12px 18px', justifyContent: 'center' }}>
          {busy ? 'Unlocking…' : <>Watch the rest <ArrowRight size={16} /></>}
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
        Free. No card. {COURSE_EMAILS_NOTICE}
      </div>
    </form>
  );
}

const CARD = {
  background: '#fff', color: BRAND.ink, borderRadius: 16, padding: 28,
  boxShadow: '0 18px 50px rgba(0,0,0,0.28)', textAlign: 'center',
};

function ContinueCard() {
  return (
    <div style={{
      background: '#fff', color: BRAND.ink, borderRadius: 16, padding: 28,
      boxShadow: '0 18px 50px rgba(0,0,0,0.28)', textAlign: 'center',
    }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 21, fontWeight: 800 }}>You're already signed up</h2>
      <p style={{ margin: '0 auto 18px', maxWidth: 420, fontSize: 14, lineHeight: 1.6, color: BRAND.muted }}>
        Every video is unlocked in your portal — pick up where you left off.
      </p>
      <a
        href="/portal"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, background: BRAND.blue,
          color: '#fff', fontWeight: 700, fontSize: 15, padding: '12px 22px',
          borderRadius: 10, textDecoration: 'none',
        }}
      >
        Continue the course <ArrowRight size={16} />
      </a>
    </div>
  );
}

function Perk({ title, children }) {
  return (
    <div style={{ background: '#153E56', border: '1px solid #204F6B', borderRadius: 12, padding: '16px 17px' }}>
      <div style={{ fontSize: 14.5, fontWeight: 700, color: '#fff', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: MUTED }}>{children}</div>
    </div>
  );
}
