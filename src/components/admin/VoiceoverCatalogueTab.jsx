import React, { useEffect, useState, useRef } from 'react';
import { Mic, Plus, Trash2, Upload, Sparkles, User, Loader2, Eye, EyeOff } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';

// Admin → Voiceovers. Manage the GLOBAL voiceover-artist catalogue the client
// picks from (per video) in the portal. Two sections matching squideo.com:
//   'ai'    → Latest-Generation AI Voiceovers
//   'human' → Professional Voiceover Artists
// One sample clip per artist (uploaded here → private Blob → streamed to the
// portal's <audio>). Below the catalogue, the editable body for the PM's
// "email project tasks" portal email.

const SECTIONS = [
  { key: 'ai', label: 'Latest-Generation AI Voiceovers', hint: 'AI voices — usually named after the person (Dan, Amelia, …).', icon: Sparkles, accent: '#0EA5E9', tint: '#E0F2FE' },
  { key: 'human', label: 'Professional Voiceover Artists', hint: 'Human artists — usually named by style/accent (UK Female Corporate, …).', icon: User, accent: '#7C3AED', tint: '#F3E8FF' },
];

// Sample bytes are served through the API (private Blob). A cache-buster keyed
// to the artist's size means a re-upload reloads the <audio> instead of the old
// cached clip.
const sampleSrc = (a) => `/api/crm/voiceovers/${encodeURIComponent(a.id)}/sample?v=${a.sizeBytes || 0}`;

