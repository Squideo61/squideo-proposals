// Admin → Crash course. Manage the 8 modules of The Explainer Video Crash
// Course: upload each video, pick its thumbnail, write the copy, and publish.
//
// The landing page only ever shows PUBLISHED modules, which is what lets the
// course go live with module 1 while the rest are still uploading. Exactly one
// module is marked FREE — that's the one anonymous visitors can watch, and the
// whole conversion strategy rests on it playing before anyone is asked for an
// email address.
//
// Uploads go browser-direct to Blob storage (these are hundreds of megabytes;
// the serverless body limit is 4.5MB) using the same pattern as the portal
// library and the CRM's revision drafts.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  GraduationCap, Plus, Upload, Trash2, Eye, EyeOff, Image as ImageIcon,
  Loader2, PlayCircle, Unlock, ArrowUp, ArrowDown, ExternalLink,
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
      showMsg('Module deleted');
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

  const published = modules.filter((m) => m.published).length;
  const freeModule = modules.find((m) => m.free);
  const totalSeconds = modules.filter((m) => m.published).reduce((n, m) => n + (m.durationSeconds || 0), 0);

  return (
    <div style={{ maxWidth: 900 }}>
      <header style={{ marginBottom: 18 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 9 }}>
          <GraduationCap size={19} color={BRAND.blue} /> The Explainer Video Crash Course
        </h2>
        <p style={{ margin: 0, fontSize: 12.5, color: BRAND.muted, lineHeight: 1.5 }}>
          Public page: <a href="/course" target="_blank" rel="noreferrer" style={{ color: BRAND.blue }}>
            app.squideo.com/course <ExternalLink size={11} style={{ verticalAlign: -1 }} />
          </a>
          {' · '}{published} of {modules.length} published{published > 0 && ` · ${fmtDuration(totalSeconds)} total`}
        </p>
      </header>

      {!freeModule && modules.length > 0 && (
        <Notice tone="warn">
          No module is marked <strong>free</strong>. Anonymous visitors will see the grid but have
          nothing to watch — and the whole point of the page is that they see the quality before
          they’re asked for an email address. Tick <strong>Free</strong> on module 1.
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
          No modules yet. Add the first one below.
        </div>
      )}

      {creating ? (
        <NewModule onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} onError={(msg) => showMsg(msg, 'error')} />
      ) : (
        <button className="btn-ghost" onClick={() => setCreating(true)} style={{ marginTop: 14 }}>
          <Plus size={14} /> Add a module
        </button>
      )}
    </div>
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
          {!m.free && (
            <button className="btn-ghost" onClick={() => onPatch({ free: true })} disabled={busy} style={{ fontSize: 12 }} title="Make this the module anonymous visitors can watch">
              <Unlock size={13} /> Make free
            </button>
          )}
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
          <button className="btn" onClick={create} disabled={busy || !title.trim()}>{busy ? 'Adding…' : 'Add module'}</button>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
        <div style={{ fontSize: 11.5, color: BRAND.muted }}>
          The module is created as a draft. Upload its video, pick a thumbnail, then publish it.
        </div>
      </div>
    </div>
  );
}
