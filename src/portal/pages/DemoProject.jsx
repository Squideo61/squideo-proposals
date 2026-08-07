// The sample project — the real review surfaces, driven by fixtures.
//
// Almost no agency lets a prospect touch the client workflow before they buy.
// This is the strongest thing in the whole funnel for exactly that reason: it
// isn't a claim about how good the process is, it's the process.
//
// Two stages, because a video job has two moments where the client is actually
// in the driving seat: signing off the storyboard, and reviewing the cut. The
// overview screen frames both and tracks which they've tried; each stage hands
// the real component (StoryboardRevision / VideoRevision) a fixture-backed API.
//
// Routing: #/demo → overview, #/demo/storyboard, #/demo/video.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, RotateCcw, Info, Images, PlayCircle, Check, ChevronRight, Sparkles,
  MessageSquarePlus, Lock, Clock, CheckCircle2, Bell, X as XIcon,
} from 'lucide-react';
import { BRAND } from '../../theme.js';
import { usePortal } from '../PortalContext.jsx';
import { navigate } from '../PortalApp.jsx';
import { portalApi } from '../api.js';
import { VideoRevision } from '../../components/revision/VideoRevision.jsx';
import { StoryboardRevision } from '../../components/storyboard/StoryboardRevision.jsx';
import { createDemoRevApi } from '../demo/demoRevApi.js';
import { createDemoSbApi } from '../demo/demoSbApi.js';
import { resetDemo, demoProgress } from '../demo/store.js';
import { DEMO_STAGES } from '../demo/stages.js';
import { DEMO_TOKEN, DEMO_SB_TOKEN, buildDemoSchedule } from '../demo/fixtures.js';
import { ProjectSchedule } from '../components.jsx';

// The stage list lives in demo/stages.js so the dashboard can render the sample
// as a project card without importing this file (and with it, pdf.js). Icons
// are attached here rather than there to keep that module React-free.
const STAGE_ICON = { storyboard: Images, video: PlayCircle };
const STAGES = DEMO_STAGES.map((s) => ({ ...s, Icon: STAGE_ICON[s.icon] }));

// The real journey, with the two try-able moments picked out. Context matters
// more than it looks: without it "storyboard" and "video review" are two
// buttons, and with it they're two points on a process someone can picture
// their own project moving through.
const JOURNEY = ['Brief', 'Script', 'Storyboard', 'Animation', 'Video review', 'Delivery'];
const JOURNEY_TRY = new Set(['Storyboard', 'Video review']);

const card = {
  background: '#fff', border: `1px solid ${BRAND.border}`, borderRadius: 14,
  padding: 20, display: 'flex', flexDirection: 'column', gap: 12,
};

// ── Overview ────────────────────────────────────────────────────────────────

