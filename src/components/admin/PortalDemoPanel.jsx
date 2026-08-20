// Admin → Testing: the portal, live, in whatever state you want to look at.
//
// Seeing what a client sees used to mean seeding a demo company, a demo deal
// and a demo portal invite into the live database — which put a fake customer
// in the pipeline, in Finance and in the activity feed, and could only ever be
// in ONE state at a time. To look at the "your storyboard is ready" screen you
// dragged the fake project into that stage, looked, then dragged it back.
//
// This is the same portal, answering from fixtures instead of the network (see
// src/portal/demo/portalDemo.js). Nothing is seeded, nothing is written, and
// the state is a radio button: switching from "prospect" to "delivered" is a
// reload, not a migration. The seeded demo below it still exists, because a
// fixture can't test a flow that genuinely has to write — real invites, real
// uploads, a real payment gate.
import React, { useMemo, useState } from 'react';
import { MonitorPlay, ExternalLink, RefreshCw, Smartphone, Monitor } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { DEMO_STATES, DEFAULT_DEMO_STATE } from '../../portal/demo/portalDemo.js';

// Where in the portal to land. The states are about the client's situation;
// this is about which screen of theirs you want to look at.
const PAGES = [
  { hash: '#/', label: 'Dashboard' },
  { hash: '#/brief', label: 'Brief builder' },
  { hash: '#/project/demo-deal', label: 'Project' },
  { hash: '#/extras', label: 'Extras' },
  { hash: '#/library', label: 'Library' },
  { hash: '#/documents', label: 'Documents' },
  { hash: '#/team', label: 'Your team' },
];

// Phone width is not a nicety here: the portal is an installable PWA and a fair
// share of clients only ever open it on a phone, so "what does the client see"
// has two answers and both need to be one click away.
const WIDTHS = { desktop: '100%', mobile: '390px' };

export function PortalDemoPanel() {
  const [state, setState] = useState(DEFAULT_DEMO_STATE);
  const [page, setPage] = useState(PAGES[0].hash);
  const [device, setDevice] = useState('desktop');
  // Bumped to force the iframe to remount, which is how a state change takes
  // effect — the demo state is read once, before React mounts, exactly like the
  // preview token is.
  const [nonce, setNonce] = useState(0);

  const url = useMemo(
    () => `/portal?demo=${encodeURIComponent(state)}&r=${nonce}${page}`,
    [state, page, nonce]
  );
  const meta = DEMO_STATES.find((s) => s.id === state);

  const pill = (on) => ({
    padding: '5px 12px', borderRadius: 999, cursor: 'pointer', fontSize: 12.5,
    fontFamily: 'inherit', fontWeight: on ? 700 : 500,
    border: `1px solid ${on ? BRAND.blue : BRAND.border}`,
    background: on ? '#EAF7FD' : '#fff', color: on ? BRAND.ink : BRAND.muted,
  });

  return (
    <div style={{ marginBottom: 34 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <MonitorPlay size={20} color={BRAND.blue} /> Portal demo
      </h2>
      <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 14px', lineHeight: 1.5, maxWidth: 720 }}>
        The real client portal, filled with invented data. Change the client&rsquo;s situation below and the
        whole portal changes with it — no demo client to seed, nothing written to the database, and no fake
        company turning up in your pipeline or your figures.
      </p>

      {/* ── the client's situation ─────────────────────────────────────── */}
      <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 7 }}>
        Client state
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {DEMO_STATES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => { setState(s.id); setNonce((n) => n + 1); }}
            style={pill(s.id === state)}
          >{s.label}</button>
        ))}
      </div>
      {meta && (
        <p style={{ fontSize: 12.5, color: BRAND.muted, margin: '0 0 16px', lineHeight: 1.5, maxWidth: 720 }}>
          {meta.blurb}
        </p>
      )}

      {/* ── which screen ───────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {PAGES.map((p) => (
          <button key={p.hash} type="button" onClick={() => setPage(p.hash)} style={pill(p.hash === page)}>
            {p.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            type="button" onClick={() => setDevice('desktop')} style={pill(device === 'desktop')}
            title="Desktop width"
          ><Monitor size={13} /></button>
          <button
            type="button" onClick={() => setDevice('mobile')} style={pill(device === 'mobile')}
            title="Phone width — the portal is an installable PWA"
          ><Smartphone size={13} /></button>
          <button
            type="button" onClick={() => setNonce((n) => n + 1)} style={pill(false)} title="Reload the demo"
          ><RefreshCw size={13} /></button>
          <a
            className="btn-ghost" href={url} target="_blank" rel="noreferrer"
            style={{ fontSize: 12.5, textDecoration: 'none' }}
            title="Open the demo portal in its own tab"
          ><ExternalLink size={13} /> Open</a>
        </span>
      </div>

      <div style={{
        border: '1px solid ' + BRAND.border, borderRadius: 12, overflow: 'hidden',
        background: BRAND.paper, display: 'flex', justifyContent: 'center',
      }}>
        <iframe
          key={url}
          src={url}
          title="Portal demo"
          style={{
            width: WIDTHS[device], maxWidth: '100%', height: 720, border: 'none',
            background: '#fff', display: 'block',
          }}
        />
      </div>
    </div>
  );
}
