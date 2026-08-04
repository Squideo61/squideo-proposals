// The Explainer Video Crash Course, inside the portal.
//
// Every signed-in portal user sees all eight videos — real clients and course
// signups alike. There's nothing org-scoped here, so no company switcher
// interaction and no empty-state-per-org to worry about.
//
// Progress is a 15-second heartbeat plus pause/ended/tab-hidden. It's fire and
// forget: the server always answers 200, and nothing on this page waits on it
// or shows an error if it fails. Losing someone's place in a free marketing
// video is not worth a spinner, let alone a red box.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Check, GraduationCap, ArrowRight, RotateCcw } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { portalApi, mediaUrl } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, SectionHeading } from '../components.jsx';
import { navigate } from '../PortalApp.jsx';

const HEARTBEAT_MS = 15000;

const fmt = (s) => {
  if (!s && s !== 0) return null;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
};

export default function Course({ slug }) {
  const { showToast } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try { setData(await portalApi.get('course')); }
    catch (err) { setError(err.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <EmptyState title="Couldn't load the course" body={error} />;
  if (!data) return <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>Loading…</div>;

  const modules = data.modules || [];
  if (!modules.length) {
    return <EmptyState title="The course is on its way" body="We're putting the videos online now — check back shortly." />;
  }

  // A slug in the URL wins; otherwise pick up where they left off.
  const active = modules.find((m) => m.slug === slug)
    || modules.find((m) => m.slug === data.continueSlug)
    || modules[0];

  return (
    <div>
      <SectionHeading>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <GraduationCap size={18} color={BRAND.blue} />
          The Explainer Video Crash Course
        </span>
      </SectionHeading>
      <p style={{ margin: '-6px 0 16px', fontSize: 13, color: BRAND.muted, lineHeight: 1.55 }}>
        Brief to Broadcast — everything we know about making a video that works.
      </p>

      <ProgressBar
        done={data.completedCount}
        total={data.totalCount}
        percent={data.percentComplete}
        allComplete={data.allComplete}
      />

      <Player
        key={active.slug}
        module={active}
        onProgress={load}
        showToast={showToast}
      />

      {/* Escalate the ask with engagement. Someone two videos in doesn't want a
          sales call; they want to do something with what they just learnt. The
          brief is that something, and it happens to be the warmest lead we can
          get. Asking for a call at video 1 wastes the asset. */}
      {!data.allComplete && <NextStepCard done={data.completedCount} />}

      <div style={{ marginTop: 22 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 }}>
          All {modules.length} videos
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {modules.map((m) => (
            <ModuleRow
              key={m.slug}
              module={m}
              active={m.slug === active.slug}
              onClick={() => navigate(`#/course/${m.slug}`)}
            />
          ))}
        </div>
      </div>

      {data.allComplete && <CompletionCard />}
    </div>
  );
}

// One quiet, contextual card under the player — never a modal, never mid-video.
// It stays out of the way until someone has actually watched something.
function NextStepCard({ done }) {
  if (!done) return null;
  return (
    <div style={{
      marginTop: 16, padding: '14px 16px', borderRadius: 10,
      background: '#F3F9FC', border: '1px solid #DCEBF3',
      display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
    }}>
      <div style={{ flex: '1 1 260px', fontSize: 13.5, lineHeight: 1.55, color: BRAND.ink }}>
        <strong>Put it to use.</strong>{' '}
        <span style={{ color: BRAND.muted }}>
          The brief builder asks these same questions about your video, and saves as you go.
        </span>
      </div>
      <button
        type="button"
        onClick={() => navigate('#/brief')}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: BRAND.blue, color: '#fff', border: 'none', borderRadius: 8,
          padding: '9px 15px', fontSize: 13.5, fontWeight: 600,
          fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        Start your brief <ArrowRight size={14} />
      </button>
    </div>
  );
}

function ProgressBar({ done, total, percent, allComplete }) {
  return (
    <div style={{ margin: '0 0 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink }}>
          {allComplete ? 'Course complete 🎉' : `${done} of ${total} watched`}
        </span>
        <span style={{ fontSize: 12.5, color: BRAND.muted }}>{percent}%</span>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: '#E8EEF3', overflow: 'hidden' }}>
        <div style={{
          width: `${percent}%`, height: '100%', borderRadius: 999,
          background: allComplete ? '#15803D' : BRAND.blue, transition: 'width 300ms',
        }} />
      </div>
    </div>
  );
}

function Player({ module: m, onProgress, showToast }) {
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
    }).then(() => { if (extra.ended) onProgress(); }).catch(() => {});
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

  const onLoaded = () => {
    const v = videoRef.current;
    if (v && canResume && !resumed) { v.currentTime = m.resumeSeconds; setResumed(true); }
  };

  const restart = () => {
    const v = videoRef.current;
    if (v) { v.currentTime = 0; v.play?.().catch(() => {}); }
    setResumed(true);
  };

  return (
    <Card>
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

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', color: BRAND.blue }}>
          Video {m.moduleNumber}
        </span>
        <span style={{ fontSize: 16.5, fontWeight: 700, color: BRAND.ink }}>{m.title}</span>
        {m.durationSeconds && <span style={{ fontSize: 12.5, color: BRAND.muted }}>{fmt(m.durationSeconds)}</span>}
        {m.completed && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: '#15803D' }}>
            <Check size={12} /> Watched
          </span>
        )}
        {canResume && (
          <button className="btn-ghost" onClick={restart} style={{ fontSize: 12, marginLeft: 'auto' }}>
            <RotateCcw size={13} /> Start again
          </button>
        )}
      </div>

      {(m.subtitle || m.description) && (
        <p style={{ margin: '8px 0 0', fontSize: 13.5, lineHeight: 1.6, color: BRAND.muted }}>
          {m.description || m.subtitle}
        </p>
      )}
      {canResume && (
        <div style={{ marginTop: 8, fontSize: 12, color: BRAND.muted }}>
          Picking up from {fmt(m.resumeSeconds)}.
        </div>
      )}
    </Card>
  );
}