function StageCard({ stage, config, progress }) {
  const ready = stage.ready(config);
  const done = progress.tried;
  const { Icon } = stage;
  return (
    <div style={{
      ...card,
      // A tried stage gets a green edge rather than a badge alone — at a glance
      // the card itself should read as "done", the way the real task lists do.
      borderColor: done ? '#9BE0B7' : BRAND.border,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{
          width: 42, height: 42, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: done ? '#EDFBF2' : BRAND.blue + '1a', color: done ? '#15803D' : BRAND.blue,
        }}>
          {done ? <Check size={21} strokeWidth={2.6} /> : <Icon size={21} />}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase',
            color: BRAND.muted, marginBottom: 2,
          }}>
            Step {stage.step}
          </div>
          <div style={{ fontSize: 17, fontWeight: 800, color: BRAND.ink }}>{stage.label}</div>
        </div>
        {done && (
          <span style={{
            flexShrink: 0, background: '#EDFBF2', color: '#15803D', border: '1px solid #9BE0B7',
            borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap',
          }}>
            Tried it
          </span>
        )}
      </div>

      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: BRAND.muted }}>{stage.blurb}</p>

      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 7 }}>
        {stage.doing.map((d) => (
          <li key={d} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.5, color: BRAND.ink }}>
            <MessageSquarePlus size={14} style={{ flexShrink: 0, marginTop: 2, color: BRAND.blue }} />
            <span>{d}</span>
          </li>
        ))}
      </ul>

      <div style={{ marginTop: 'auto', paddingTop: 4 }}>
        {ready ? (
          <a
            className="btn"
            href={`#/demo/${stage.key}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}
          >
            {done ? 'Open it again' : stage.cta} <ChevronRight size={15} />
          </a>
        ) : (
          // An unconfigured stage is a staff problem, not a client-facing error.
          // The visitor gets a plain "not yet"; the fix lives in the title so
          // whoever notices it internally knows where to go.
          <span
            title="Admin → Crash course → Sample project"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px',
              borderRadius: 8, background: '#F4F7F9', border: `1px solid ${BRAND.border}`,
              color: BRAND.muted, fontSize: 13, fontWeight: 600,
            }}
          >
            <Lock size={14} /> Coming shortly
          </span>
        )}
      </div>
    </div>
  );
}

function Overview({ config, progress, onReset, isProspect }) {
  // Built once per mount: the dates are relative to now, and recomputing them
  // on every render would let a milestone flip past "today" mid-session.
  const demoSchedule = useMemo(() => buildDemoSchedule(), []);
  const anyTried = progress.storyboard.tried || progress.video.tried;
  const readyStages = STAGES.filter((s) => s.ready(config));
  const bothTried = readyStages.length > 0 && readyStages.every((s) => progress[s.key].tried);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{
          fontSize: 11.5, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase',
          color: BRAND.blue, marginBottom: 6,
        }}>
          Sample project
        </div>
        {/* A paying client can reach this from their own project while they're
            waiting for a first draft, so the pitch has to know which of the two
            it's talking to. Telling someone who has already bought to "have a
            go before you're a client" reads as a mailing list they can't get
            off. */}
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: BRAND.ink, lineHeight: 1.25 }}>
          {isProspect ? "Have a go before you're a client." : 'Try it now, on a made-up job.'}
        </h1>
        <p style={{ margin: '10px 0 0', fontSize: 14.5, lineHeight: 1.65, color: BRAND.muted, maxWidth: 640 }}>
          {isProspect ? (
            <>
              This is the room your project would live in — the same review tools, the same buttons,
              the same team on the other end. Two moments put you in the driving seat. Both are
              yours to try right now, on a project we made up.
            </>
          ) : (
            <>
              Your own storyboard and cut aren't ready yet. This is the screen they'll arrive in,
              running on a project we made up — so when yours lands, none of it is new.
            </>
          )}
        </p>
      </div>

      {/* Where the two stages sit in the real thing. */}
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
        {JOURNEY.map((j, i) => {
          const isTry = JOURNEY_TRY.has(j);
          return (
            <React.Fragment key={j}>
              {i > 0 && <ChevronRight size={13} style={{ color: '#C3D3DC', flexShrink: 0 }} />}
              <span style={{
                padding: '5px 11px', borderRadius: 999, fontSize: 12, whiteSpace: 'nowrap',
                fontWeight: isTry ? 800 : 500,
                color: isTry ? BRAND.ink : BRAND.muted,
                background: isTry ? '#EAF6FB' : 'transparent',
                border: `1px solid ${isTry ? '#BFE0EE' : BRAND.border}`,
              }}>
                {j}
              </span>
            </React.Fragment>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 16 }}>
        {STAGES.map((s) => (
          <StageCard key={s.key} stage={s} config={config} progress={progress[s.key]} />
        ))}
      </div>

      {/* The same schedule component a real project gets, on made-up dates that
          straddle today. It's here because "when will I see something, and when
          do you need me?" is the question behind most of the chasing on a video
          project, and showing that we answer it up front does more work than
          another paragraph claiming we're organised. */}
      <div style={{ ...card, gap: 4 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: BRAND.ink }}>You'd know every date up front</div>
        <p style={{ margin: '0 0 14px', fontSize: 13.5, lineHeight: 1.6, color: BRAND.muted }}>
          Every project gets a schedule like this one, on your own project page. Not just when
          we deliver — <strong style={{ color: BRAND.ink }}>the dates we need you</strong>, marked
          out, so nothing waits on a question nobody asked.
        </p>
        <ProjectSchedule schedule={demoSchedule} title={null} compact />
      </div>

      {/* Says "sample" without shouting. Amber would read as a warning; this is
          an invitation, and the reassurance is what makes people click. */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'flex-start',
        padding: '13px 15px', borderRadius: 11,
        background: '#F3F9FC', border: '1px solid #CFE6F2',
        fontSize: 13.5, lineHeight: 1.6, color: '#41627A',
      }}>
        <Info size={16} style={{ flexShrink: 0, marginTop: 2, color: BRAND.blue }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ color: BRAND.ink }}>Everything here really works.</strong>{' '}
          Comment, reply, edit, delete, approve — none of it reaches anyone, and it all
          resets when you close the tab.
        </div>
        {anyTried && (
          <button
            onClick={onReset}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff', flexShrink: 0,
              border: `1px solid ${BRAND.border}`, borderRadius: 8, cursor: 'pointer',
              color: '#5A7382', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', padding: '6px 12px',
            }}
          >
            <RotateCcw size={13} /> Start over
          </button>
        )}
      </div>

      {/* The conversion moment: they've just done the thing, so ask while the
          feeling is fresh rather than leaving them on a finished tour. */}
      {bothTried && (
        <div style={{
          ...card, borderColor: '#9BE0B7', background: '#F6FDF9',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Sparkles size={20} style={{ color: '#15803D' }} />
            <strong style={{ fontSize: 17, color: BRAND.ink }}>That's the whole review loop.</strong>
          </div>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: BRAND.muted }}>
            {isProspect
              ? 'No chasing, no version confusion, no "which email had the feedback in it". Tell us what you\'re making and we\'ll scope it — the brief takes about ten minutes and you can save it half-finished.'
              : "That's exactly how yours will work when it's ready. Nothing else to do here — we'll email you the moment there's something real to look at."}
          </p>
          <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
            {isProspect ? (
              <>
                <a className="btn" href="#/brief" style={{ textDecoration: 'none' }}>Start a brief</a>
                <a className="btn-ghost" href="#/request" style={{ textDecoration: 'none' }}>Request a video</a>
              </>
            ) : (
              <a className="btn" href="#/" style={{ textDecoration: 'none' }}>Back to your projects</a>
            )}
          </div>
        </div>
      )}

      <div>
        <div style={{
          fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.4,
          color: BRAND.muted, margin: '0 0 10px',
        }}>
          On your real project
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12 }}>
          {[
            ['Your whole team, one thread', 'Invite colleagues and everyone comments in the same place. We see who said what, and so do you.'],
            ['We know the second you finalise', 'Hitting the green button notifies your producer directly — nothing waits in an inbox overnight.'],
            ['Every version stays put', 'Drafts never disappear. You can go back and compare at any point, months later.'],
            ['Finished files, forever', 'Signed-off videos land in your library in every format you need, downloadable any time.'],
          ].map(([title, body]) => (
            <div key={title} style={{ ...card, gap: 6, padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Clock size={15} style={{ color: BRAND.blue, flexShrink: 0 }} />
                <strong style={{ fontSize: 13.5, color: BRAND.ink }}>{title}</strong>
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.55, color: BRAND.muted }}>{body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Stage chrome ────────────────────────────────────────────────────────────

// The bar above both review surfaces: out, across, and start again. Switching
// stages from inside one is what makes the two feel like one tour rather than
// two demos that happen to share a URL.
function StageBar({ stage, config, onReset }) {
  const available = STAGES.filter((s) => s.ready(config));
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: '10px 16px', flexShrink: 0,
    }}>
      <button
        onClick={() => navigate('#/demo')}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none',
          border: 'none', color: BRAND.blue, cursor: 'pointer', fontSize: 13,
          fontWeight: 600, fontFamily: 'inherit', padding: 0,
        }}
      >
        <ArrowLeft size={14} /> Sample project
      </button>

      {/* A switcher with one option is furniture, not a control. */}
      <div style={{
        display: available.length > 1 ? 'flex' : 'none',
        gap: 4, background: '#EDF3F6', borderRadius: 9, padding: 3,
      }}>
        {available.map((s) => {
          const active = s.key === stage;
          return (
            <button
              key={s.key}
              onClick={() => navigate(`#/demo/${s.key}`)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px',
                borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 12.5, fontWeight: active ? 800 : 600,
                color: active ? BRAND.ink : '#5A7382',
                background: active ? '#fff' : 'transparent',
                boxShadow: active ? '0 1px 2px rgba(15,42,61,.12)' : 'none',
              }}
            >
              <s.Icon size={13} /> {s.label}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1 }} />
      <button
        onClick={onReset}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff',
          border: `1px solid ${BRAND.border}`, borderRadius: 8, cursor: 'pointer',
          color: '#5A7382', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
          padding: '6px 12px',
        }}
      >
        <RotateCcw size={13} /> Start over
      </button>
    </div>
  );
}

