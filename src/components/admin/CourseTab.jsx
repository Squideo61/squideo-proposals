// Admin → Crash course. Manage the 8 videos of The Explainer Video Crash
// Course: upload each one, pick its thumbnail, write the copy, and publish.
//
// NAMING: the schema and the code say "module" (course_modules, moduleNumber);
// everything a human reads says "video". They're the same thing — "module" is
// e-learning jargon nobody at Squideo uses, and there are simply eight videos.
// The split is deliberate rather than a half-finished rename: the table already
// exists in production, so renaming it would cost a migration to fix wording.
//
// The landing page only ever shows PUBLISHED videos, which is what lets the
// course go live with video 1 while the rest are still uploading. Exactly one
// video is marked FREE — that's the one anonymous visitors can watch, and the
// whole conversion strategy rests on it playing before anyone is asked for an
// email address.
//
// Uploads go browser-direct to Blob storage (these are hundreds of megabytes;
// the serverless body limit is 4.5MB) using the same pattern as the portal
// library and the CRM's revision drafts.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  GraduationCap, Plus, Upload, Trash2, Eye, EyeOff, Image as ImageIcon,
  Loader2, PlayCircle, Unlock, Lock, ArrowUp, ArrowDown, ExternalLink, Mail,
} from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { useStore } from '../../store.jsx';
import { PosterPicker } from '../media/PosterPicker.jsx';

const BASE = '/api/crm/course';

// Same-origin relay, so PosterPicker's canvas capture isn't tainted. The `v`
// buster makes a replaced video reload instead of serving the cached old one.
const streamSrc = (m) => `${BASE}/${encodeURIComponent(m.id)}/video?v=${m.sizeBytes || 0}`;

