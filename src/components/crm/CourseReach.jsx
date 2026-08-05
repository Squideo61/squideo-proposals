// Marketing → Course, the public half: who lands on the page, how many press
// play without ever giving us an email, and how far through each video people
// actually get.
//
// The anonymous numbers are the commercially interesting ones. Everyone in the
// signups table below already converted; the people counted here are the ones
// who didn't, and they are invisible everywhere else in the CRM.
//
// A visitor is a BROWSER, not a person — two devices are two visitors, and
// clearing site data starts a new one. So these compare videos against each
// other honestly, but they aren't a headcount, and the page says so.

import React, { useState } from 'react';
import { Eye, Play, UserPlus, PenLine, ChevronDown, ChevronRight } from 'lucide-react';
import { BRAND } from '../../theme.js';

const pct = (n, of) => (of > 0 ? Math.round((n / of) * 100) : 0);

// A step in the public funnel. `of` is the previous step, so the percentage
// answers "what share carried on from here" rather than "share of everything",
// which is the number that tells you which step to fix.
function Step({ Icon, label, value, of, hint, first }) {
  return (
    <div style={{
      flex: '1 1 150px', minWidth: 0, background: 'white',
      border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
        <Icon size={14} color={BRAND.blue} />
        <span style={{ fontSize: 11.5, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {label}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 24, fontWeight: 800, color: BRAND.ink, lineHeight: 1 }}>{value}</span>
        {!first && of > 0 && (
          <span style={{ fontSize: 12, fontWeight: 700, color: pct(value, of) >= 50 ? '#15803D' : BRAND.muted }}>
            {pct(value, of)}%
          </span>
        )}
      </div>
      {hint && <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 4, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}

// The drop-off curve for one video. Quarter marks rather than a single
// "completed" number: half the people leaving at 10 seconds and half leaving at
// 40 look identical on a completion rate, and they call for opposite fixes.
function WatchBar({ marks, base }) {
  const stops = [
    { label: 'Started', n: base },
    { label: '25%', n: marks.q1 },
    { label: 'Half', n: marks.q2 },
    { label: '75%', n: marks.q3 },
    { label: 'Finished', n: marks.done },
  ];
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 46 }}>
      {stops.map((s) => {
        const h = base > 0 ? Math.max(3, (s.n / base) * 40) : 3;
        const share = pct(s.n, base);
        return (
          <div key={s.label} style={{ flex: 1, textAlign: 'center' }} title={`${s.label}: ${s.n} (${share}%)`}>
            <div style={{
              height: h, borderRadius: '3px 3px 0 0',
              background: share >= 60 ? '#16A34A' : share >= 30 ? BRAND.blue : '#CBD5E1',
            }} />
            <div style={{ fontSize: 9.5, color: BRAND.muted, marginTop: 3 }}>{share}%</div>
          </div>
        );
      })}
    </div>
  );
}

export function CourseReach({ reach, isMobile }) {
  const [open, setOpen] = useState(true);
  if (!reach) return null;

  const f = reach.funnel || {};
  const videos = reach.videos || [];
  const anyAnon = videos.some((v) => v.anon.plays > 0) || f.visitors > 0;

  return (
    <section style={{ marginBottom: 26 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: BRAND.ink }}>
          Reach and watch rate
        </h3>
        <span style={{ fontSize: 11.5, color: BRAND.muted }}>
          the public page, including everyone who never signed up
        </span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <Step first Icon={Eye} label="Landed" value={f.visitors || 0}
          hint={`${f.pageViews || 0} page views`} />
        <Step Icon={Play} label="Pressed play" value={f.played || 0} of={f.visitors || 0}
          hint="Watched without being asked for anything" />
        <Step Icon={PenLine} label="Reached the form" value={f.reachedSignup || 0} of={f.played || 0}
          hint="Scrolled to or clicked through to signup" />
        <Step Icon={UserPlus} label="Signed up" value={f.signedUp || 0} of={f.reachedSignup || 0}
          hint="Gave us an email address" />
      </div>

      {!anyAnon && (
        <div style={{
          fontSize: 12.5, color: '#B45309', background: '#FFF8EB',
          border: '1px solid #F5C26B', borderRadius: 8, padding: '9px 12px', marginBottom: 10,
        }}>
          No public visits recorded yet in this period. The page only reports once it has
          traffic — which needs the link adding to squideo.com.
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost"
        style={{ fontSize: 12.5, marginBottom: 8 }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Per video ({videos.length})
      </button>

      {open && (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,2.2fr) minmax(0,1.6fr) minmax(0,1.4fr)',
            gap: 12, padding: '9px 14px', background: '#F8FAFB',
            borderBottom: '1px solid ' + BRAND.border,
            fontSize: 11, fontWeight: 700, color: BRAND.muted,
            textTransform: 'uppercase', letterSpacing: 0.4,
          }}>
            <div>Video</div>
            {!isMobile && <div>Anonymous drop-off</div>}
            {!isMobile && <div>Signed in</div>}
          </div>
          {videos.map((v) => (
            <div key={v.id} style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,2.2fr) minmax(0,1.6fr) minmax(0,1.4fr)',
              gap: 12, padding: '12px 14px', borderBottom: '1px solid ' + BRAND.border,
              alignItems: 'center',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                  <span style={{ color: BRAND.muted, fontSize: 11.5 }}>{v.number}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.title}</span>
                  {v.free && (
                    <span style={{ fontSize: 9.5, fontWeight: 800, color: '#15803D', background: '#DCFCE7', padding: '1px 6px', borderRadius: 4, letterSpacing: 0.3 }}>
                      FREE
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 2 }}>
                  {v.anon.plays} anonymous {v.anon.plays === 1 ? 'play' : 'plays'}
                  {v.member.starts > 0 && ` · ${v.member.starts} signed in`}
                </div>
              </div>

              <div>
                {v.anon.plays > 0 ? (
                  <WatchBar marks={v.anon} base={v.anon.plays} />
                ) : (
                  <div style={{ fontSize: 11.5, color: BRAND.muted, fontStyle: 'italic' }}>
                    {v.free ? 'No public plays yet' : 'Gated — signed-in only'}
                  </div>
                )}
              </div>

              <div style={{ fontSize: 12.5, color: BRAND.ink }}>
                {v.member.starts > 0 ? (
                  <>
                    <div>
                      <strong>{v.member.done}</strong> of {v.member.starts} finished
                      {' '}<span style={{ color: BRAND.muted }}>({pct(v.member.done, v.member.starts)}%)</span>
                    </div>
                    {v.member.avgPct != null && (
                      <div style={{ color: BRAND.muted, fontSize: 11.5, marginTop: 2 }}>
                        Average {v.member.avgPct}% watched
                      </div>
                    )}
                  </>
                ) : (
                  <span style={{ color: BRAND.muted, fontStyle: 'italic', fontSize: 11.5 }}>Nobody yet</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 8, lineHeight: 1.5 }}>
        Anonymous figures count browsers, not people — two devices are two visitors, and
        clearing site data starts a new one. Good for comparing videos against each other;
        not a headcount. Signed-in figures come from the portal player and are exact.
      </div>
    </section>
  );
}