function StageHint({ children }) {
  return (
    <div style={{
      display: 'flex', gap: 9, alignItems: 'flex-start',
      margin: '0 16px 10px', padding: '10px 13px', borderRadius: 9,
      background: '#F3F9FC', border: '1px solid #CFE6F2',
      fontSize: 13, lineHeight: 1.55, color: '#41627A', flexShrink: 0,
    }}>
      <Info size={15} style={{ flexShrink: 0, marginTop: 2, color: BRAND.blue }} />
      <div>{children}</div>
    </div>
  );
}

// What happens after the green button — shown the moment they finalise.
//
// Up to here the tour has demonstrated our tools. This is the only screen that
// demonstrates our SERVICE, and it's the one that has to be true: by the time
// it renders, a notification really has gone to the team and one really has
// landed in their own bell. Saying "your producer has been told" while nothing
// happened would be the single worst thing this whole feature could do.
//
// Not dismissable by backdrop click — same rule as every other dialog here.
function WhatHappensNext({ stage, comments, nextStage, onClose }) {
  const what = stage === 'storyboard' ? 'storyboard' : 'video';
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,42,61,.55)' }} />
      <div style={{
        position: 'fixed', inset: 0, zIndex: 61, display: 'grid', placeItems: 'center',
        padding: 20, pointerEvents: 'none',
      }}>
        <div style={{
          pointerEvents: 'auto', width: '100%', maxWidth: 480, background: '#fff',
          borderRadius: 16, padding: '26px 26px 22px', boxShadow: '0 20px 60px rgba(15,42,61,.3)',
          maxHeight: '86vh', overflowY: 'auto', position: 'relative',
        }}>
          <button
            type="button" aria-label="Close" onClick={onClose}
            style={{
              position: 'absolute', top: 12, right: 12, background: 'none', border: 'none',
              padding: 8, cursor: 'pointer', color: BRAND.muted, display: 'flex',
            }}
          ><XIcon size={18} /></button>

          <div style={{
            width: 48, height: 48, borderRadius: 13, background: '#EDFBF2', color: '#15803D',
            display: 'grid', placeItems: 'center', marginBottom: 14,
          }}>
            <CheckCircle2 size={26} />
          </div>

          <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 800, color: BRAND.ink, lineHeight: 1.3 }}>
            {comments > 0
              ? `Your ${comments} note${comments === 1 ? '' : 's'} ${comments === 1 ? 'is' : 'are'} in.`
              : `${what === 'storyboard' ? 'Storyboard' : 'Video'} signed off.`}
          </h2>
          <p style={{ margin: '0 0 18px', fontSize: 13.5, lineHeight: 1.6, color: BRAND.muted }}>
            On a real project, that button is where we take over. Here's exactly what happens
            in the minutes after you press it.
          </p>

          <ol style={{ margin: '0 0 18px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 13 }}>
            {[
              ['Your producer knows immediately', 'Not when someone next opens an inbox — the alert goes straight to the person running your project.'],
              ['Every comment becomes a task', 'Each note lands on our production board and gets ticked off individually, so nothing is quietly skipped.'],
              ['The next draft answers all of them', 'It comes back to this same page, with the previous version still there to compare against.'],
            ].map(([title, body], i) => (
              <li key={title} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span style={{
                  width: 22, height: 22, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                  background: BRAND.blue, color: '#fff', display: 'grid', placeItems: 'center',
                  fontSize: 11, fontWeight: 800,
                }}>{i + 1}</span>
                <span>
                  <strong style={{ fontSize: 13.5, color: BRAND.ink }}>{title}</strong>
                  <span style={{ display: 'block', fontSize: 12.5, lineHeight: 1.55, color: BRAND.muted, marginTop: 2 }}>{body}</span>
                </span>
              </li>
            ))}
          </ol>

          {/* The proof, not a claim: there is a real unread notification sitting
              in their bell by the time they read this. */}
          <div style={{
            display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 13px',
            borderRadius: 10, background: '#F3F9FC', border: '1px solid #CFE6F2',
            fontSize: 12.5, lineHeight: 1.55, color: '#41627A', marginBottom: 18,
          }}>
            <Bell size={15} style={{ flexShrink: 0, marginTop: 1, color: BRAND.blue }} />
            <div>
              We've just put the matching notification in your bell, top right — that's the
              one you'd get for real.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
            {nextStage ? (
              <a
                className="btn" href={`#/demo/${nextStage.key}`} onClick={onClose}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, textDecoration: 'none' }}
              >
                Try the {nextStage.label.toLowerCase()} <ChevronRight size={15} />
              </a>
            ) : (
              <a className="btn" href="#/brief" onClick={onClose} style={{ textDecoration: 'none' }}>
                Start a brief
              </a>
            )}
            <button type="button" className="btn-ghost" onClick={onClose}>
              Keep looking around
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function NotSetUp({ what }) {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>
      The sample {what} hasn't been set up yet.<br />
      <span style={{ fontSize: 13 }}>Admin → Crash course → Sample project.</span>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function DemoProject({ stage = null }) {
  const { user, showToast, companyId, refreshNotifications, isProspect } = usePortal();
  const [config, setConfig] = useState(null);
  const [videoData, setVideoData] = useState(null);
  const [sbData, setSbData] = useState(null);
  const [celebrating, setCelebrating] = useState(null); // { stage, comments } | null
  // What we've already told the server about, this page load. The endpoint
  // de-duplicates properly (per person, per stage, forever); this just stops a
  // comment-per-keystroke's worth of chatter from one sitting.
  const reported = useRef(new Set());
  // Bumped by "start over": remounts the review surfaces (which hold their own
  // comment state) and re-reads progress for the overview ticks.
  const [nonce, setNonce] = useState(0);

  const identity = useMemo(
    () => (user?.email ? { name: user.name || null, email: user.email } : null),
    [user],
  );

  useEffect(() => {
    portalApi.get('demo-project')
      .then((d) => setConfig(d?.demo || {}))
      .catch(() => setConfig({}));
  }, []);

  const revApi = useMemo(() => {
    if (!config || stage !== 'video') return null;
    const built = createDemoRevApi({ config, identity, onChange: setVideoData });
    setVideoData(built.load());
    return built.api;
  }, [config, identity, stage, nonce]);

  const sbApi = useMemo(() => {
    if (!config || stage !== 'storyboard') return null;
    const built = createDemoSbApi({ config, identity, onChange: setSbData });
    setSbData(built.load());
    return built.api;
  }, [config, identity, stage, nonce]);

  const progress = useMemo(() => demoProgress(), [nonce, videoData, sbData, stage]);

  // Report what they actually did. Fire-and-forget in both directions: the tour
  // must not stall on a network call, and a prospect must never see an error
  // from telemetry they didn't ask for.
  const report = (event, forStage, comments) => {
    const mark = `${event}:${forStage}`;
    if (reported.current.has(mark)) return Promise.resolve();
    reported.current.add(mark);
    return portalApi.post('demo-event', { event, stage: forStage, comments, companyId })
      .catch(() => {});
  };

  // Finalising is the moment worth reacting to — and by the time the panel is
  // on screen the notification it promises has actually been written, which is
  // why the panel waits on the request rather than racing it.
  const finalisedAt = stage === 'storyboard'
    ? sbData?.storyboards?.[0]?.approvedAt || null
    : videoData?.videos?.[0]?.approvedAt || null;

  useEffect(() => {
    if (!stage || !finalisedAt) return;
    const mine = stage === 'storyboard' ? progress.storyboard.comments : progress.video.comments;
    const already = reported.current.has(`finalised:${stage}`);
    report('finalised', stage, mine).then(() => {
      // Pull the bell straight away rather than waiting up to 25s for the next
      // poll — the panel points at it, so it has to be there.
      refreshNotifications?.().catch(() => {});
    });
    if (!already) setCelebrating({ stage, comments: mine });
  }, [stage, finalisedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Their first comment in a stage, reported once. Weaker than a finalise, but
  // it's the difference between "opened the demo" and "used the demo", and it's
  // the row that makes the activity feed worth reading.
  const commentCount = stage === 'storyboard' ? progress.storyboard.comments : progress.video.comments;
  useEffect(() => {
    if (stage && commentCount > 0) report('commented', stage, commentCount);
  }, [stage, commentCount > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const startOver = () => {
    resetDemo();
    setNonce((n) => n + 1);
    reported.current = new Set();
    setCelebrating(null);
    showToast('Sample project reset');
  };

  if (!config) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>
        Loading the sample project…
      </div>
    );
  }

  // ── Overview (rendered inside the normal portal shell) ────────────────────
  if (stage !== 'storyboard' && stage !== 'video') {
    return <Overview config={config} progress={progress} onReset={startOver} isProspect={isProspect} />;
  }

  // ── A stage (full-bleed; see `fullBleed` in PortalApp) ────────────────────
  const surface = stage === 'storyboard'
    ? (!config.storyboardPdfUrl ? <NotSetUp what="storyboard" /> : !sbData ? null : (
      <StoryboardRevision
        key={nonce}
        token={DEMO_SB_TOKEN}
        data={sbData}
        api={sbApi}
        showMsg={showToast}
        identity={identity}
        embedded
      />
    ))
    : (!videoData?.videos?.[0]?.versions?.[0]?.videoUrl ? <NotSetUp what="video" /> : (
      <VideoRevision
        key={nonce}
        token={DEMO_TOKEN}
        data={videoData}
        api={revApi}
        showMsg={showToast}
        identity={identity}
        embedded
      />
    ));

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <StageBar stage={stage} config={config} onReset={startOver} />
      <StageHint>
        {stage === 'storyboard' ? (
          <>
            <strong style={{ color: BRAND.ink }}>This is a sample storyboard.</strong>{' '}
            Click anywhere on a slide to pin a note to that exact spot, switch between the two
            drafts, then finalise it. Nothing you do here reaches anyone.
          </>
        ) : (
          <>
            <strong style={{ color: BRAND.ink }}>This is a sample video review.</strong>{' '}
            Click the video to leave a comment at that exact second, reply to one, switch between
            versions, approve it. Nothing you do here reaches anyone.
          </>
        )}
      </StageHint>
      {surface === null ? (
        <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>
          Loading the sample project…
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, background: BRAND.paper, color: BRAND.ink }}>
          {surface}
        </div>
      )}
      {celebrating && (
        <WhatHappensNext
          stage={celebrating.stage}
          comments={celebrating.comments}
          // Only offer the other stage if it's configured AND they haven't
          // done it — "try the thing you just did" is a worse ask than the brief.
          nextStage={STAGES.find((s) => s.key !== celebrating.stage
            && s.ready(config) && !progress[s.key].tried) || null}
          onClose={() => setCelebrating(null)}
        />
      )}
    </div>
  );
}