const fmtDuration = (s) => {
  if (!s) return '—';
  const mins = Math.floor(s / 60);
  const secs = Math.round(s % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
};

const fmtMB = (b) => (b ? `${(b / 1024 / 1024).toFixed(0)} MB` : '—');

export function CourseTab() {
  const { showMsg } = useStore();
  const [modules, setModules] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      setModules(await api.get(BASE));
    } catch (err) {
      showMsg(err.message, 'error');
      setModules([]);
    }
  }, [showMsg]);

  useEffect(() => { load(); }, [load]);

  const patch = async (id, body) => {
    setBusyId(id);
    try {
      await api.patch(`${BASE}/${encodeURIComponent(id)}`, body);
      await load();
    } catch (err) {
      showMsg(err.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (m) => {
    if (!window.confirm(`Delete “${m.title}”? The video file is deleted too — this can't be undone.`)) return;
    setBusyId(m.id);
    try {
      await api.delete(`${BASE}/${encodeURIComponent(m.id)}`);
      await load();
      showMsg('Video deleted');
    } catch (err) {
      showMsg(err.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  // Reorder by swapping module_number with the neighbour — the list is eight
  // items long, so a drag-and-drop library would be all cost and no benefit.
  const move = async (index, delta) => {
    const a = modules[index];
    const b = modules[index + delta];
    if (!a || !b) return;
    setBusyId(a.id);
    try {
      await api.patch(`${BASE}/${encodeURIComponent(a.id)}`, { moduleNumber: b.moduleNumber, sortOrder: b.moduleNumber });
      await api.patch(`${BASE}/${encodeURIComponent(b.id)}`, { moduleNumber: a.moduleNumber, sortOrder: a.moduleNumber });
      await load();
    } catch (err) {
      showMsg(err.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (modules === null) {
    return <div style={{ padding: 24, color: BRAND.muted, fontSize: 13 }}>Loading the course…</div>;
  }

  const live = modules.filter((m) => m.published);
  const published = live.length;
  const freeLive = live.filter((m) => m.free);
  const secs = (list) => list.reduce((n, m) => n + (m.durationSeconds || 0), 0);
  const totalSeconds = secs(live);
  const freeSeconds = secs(freeLive);

  return (
    <div style={{ maxWidth: 900 }}>
      <header style={{ marginBottom: 18 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 9 }}>
          <GraduationCap size={19} color={BRAND.blue} /> The Explainer Video Planning Crash Course
        </h2>
        <p style={{ margin: 0, fontSize: 12.5, color: BRAND.muted, lineHeight: 1.5 }}>
          Public page: <a href="/course" target="_blank" rel="noreferrer" style={{ color: BRAND.blue }}>
            app.squideo.com/course <ExternalLink size={11} style={{ verticalAlign: -1 }} />
          </a>
          {' · '}{published} of {modules.length} published{published > 0 && ` · ${fmtDuration(totalSeconds)} total`}
        </p>
      </header>

      {published > 0 && (
        <Notice tone={freeLive.length ? 'info' : 'warn'}>
          {freeLive.length ? (
            <>
              <strong>{freeLive.length} of {published} free</strong> — anonymous visitors can watch{' '}
              {fmtDuration(freeSeconds)} of {fmtDuration(totalSeconds)} before they’re asked to sign up.
              {freeSeconds / totalSeconds > 0.75 && ' Almost the whole course is free; there may be little left to sign up for.'}
            </>
          ) : (
            <>
              No video is marked <strong>free</strong>. Anonymous visitors will see the grid but have
              nothing to watch — and the whole point of the page is that they see the quality before
              they’re asked for an email address. Tick <strong>Make free</strong> on video 1.
            </>
          )}
        </Notice>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {modules.map((m, i) => (
          <ModuleRow
            key={m.id}
            module={m}
            busy={busyId === m.id}
            isFirst={i === 0}
            isLast={i === modules.length - 1}
            onMove={(delta) => move(i, delta)}
            onPatch={(body) => patch(m.id, body)}
            onDelete={() => remove(m)}
            onReload={load}
            onError={(msg) => showMsg(msg, 'error')}
            onDone={(msg) => showMsg(msg)}
          />
        ))}
      </div>

      {modules.length === 0 && (
        <div style={{ padding: 28, textAlign: 'center', color: BRAND.muted, fontSize: 13, border: '1px dashed ' + BRAND.border, borderRadius: 10 }}>
          No videos yet. Add the first one below.
        </div>
      )}

      {creating ? (
        <NewModule onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} onError={(msg) => showMsg(msg, 'error')} />
      ) : (
        <button className="btn-ghost" onClick={() => setCreating(true)} style={{ marginTop: 14 }}>
          <Plus size={14} /> Add a video
        </button>
      )}

      <SampleProject />
      <PartnerVideo />
      <NudgeEmails />
    </div>
  );
}

// The sample project's files. The demo itself is a fixture in the portal
// bundle; the only thing that lives in the database is these URLs, so Ben's
// explainer can be re-recorded and the sample storyboard swapped without a
// deploy. Each stage of the tour appears only once its file exists, so the
// storyboard half can go live before the video half or the other way round.
//
// Uploads go to the SAME public blob store as the course videos (the CSP
// already allows media from it) via the course upload-token endpoint, so
// there's no second token route to keep in step.
// One upload slot: the status strip plus its upload / replace / remove buttons.
// Three of these now (the video and two storyboard drafts), which is exactly
// when copy-pasting the same 40 lines a third time stops being acceptable.
function AssetSlot({ url, accept, contentType, label, liveText, emptyText, optional, onUploaded, onRemove, showMsg }) {
  const fileRef = useRef(null);
  const [pct, setPct] = useState(null);
  const [busy, setBusy] = useState(false);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setPct(0);
    try {
      const { upload } = await import('@vercel/blob/client');
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = await upload(`course/sample-project/${Date.now()}-${safeName}`, file, {
        access: 'public',
        handleUploadUrl: `${BASE}/upload-token`,
        contentType: file.type || contentType,
        multipart: true,
        onUploadProgress: (ev) => setPct(Math.round(ev.percentage)),
      });
      await onUploaded(blob.url);
    } catch (err) {
      showMsg(err.message || 'Upload failed', 'error');
    } finally {
      setBusy(false);
      setPct(null);
    }
  };

  // An optional slot that's empty is neutral, not a warning — the tour works
  // without it, so amber would be crying wolf.
  const tone = url ? 'live' : optional ? 'neutral' : 'missing';
  const colours = {
    live: { bg: '#EDFBF2', border: '#9BE0B7', text: '#15803D' },
    missing: { bg: '#FFF8EB', border: '#F5C26B', text: '#B45309' },
    neutral: { bg: '#F6F9FB', border: BRAND.border, text: BRAND.muted },
  }[tone];

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', marginBottom: 10,
      borderRadius: 10, background: colours.bg, border: '1px solid ' + colours.border,
    }}>
      <div style={{ flex: 1, fontSize: 13, lineHeight: 1.5, color: colours.text }}>
        <strong>{label}</strong>{' — '}{url ? liveText : emptyText}
      </div>
      {busy ? (
        <span style={{ fontSize: 12.5, color: BRAND.muted, flexShrink: 0 }}>
          <Loader2 size={13} className="spin" /> {pct != null ? `${pct}%` : 'Uploading…'}
        </span>
      ) : (
        <>
          {url && (
            <>
              <a
                href={url} target="_blank" rel="noreferrer"
                style={{ fontSize: 12.5, color: BRAND.blue, textDecoration: 'none', fontWeight: 600, flexShrink: 0 }}
              >
                View
              </a>
              <button className="btn-ghost" onClick={onRemove} style={{ fontSize: 12.5, flexShrink: 0 }}>
                <Trash2 size={13} /> Remove
              </button>
            </>
          )}
          <button className="btn" onClick={() => fileRef.current?.click()} style={{ fontSize: 12.5, flexShrink: 0 }}>
            <Upload size={13} /> {url ? 'Replace' : 'Upload'}
          </button>
        </>
      )}
      <input ref={fileRef} type="file" accept={accept} hidden onChange={pick} />
    </div>
  );
}

function SampleProject() {
  const { state, actions, showMsg } = useStore();
  const cfg = state.demoProject || {};

  const saveField = async (key, value) => {
    const next = { ...cfg, [key]: value || null };
    if (JSON.stringify(next) === JSON.stringify(cfg)) return;
    try { await actions.saveDemoProject(next); }
    catch (err) { showMsg(err.message, 'error'); }
  };

  const setAsset = (key, msg) => async (url) => {
    try {
      await actions.saveDemoProject({ ...cfg, [key]: url });
      showMsg(msg);
    } catch (err) { showMsg(err.message, 'error'); }
  };

  return (
    <section style={{ marginTop: 34, borderTop: '1px solid ' + BRAND.border, paddingTop: 22 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15.5, fontWeight: 700, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 8 }}>
        <PlayCircle size={16} color={BRAND.blue} /> Sample project
      </h3>
      <p style={{ margin: '0 0 14px', fontSize: 12.5, color: BRAND.muted, lineHeight: 1.55 }}>
        The guided tour at <code>/portal#/demo</code>. Prospects drive the two review
        surfaces for real — pinning notes to storyboard slides, leaving timestamped
        comments on the cut, switching drafts, approving. Each stage switches itself on
        as soon as its file is uploaded. Nothing they do is saved anywhere, and it
        resets when they close the tab.
      </p>

      <div style={{ fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.4, color: BRAND.muted, margin: '0 0 8px' }}>
        Stage 1 · Storyboard sign-off
      </div>
      <AssetSlot
        url={cfg.storyboardPdfUrl}
        accept="application/pdf"
        contentType="application/pdf"
        label={cfg.storyboardPdfUrl ? 'Live' : 'Not set up'}
        liveText="the storyboard stage is running on this PDF."
        emptyText="the storyboard stage is hidden. Upload a storyboard PDF (two or more slides) to switch it on."
        onUploaded={setAsset('storyboardPdfUrl', 'Sample storyboard updated')}
        showMsg={showMsg}
        onRemove={() => setAsset('storyboardPdfUrl', 'Sample storyboard removed — that stage is hidden again')(null)}
      />
      <AssetSlot
        url={cfg.storyboardPdfUrlV1}
        accept="application/pdf"
        contentType="application/pdf"
        optional
        label="Earlier draft (optional)"
        liveText='"First draft" in the draft switcher shows this file.'
        emptyText="both drafts show the same PDF. Upload an earlier version to make the switcher show a real change."
        onUploaded={setAsset('storyboardPdfUrlV1', 'Earlier draft updated')}
        showMsg={showMsg}
        onRemove={() => setAsset('storyboardPdfUrlV1', 'Earlier draft removed')(null)}
      />

      <div style={{ fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.4, color: BRAND.muted, margin: '16px 0 8px' }}>
        Stage 2 · Video review
      </div>
      <AssetSlot
        url={cfg.videoUrl}
        accept="video/*"
        contentType="video/mp4"
        label={cfg.videoUrl ? 'Live' : 'Not set up'}
        liveText="the video stage is playing this file."
        emptyText="the video stage is hidden. Upload Ben's explainer to switch it on."
        onUploaded={setAsset('videoUrl', 'Sample project video updated')}
        showMsg={showMsg}
        onRemove={() => setAsset('videoUrl', "Sample video removed — that stage is hidden again")(null)}
      />

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
        <label style={{ flex: '1 1 200px', fontSize: 12.5, color: BRAND.muted }}>
          Project name (what the tour is called)
          <input
            className="input" defaultValue={cfg.title || ''}
            placeholder="Sample project — how this works"
            onBlur={(e) => saveField('title', e.target.value.trim())}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
        <label style={{ flex: '1 1 200px', fontSize: 12.5, color: BRAND.muted }}>
          Storyboard name (shown in the header)
          <input
            className="input" defaultValue={cfg.storyboardTitle || ''}
            placeholder="Explainer — storyboard"
            onBlur={(e) => saveField('storyboardTitle', e.target.value.trim())}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
        <label style={{ flex: '1 1 200px', fontSize: 12.5, color: BRAND.muted }}>
          Video name (shown above the player)
          <input
            className="input" defaultValue={cfg.videoTitle || ''}
            placeholder="Welcome to your portal"
            onBlur={(e) => saveField('videoTitle', e.target.value.trim())}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
      </div>

      {(cfg.videoUrl || cfg.storyboardPdfUrl) && (
        <a
          href="/portal#/demo" target="_blank" rel="noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 12.5, color: BRAND.blue, textDecoration: 'none', fontWeight: 600 }}
        >
          <ExternalLink size={13} /> Take the tour yourself
        </a>
      )}
    </section>
  );
}

// The video on the portal's Partner Programme page (/portal#/partner).
//
// A URL rather than an upload-only panel, because the film already exists on
// Vimeo for squideo.com — re-uploading it here would leave two copies to keep
// in step. Uploading is still offered for anything that isn't hosted yet.
function PartnerVideo() {
  const { state, actions, showMsg } = useStore();
  const cfg = state.partnerVideo || {};
  const fileRef = useRef(null);
  const [pct, setPct] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async (next, msg) => {
    try {
      await actions.savePartnerVideo(next);
      if (msg) showMsg(msg);
    } catch (err) { showMsg(err.message, 'error'); }
  };

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setPct(0);
    try {
      const { upload } = await import('@vercel/blob/client');
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = await upload(`course/partner/${Date.now()}-${safeName}`, file, {
        access: 'public',
        handleUploadUrl: `${BASE}/upload-token`,
        contentType: file.type || 'video/mp4',
        multipart: true,
        onUploadProgress: (ev) => setPct(Math.round(ev.percentage)),
      });
      await save({ ...cfg, url: blob.url }, 'Partner Programme video updated');
    } catch (err) {
      showMsg(err.message || 'Upload failed', 'error');
    } finally {
      setBusy(false);
      setPct(null);
    }
  };

  const live = !!cfg.url;
  return (
    <section style={{ marginTop: 34, borderTop: '1px solid ' + BRAND.border, paddingTop: 22 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15.5, fontWeight: 700, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 8 }}>
        <PlayCircle size={16} color={BRAND.blue} /> Partner Programme video
      </h3>
      <p style={{ margin: '0 0 14px', fontSize: 12.5, color: BRAND.muted, lineHeight: 1.55 }}>
        Plays at the top of <code>/portal#/partner</code>, where clients read about the
        programme and book a call. Paste the Vimeo, YouTube or Loom link you already use on
        squideo.com — or upload a file if it isn't hosted anywhere yet.
      </p>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', marginBottom: 14,
        borderRadius: 10,
        background: live ? '#EDFBF2' : '#FFF8EB',
        border: '1px solid ' + (live ? '#9BE0B7' : '#F5C26B'),
      }}>
        <div style={{ flex: 1, fontSize: 13, lineHeight: 1.5, color: live ? '#15803D' : '#B45309' }}>
          <strong>{live ? 'Live' : 'Not set'}</strong>
          {' — '}
          {live
            ? 'clients see this video above the programme details.'
            : 'the page reads fine without it, but nobody hears Ben explain it.'}
        </div>
        {busy ? (
          <span style={{ fontSize: 12.5, color: BRAND.muted, flexShrink: 0 }}>
            <Loader2 size={13} className="spin" /> {pct != null ? `${pct}%` : 'Uploading…'}
          </span>
        ) : (
          <>
            {live && (
              <button className="btn-ghost" onClick={() => save({ ...cfg, url: null }, 'Video removed from the Partner Programme page')} style={{ fontSize: 12.5, flexShrink: 0 }}>
                <Trash2 size={13} /> Remove
              </button>
            )}
            <button className="btn-ghost" onClick={() => fileRef.current?.click()} style={{ fontSize: 12.5, flexShrink: 0 }}>
              <Upload size={13} /> Upload a file
            </button>
          </>
        )}
        <input ref={fileRef} type="file" accept="video/*" hidden onChange={pick} />
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ flex: '2 1 300px', fontSize: 12.5, color: BRAND.muted }}>
          Video link (Vimeo, YouTube or Loom)
          <input
            className="input" defaultValue={cfg.url || ''}
            placeholder="https://vimeo.com/625502459"
            onBlur={(e) => {
              const url = e.target.value.trim() || null;
              if (url !== (cfg.url || null)) save({ ...cfg, url }, url ? 'Partner Programme video updated' : 'Video removed');
            }}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
        <label style={{ flex: '1 1 200px', fontSize: 12.5, color: BRAND.muted }}>
          Caption (optional)
          <input
            className="input" defaultValue={cfg.title || ''}
            placeholder="Ben explains the Partner Programme"
            onBlur={(e) => {
              const title = e.target.value.trim() || null;
              if (title !== (cfg.title || null)) save({ ...cfg, title });
            }}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
      </div>

      {live && (
        <a
          href="/portal#/partner" target="_blank" rel="noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 12.5, color: BRAND.blue, textDecoration: 'none', fontWeight: 600 }}
        >
          <ExternalLink size={13} /> See the page
        </a>
      )}
    </section>
  );
}