function ModuleRow({ module: m, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
        padding: '9px 12px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
        background: active ? BRAND.blue + '12' : '#fff',
        border: `1px solid ${active ? BRAND.blue : BRAND.border}`,
      }}
    >
      <span style={{
        width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: m.completed ? '#15803D' : (active ? BRAND.blue : '#EEF3F7'),
        color: m.completed || active ? '#fff' : BRAND.muted,
        fontSize: 11.5, fontWeight: 800,
      }}>
        {m.completed ? <Check size={14} /> : (active ? <Play size={12} fill="#fff" /> : m.moduleNumber)}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: BRAND.ink }}>{m.title}</span>
        {m.subtitle && (
          <span style={{ display: 'block', fontSize: 12, color: BRAND.muted, marginTop: 1 }}>{m.subtitle}</span>
        )}
      </span>
      {m.durationSeconds && (
        <span style={{ fontSize: 11.5, color: BRAND.muted, flexShrink: 0 }}>{fmt(m.durationSeconds)}</span>
      )}
    </button>
  );
}

// The single warmest moment this feature ever produces — someone has just
// watched the whole thing. One clear ask, not a menu of three.
function CompletionCard() {
  return (
    <div style={{
      marginTop: 22, background: '#EDFBF2', border: '1px solid #9BE0B7',
      borderRadius: 14, padding: 22, textAlign: 'center',
    }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800, color: '#15803D' }}>
        That's the lot. Now the useful bit.
      </h3>
      <p style={{ margin: '0 auto 16px', maxWidth: 440, fontSize: 13.5, lineHeight: 1.6, color: '#166534' }}>
        Everything in those videos is what we'd ask you on a first call anyway — so the
        brief builder asks it properly, saves as you go, and gives you a document you can
        send to anyone. Including us.
      </p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
        <a href="#/brief" className="btn" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          Build your brief <ArrowRight size={15} />
        </a>
        {/* Secondary on purpose. Someone who's just finished the course gets a better
            video from a brief than from a one-box request — but forcing it on people
            who already know exactly what they want is friction, not helpfulness. */}
        <a href="#/request" style={{
          textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
          padding: '10px 16px', borderRadius: 8, border: '1px solid #9BE0B7',
          color: '#166534', fontSize: 13.5, fontWeight: 600, background: '#fff',
        }}>
          Just get me a price
        </a>
      </div>
    </div>
  );
}
