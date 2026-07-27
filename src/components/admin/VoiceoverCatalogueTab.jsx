import React, { useEffect, useState, useRef } from 'react';
import { Mic, Plus, Trash2, Upload, Loader2, Eye, EyeOff, Pencil } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { VOICEOVER_SECTIONS } from '../../lib/voiceoverSections.js';

// Admin → Voiceovers. Manage the GLOBAL voiceover-artist catalogue the client
// picks from (per video) in the portal. Three colour-coded sections:
//   'ai'      → Latest-Generation AI Voiceovers   (green — included as standard)
//   'human'   → Professional Voiceover Artists     (blue  — paid upgrade)
//   'premium' → Premium Voiceover Artists          (orange — higher charge)
// One sample clip per artist (uploaded here → private Blob → streamed to the
// portal's <audio>). Below the catalogue, the editable body for the PM's
// "email project tasks" portal email.

const SECTIONS = VOICEOVER_SECTIONS;

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
          <div key={section.key} style={{ marginBottom: 14, background: section.tint, border: `1px solid ${section.border}`, borderRadius: 12, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '0 0 12px' }}>
              <Icon size={17} color={section.accent} />
              <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 800, color: section.accent }}>{section.label}</h3>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {list.map((a) => (
                <div key={a.id} style={{ border: '1px solid ' + BRAND.border, borderRadius: 12, padding: '12px 14px', background: '#fff', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: BRAND.ink }}>{a.name}</div>
                    {a.description && <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.4, marginTop: 1 }}>{a.description}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    {a.hasSample ? (
                      <audio controls preload="none" src={sampleSrc(a)} style={{ flex: '1 1 240px', minWidth: 200, height: 38 }} />
                    ) : (
                      <div style={{ flex: '1 1 240px', minWidth: 200, fontSize: 12, color: BRAND.muted, fontStyle: 'italic' }}>Sample coming soon</div>
                    )}
                    <button className="btn" disabled style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: section.accent, borderColor: section.accent, opacity: 0.55, cursor: 'not-allowed' }}>
                      <Mic size={14} /> Choose this voice
                    </button>
                  </div>
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
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(artist.name || '');
  const [description, setDescription] = useState(artist.description || '');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  // Keep local fields in sync if the artist changes underneath (e.g. reorder).
  useEffect(() => { if (!editing) { setName(artist.name || ''); setDescription(artist.description || ''); } }, [artist.name, artist.description]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = name !== (artist.name || '') || description !== (artist.description || '');

  const save = async () => {
    if (dirty) {
      try { await actions.updateVoiceoverArtist(artist.id, { name: name.trim() || artist.name, description: description.trim() }); }
      catch (err) { showMsg(err.message || 'Could not save'); }
    }
    setEditing(false);
  };
  const cancelEdit = () => { setName(artist.name || ''); setDescription(artist.description || ''); setEditing(false); };
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
        {editing ? (
          <div style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancelEdit(); }}
              placeholder="Artist name"
              style={{ fontSize: 14, fontWeight: 600, padding: '7px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8 }}
            />
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancelEdit(); }}
              placeholder="Style / accent (e.g. British, warm, corporate)"
              style={{ fontSize: 13, padding: '7px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8 }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
              <button onClick={save} className="btn" style={{ fontSize: 12 }}>Done</button>
              <button onClick={cancelEdit} className="btn-ghost" style={{ fontSize: 12 }}>Cancel</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setEditing(true)}
            title="Click to edit name & description"
            style={{ flex: 1, minWidth: 180, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0', display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: BRAND.ink }}>{artist.name || 'Untitled artist'}</span>
              {artist.description && <span style={{ display: 'block', fontSize: 12, color: BRAND.muted, marginTop: 1 }}>{artist.description}</span>}
            </span>
            <Pencil size={13} color={BRAND.muted} style={{ flexShrink: 0 }} />
          </button>
        )}
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
        {/* Quick move between the three sections. */}
        {SECTIONS.filter((s) => s.key !== artist.category).map((s) => (
          <button key={s.key} onClick={() => move(s.key)} className="btn-ghost" style={{ fontSize: 12 }}>
            Move to {s.short}
          </button>
        ))}
      </div>
    </div>
  );
}

function PremiumPriceEditor() {
  const { state, actions } = useStore();
  const [price, setPrice] = useState(state.voiceoverPricing?.premiumPrice ?? '');
  useEffect(() => { setPrice(state.voiceoverPricing?.premiumPrice ?? ''); }, [state.voiceoverPricing]);
  const meta = VOICEOVER_SECTIONS.find((s) => s.key === 'premium');
  const save = () => {
    const n = Number(price);
    actions.saveVoiceoverPricing({ premiumPrice: Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null });
  };
  return (
    <div style={{ marginTop: 28, background: meta.tint, border: `1px solid ${meta.border}`, borderRadius: 12, padding: 16 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15.5, fontWeight: 800, color: meta.accent }}>Premium upgrade price</h3>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: BRAND.muted, lineHeight: 1.5, maxWidth: 600 }}>
        The single charge a client pays to pick a <strong>Premium</strong> artist. On a standard-AI
        project they pay this in full; if they already bought a Human voiceover they pay the
        difference. Full &amp; 50/50 deals pay by card at selection; PO deals have it added to the
        final invoice. Leave blank to hide the Premium section from clients.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: BRAND.ink }}>£</span>
        <input
          type="number" min="0" step="1" value={price}
          onChange={(e) => setPrice(e.target.value)} onBlur={save}
          placeholder="e.g. 200"
          style={{ width: 130, fontSize: 14, padding: '8px 11px', border: '1px solid ' + BRAND.border, borderRadius: 8 }}
        />
        <span style={{ fontSize: 12.5, color: BRAND.muted }}>ex VAT · saved automatically</span>
      </div>
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
            <div key={section.key} style={{ marginBottom: 16, background: section.tint, border: `1px solid ${section.border}`, borderRadius: 12, padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: '#fff', color: section.accent, border: `1px solid ${section.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon size={16} />
                  </div>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: section.accent }}>{section.label}</div>
                    <div style={{ fontSize: 12, color: BRAND.muted }}>{section.hint}</div>
                  </div>
                </div>
                <button onClick={() => add(section.key)} className="btn"><Plus size={14} /> Add artist</button>
              </div>
              {list.length === 0 ? (
                <div style={{ background: 'rgba(255,255,255,0.6)', border: '1px dashed ' + section.border, borderRadius: 10, padding: 22, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>
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

      <PremiumPriceEditor />
    </div>
  );
}