// The follow-up sequence. Deliberately a single on/off switch rather than a
// copy editor: the emails are behaviour-aware (they name the video someone
// stopped at, and cancel themselves when a person finishes or gets in touch),
// so free-text editing would break more than it enabled. Copy changes go
// through api/_lib/course/emails.js.
const STEPS = [
  { day: 2,  name: 'Nudge 1', what: 'Names the video they stopped at, or that they haven\'t started.' },
  { day: 5,  name: 'Nudge 2', what: 'The storyboard video — the expensive mistake.' },
  { day: 9,  name: 'Nudge 3', what: 'Distribution. "Nobody plans it."' },
  { day: 14, name: 'Offer 1', what: 'Offers to sanity-check their brief.', consent: true },
  { day: 25, name: 'Offer 2', what: 'Asks if they want a price. Last one.', consent: true },
];

function NudgeEmails() {
  const { state, actions, showMsg } = useStore();
  const enabled = state.courseEmails?.enabled === true;
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    try {
      await actions.saveCourseEmails({ ...(state.courseEmails || {}), enabled: !enabled });
      showMsg(enabled ? 'Follow-up emails paused' : 'Follow-up emails switched on');
    } catch (err) {
      showMsg(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{ marginTop: 34, borderTop: '1px solid ' + BRAND.border, paddingTop: 22 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15.5, fontWeight: 700, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Mail size={16} color={BRAND.blue} /> Follow-up emails
      </h3>
      <p style={{ margin: '0 0 14px', fontSize: 12.5, color: BRAND.muted, lineHeight: 1.55 }}>
        Five emails over 25 days, to people who signed up but haven't finished. Each one
        re-checks before it sends: anyone who finishes the course, sends an enquiry or
        unsubscribes drops out of the rest of the sequence automatically.
      </p>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', marginBottom: 14,
        borderRadius: 10, background: enabled ? '#EDFBF2' : '#FFF8EB',
        border: '1px solid ' + (enabled ? '#9BE0B7' : '#F5C26B'),
      }}>
        <div style={{ flex: 1, fontSize: 13, color: enabled ? '#15803D' : '#B45309', lineHeight: 1.5 }}>
          <strong>{enabled ? 'Sending' : 'Paused'}</strong>
          {' — '}
          {enabled
            ? 'the daily job is sending these to eligible signups.'
            : 'nothing is being sent. Signups are still queued, so switching on picks them up.'}
        </div>
        <button className={enabled ? 'btn-ghost' : 'btn'} onClick={toggle} disabled={busy} style={{ fontSize: 12.5, flexShrink: 0 }}>
          {busy ? 'Saving…' : enabled ? 'Pause' : 'Switch on'}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {STEPS.map((s) => (
          <div key={s.name} style={{ display: 'flex', gap: 10, fontSize: 12.5, alignItems: 'baseline' }}>
            <span style={{ width: 52, flexShrink: 0, color: BRAND.muted, fontWeight: 700 }}>Day {s.day}</span>
            <span style={{ width: 62, flexShrink: 0, fontWeight: 600, color: BRAND.ink }}>{s.name}</span>
            <span style={{ flex: 1, color: BRAND.muted, lineHeight: 1.5 }}>
              {s.what}
              {s.consent && (
                <span style={{ color: '#B45309', fontWeight: 600 }}> · only to people who ticked the marketing box</span>
              )}
            </span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14, fontSize: 11.5, color: BRAND.muted, lineHeight: 1.55 }}>
        Every email carries a one-click unsubscribe. Unsubscribing stops <em>all</em> Squideo
        marketing, not just this sequence — invoices, review requests and project updates keep
        working, because those aren't marketing.
      </div>
    </section>
  );
}

function Notice({ tone, children }) {
  const tint = tone === 'warn' ? { bg: '#FFF8EB', border: '#F5C26B', ink: '#B45309' } : { bg: '#EAF7FC', border: '#A9E1F5', ink: '#0B6E93' };
  return (
    <div style={{
      background: tint.bg, border: `1px solid ${tint.border}`, color: tint.ink,
      borderRadius: 10, padding: '10px 13px', fontSize: 12.5, lineHeight: 1.5, marginBottom: 14,
    }}>
      {children}
    </div>
  );
}

function ModuleRow({ module: m, busy, isFirst, isLast, onMove, onPatch, onDelete, onReload, onError, onDone }) {
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [title, setTitle] = useState(m.title);
  const [subtitle, setSubtitle] = useState(m.subtitle || '');
  const [description, setDescription] = useState(m.description || '');

  const save = async () => {
    await onPatch({ title, subtitle, description });
    setEditing(false);
  };

  return (
    <div style={{
      border: '1px solid ' + BRAND.border, borderRadius: 12, background: '#fff',
      padding: 12, opacity: busy ? 0.6 : 1,
    }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {/* Thumbnail */}
        <div style={{
          width: 128, height: 72, flexShrink: 0, borderRadius: 7, overflow: 'hidden',
          background: '#0F2A3D', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {m.posterUrl
            ? <img src={m.posterUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <ImageIcon size={20} color="#3D5C72" />}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" style={{ fontSize: 13.5, fontWeight: 600 }} />
              <input className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="One-line summary, shown on the grid tile" style={{ fontSize: 12.5 }} />
              <textarea className="input" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Longer description, shown under the player" style={{ fontSize: 12.5, resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={save} disabled={busy} style={{ fontSize: 12 }}>Save</button>
                <button className="btn-ghost" onClick={() => setEditing(false)} style={{ fontSize: 12 }}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted }}>{m.moduleNumber}</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink }}>{m.title}</span>
                {m.free && <Pill tone="green"><Unlock size={10} /> Free</Pill>}
                {m.published ? <Pill tone="blue">Published</Pill> : <Pill tone="grey">Draft</Pill>}
              </div>
              {m.subtitle && <div style={{ fontSize: 12.5, color: BRAND.muted, marginTop: 3, lineHeight: 1.45 }}>{m.subtitle}</div>}
              <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 5 }}>
                {m.blobUrl ? `${fmtDuration(m.durationSeconds)} · ${fmtMB(m.sizeBytes)}` : 'No video uploaded yet'}
                {' · '}<code style={{ fontSize: 11 }}>{m.slug}</code>
              </div>
            </>
          )}
        </div>

        {/* Running order */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
          <button className="btn-icon" onClick={() => onMove(-1)} disabled={isFirst || busy} title="Move up"><ArrowUp size={13} /></button>
          <button className="btn-icon" onClick={() => onMove(1)} disabled={isLast || busy} title="Move down"><ArrowDown size={13} /></button>
        </div>
      </div>

      {picking && m.blobUrl && (
        <div style={{ marginTop: 10 }}>
          <PosterPicker
            dark={false}
            streamSrc={streamSrc(m)}
            hasPoster={m.hasPoster}
            onError={onError}
            onClose={() => setPicking(false)}
            onSave={async (poster) => {
              await api.post(`${BASE}/${encodeURIComponent(m.id)}/poster`, { poster });
              setPicking(false);
              await onReload();
            }}
          />
        </div>
      )}

      {!editing && !picking && (
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 10, paddingTop: 10, borderTop: '1px solid ' + BRAND.border }}>
          <VideoUpload module={m} onError={onError} onDone={onDone} onReload={onReload} />
          <button className="btn-ghost" onClick={() => setPicking(true)} disabled={!m.blobUrl || busy} style={{ fontSize: 12 }}>
            <ImageIcon size={13} /> {m.hasPoster ? 'Change thumbnail' : 'Thumbnail'}
          </button>
          <button className="btn-ghost" onClick={() => setEditing(true)} disabled={busy} style={{ fontSize: 12 }}>Edit copy</button>
          <button
            className="btn-ghost"
            onClick={() => onPatch({ published: !m.published })}
            disabled={busy || (!m.published && !m.blobUrl)}
            title={!m.blobUrl ? 'Upload the video first' : undefined}
            style={{ fontSize: 12 }}
          >
            {m.published ? <><EyeOff size={13} /> Unpublish</> : <><Eye size={13} /> Publish</>}
          </button>
          <button
            className="btn-ghost"
            onClick={() => onPatch({ free: !m.free })}
            disabled={busy}
            style={{ fontSize: 12 }}
            title={m.free
              ? 'Require a free account to watch this one'
              : 'Let anonymous visitors watch this without signing up'}
          >
            {m.free ? <><Lock size={13} /> Require signup</> : <><Unlock size={13} /> Make free</>}
          </button>
          <button className="btn-ghost" onClick={onDelete} disabled={busy} style={{ fontSize: 12, color: '#D32F2F', marginLeft: 'auto' }}>
            <Trash2 size={13} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

function Pill({ tone, children }) {
  const tones = {
    green: { bg: '#EDFBF2', border: '#9BE0B7', ink: '#15803D' },
    blue:  { bg: '#EAF7FC', border: '#A9E1F5', ink: '#0B6E93' },
    grey:  { bg: '#F1F5F9', border: BRAND.border, ink: BRAND.muted },
  };
  const t = tones[tone] || tones.grey;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700,
      padding: '2px 7px', borderRadius: 999, background: t.bg, border: `1px solid ${t.border}`, color: t.ink,
    }}>
      {children}
    </span>
  );
}