// A read-only render of the two-section picker exactly as the client sees it in
// the portal (same layout as src/portal/pages/Voiceover.jsx), so an admin can
// eyeball it without the "preview as client" flow. The "Choose this voice"
// buttons are disabled here — it's a preview, not a real selection.
function ClientPreview({ artists }) {
  return (
    <div style={{ background: '#F8FAFC', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 18, marginBottom: 28 }}>
      <div style={{ fontSize: 12.5, color: BRAND.muted, marginBottom: 16 }}>
        This is what a client sees on their <strong>Choose your voiceover</strong> page. The
        “Choose this voice” buttons are disabled in this preview.
      </div>
      {SECTIONS.map((section) => {
        const list = artists.filter((a) => (a.category || 'human') === section.key);
        if (!list.length) return null;
        const Icon = section.icon;
        return (
          <div key={section.key} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '0 0 12px' }}>
              <Icon size={17} color={section.accent} />
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: BRAND.ink }}>{section.label}</h3>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {list.map((a) => (
                <div key={a.id} style={{ border: '1px solid ' + BRAND.border, borderRadius: 12, padding: '12px 14px', background: '#fff', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 160px', minWidth: 140 }}>
                    <div style={{ fontWeight: 800, fontSize: 14, color: BRAND.ink }}>{a.name}</div>
                    {a.description && <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.4, marginTop: 2 }}>{a.description}</div>}
                  </div>
                  {a.hasSample ? (
                    <audio controls preload="none" src={sampleSrc(a)} style={{ flex: '2 1 240px', minWidth: 200, height: 38 }} />
                  ) : (
                    <div style={{ flex: '2 1 240px', minWidth: 200, fontSize: 12, color: BRAND.muted, fontStyle: 'italic' }}>Sample coming soon</div>
                  )}
                  <button className="btn" disabled style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: section.accent, borderColor: section.accent, opacity: 0.55, cursor: 'not-allowed' }}>
                    <Mic size={14} /> Choose this voice
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ArtistRow({ artist }) {
  const { actions, showMsg } = useStore();
  const [name, setName] = useState(artist.name || '');
  const [description, setDescription] = useState(artist.description || '');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const dirty = name !== (artist.name || '') || description !== (artist.description || '');

  const save = async () => {
    if (!dirty) return;
    try { await actions.updateVoiceoverArtist(artist.id, { name: name.trim(), description: description.trim() }); }
    catch (err) { showMsg(err.message || 'Could not save'); }
  };
  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try { await actions.uploadVoiceoverSample(artist.id, file); showMsg('Sample uploaded'); }
    catch (err) { showMsg(err.message || 'Upload failed'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirm(`Remove "${artist.name || 'this artist'}" from the catalogue?`)) return;
    try { await actions.deleteVoiceoverArtist(artist.id); }
    catch (err) { showMsg(err.message || 'Could not remove'); }
  };
  const move = (category) => actions.updateVoiceoverArtist(artist.id, { category }).catch((e) => showMsg(e.message));

  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            placeholder="Artist name"
            style={{ fontSize: 14.5, fontWeight: 700, padding: '7px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8 }}
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={save}
            placeholder="Style / accent (e.g. British, warm, corporate)"
            style={{ fontSize: 13, padding: '7px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8 }}
          />
        </div>
        <button onClick={remove} className="btn-icon is-danger" title="Remove artist" aria-label={'Remove ' + (artist.name || '')}>
          <Trash2 size={16} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {artist.hasSample ? (
          <audio controls src={sampleSrc(artist)} style={{ height: 36, maxWidth: '100%' }} />
        ) : (
          <span style={{ fontSize: 12.5, color: BRAND.muted }}>No sample clip yet</span>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.ogg"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; upload(f); }}
        />
        <button onClick={() => fileRef.current?.click()} className="btn-ghost" disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
          {artist.hasSample ? 'Replace clip' : 'Upload clip'}
        </button>
        {/* Quick move between the two sections. */}
        {SECTIONS.filter((s) => s.key !== artist.category).map((s) => (
          <button key={s.key} onClick={() => move(s.key)} className="btn-ghost" style={{ fontSize: 12 }}>
            Move to {s.key === 'ai' ? 'AI' : 'Human'}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProjectTasksEmailEditor() {
  const { state, actions } = useStore();
  const cur = state.projectTasksEmail || {};
  const [subject, setSubject] = useState(cur.subject || '');
  const [bodyHtml, setBodyHtml] = useState(cur.bodyHtml || '');

  // Keep local fields in sync if settings load after mount.
  useEffect(() => {
    setSubject(state.projectTasksEmail?.subject || '');
    setBodyHtml(state.projectTasksEmail?.bodyHtml || '');
  }, [state.projectTasksEmail]);

  const persist = (next) => actions.saveProjectTasksEmail({ subject: next.subject ?? subject, bodyHtml: next.bodyHtml ?? bodyHtml });

  return (
    <div style={{ marginTop: 36, borderTop: '1px solid ' + BRAND.border, paddingTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: '#ECFDF5', color: '#047857', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Mic size={20} />
        </div>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700 }}>“Your project tasks” email</h2>
          <p style={{ margin: 0, fontSize: 13.5, color: BRAND.muted, lineHeight: 1.5, maxWidth: 640 }}>
            The wording a production manager sends when a project starts, pointing
            the client to their portal to choose a voiceover and book a kick-off
            call. A <strong>“Sign in / set up your portal” button</strong> is added
            automatically per client at send time — you only edit the wording here.
          </p>
        </div>
      </div>
      <label style={{ fontSize: 12.5, fontWeight: 600, color: BRAND.muted, display: 'block', marginBottom: 4 }}>Subject</label>
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        onBlur={() => persist({ subject })}
        placeholder="Your project has started — a couple of things to choose"
        style={{ width: '100%', fontSize: 14, padding: '9px 11px', border: '1px solid ' + BRAND.border, borderRadius: 8, marginBottom: 12 }}
      />
      <label style={{ fontSize: 12.5, fontWeight: 600, color: BRAND.muted, display: 'block', marginBottom: 4 }}>Body (HTML supported)</label>
      <textarea
        value={bodyHtml}
        onChange={(e) => setBodyHtml(e.target.value)}
        onBlur={() => persist({ bodyHtml })}
        rows={8}
        placeholder={"Hi there,\n\nYour project is underway! To get started, head to your portal to pick a voiceover artist for each video and book your kick-off call."}
        style={{ width: '100%', fontSize: 13.5, padding: '10px 12px', border: '1px solid ' + BRAND.border, borderRadius: 8, fontFamily: 'inherit', lineHeight: 1.5, resize: 'vertical' }}
      />
      <p style={{ fontSize: 12, color: BRAND.muted, marginTop: 6 }}>Saved automatically.</p>
    </div>
  );
}

export function VoiceoverCatalogueTab() {
  const { state, actions, showMsg } = useStore();
  const artists = state.voiceoverArtists;
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => { actions.loadVoiceoverArtists(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (category) => {
    try { await actions.createVoiceoverArtist({ category, name: 'New artist', description: '' }); }
    catch (err) { showMsg(err.message || 'Could not add artist'); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: '#ECFDF5', color: '#047857', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Mic size={20} />
        </div>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700 }}>Voiceover catalogue</h2>
          <p style={{ margin: 0, fontSize: 13.5, color: BRAND.muted, lineHeight: 1.5, maxWidth: 640 }}>
            The voices clients audition and pick from in the portal (one per video).
            Two sections, matching the old squideo.com voiceovers page. Upload one
            sample clip per artist.
          </p>
        </div>
        {artists?.length > 0 && (
          <button onClick={() => setShowPreview((v) => !v)} className="btn-ghost" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            {showPreview ? <><EyeOff size={14} /> Hide preview</> : <><Eye size={14} /> Preview as client</>}
          </button>
        )}
      </div>

      {showPreview && artists?.length > 0 && <ClientPreview artists={artists} />}

      {artists == null ? (
        <div style={{ padding: 28, textAlign: 'center', color: BRAND.muted, fontSize: 13.5 }}>Loading…</div>
      ) : (
        SECTIONS.map((section) => {
          const list = artists.filter((a) => (a.category || 'human') === section.key);
          const Icon = section.icon;
          return (
            <div key={section.key} style={{ marginBottom: 28 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: section.tint, color: section.accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon size={16} />
                  </div>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{section.label}</div>
                    <div style={{ fontSize: 12, color: BRAND.muted }}>{section.hint}</div>
                  </div>
                </div>
                <button onClick={() => add(section.key)} className="btn"><Plus size={14} /> Add artist</button>
              </div>
              {list.length === 0 ? (
                <div style={{ background: 'white', border: '1px dashed ' + BRAND.border, borderRadius: 10, padding: 22, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
                  No artists in this section yet.
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 10 }}>
                  {list.map((a) => <ArtistRow key={a.id} artist={a} />)}
                </div>
              )}
            </div>
          );
        })
      )}

      <ProjectTasksEmailEditor />
    </div>
  );
}