// Browser-direct upload to the public revision blob store. `multipart: true` is
// load-bearing: a single-shot PUT of a file this size fails with a CORS-masked
// error that the SDK then retries forever. The DB row is written by the /video
// POST once upload() resolves — onUploadCompleted never fires in dev.
function VideoUpload({ module: m, onError, onDone, onReload }) {
  const inputRef = useRef(null);
  const [pct, setPct] = useState(null);

  const pick = async (file) => {
    if (!file) return;
    setPct(0);
    try {
      // Read the duration locally before uploading — the browser already has
      // the file, and asking the server would mean downloading it back.
      const durationSeconds = await readDuration(file).catch(() => null);

      const { upload } = await import('@vercel/blob/client');
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = await upload(`course/${m.slug}/${Date.now()}-${safeName}`, file, {
        access: 'public',
        handleUploadUrl: `${BASE}/upload-token`,
        contentType: file.type || 'video/mp4',
        multipart: true,
        onUploadProgress: (e) => setPct(Math.round(e.percentage)),
      });

      await api.post(`${BASE}/${encodeURIComponent(m.id)}/video`, {
        blobUrl: blob.url,
        blobPathname: blob.pathname,
        mimeType: file.type || 'video/mp4',
        sizeBytes: file.size,
        durationSeconds,
      });
      onDone(`“${m.title}” uploaded`);
      await onReload();
    } catch (err) {
      onError(err.message || 'Upload failed');
    } finally {
      setPct(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  if (pct !== null) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: BRAND.muted }}>
        <Loader2 size={13} className="spin" /> Uploading… {pct}%
      </span>
    );
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        style={{ display: 'none' }}
        onChange={(e) => pick(e.target.files?.[0])}
      />
      <button className="btn-ghost" onClick={() => inputRef.current?.click()} style={{ fontSize: 12 }}>
        {m.blobUrl ? <><Upload size={13} /> Replace video</> : <><PlayCircle size={13} /> Upload video</>}
      </button>
    </>
  );
}

// Duration via a throwaway <video> pointed at an object URL. Resolves null on
// anything the browser can't decode rather than blocking the upload — a missing
// runtime is a cosmetic gap, a blocked upload is not.
function readDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    const done = (value) => { URL.revokeObjectURL(url); resolve(value); };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? Math.round(v.duration) : null);
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('metadata')); };
    v.src = url;
  });
}

function NewModule({ onClose, onCreated, onError }) {
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.post(BASE, { title: title.trim(), subtitle: subtitle.trim() });
      onCreated();
    } catch (err) {
      onError(err.message);
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 14, border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 14, background: '#F8FAFC' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title — e.g. Writing a script that doesn't suck" style={{ fontSize: 13.5 }} />
        <input className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="One-line summary for the grid tile" style={{ fontSize: 12.5 }} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={create} disabled={busy || !title.trim()}>{busy ? 'Adding…' : 'Add video'}</button>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
        <div style={{ fontSize: 11.5, color: BRAND.muted }}>
          Added as a draft. Upload the file, pick a thumbnail, then publish it.
        </div>
      </div>
    </div>
  );
}
