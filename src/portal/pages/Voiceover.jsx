// "Choose your voiceover" — a project task. The client auditions the two
// artist sections (matching squideo.com) and picks one PER VIDEO. A pick locks
// in (confirm modal makes that clear). When a project has more than one video,
// the confirm step offers "use this artist for all videos".
import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, SectionHeading, StatusPill } from '../components.jsx';
import { ArrowLeft, Sparkles, User, Check, Mic, Lock } from 'lucide-react';

const SECTIONS = [
  { key: 'ai', label: 'Latest-Generation AI Voiceovers', Icon: Sparkles, accent: '#0EA5E9' },
  { key: 'human', label: 'Professional Voiceover Artists', Icon: User, accent: '#7C3AED' },
];

const videoLabel = (v, reference) =>
  reference && v.videoNumber ? `${reference}-${String(v.videoNumber).padStart(2, '0')}` : (v.title || 'Video');

function ArtistCard({ artist, accent, onChoose, disabled }) {
  return (
    <div style={{ border: `1px solid ${BRAND.border}`, borderRadius: 12, padding: '12px 14px', background: '#fff', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 160px', minWidth: 140 }}>
        <div style={{ fontWeight: 800, fontSize: 14, color: BRAND.ink }}>{artist.name}</div>
        {artist.description && <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.4, marginTop: 2 }}>{artist.description}</div>}
      </div>
      {artist.hasSample ? (
        <audio controls preload="none" src={`/api/portal/voiceover-sample?artistId=${encodeURIComponent(artist.id)}&v=${artist.sizeBytes || 0}`} style={{ flex: '2 1 240px', minWidth: 200, height: 38 }} />
      ) : (
        <div style={{ flex: '2 1 240px', minWidth: 200, fontSize: 12, color: BRAND.muted, fontStyle: 'italic' }}>Sample coming soon</div>
      )}
      <button
        className="btn"
        disabled={disabled}
        onClick={() => onChoose(artist)}
        style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: accent, borderColor: accent }}
      >
        <Mic size={14} /> Choose this voice
      </button>
    </div>
  );
}

export default function Voiceover({ dealId }) {
  const { showToast, refreshOverview } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [choosing, setChoosing] = useState(null);   // the artist being confirmed
  const [targetVideo, setTargetVideo] = useState(null); // chosen video id in modal
  const [applyToAll, setApplyToAll] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setData(await portalApi.get(`voiceover?dealId=${encodeURIComponent(dealId)}`)); }
    catch (err) { setError(err.message); }
  };
  useEffect(() => { load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const videos = data?.videos || [];
  const unpicked = videos.filter((v) => !v.voiceover);
  const multiVideo = videos.length > 1;

  const openChoose = (artist) => {
    if (!unpicked.length) return;
    setChoosing(artist);
    setTargetVideo(unpicked[0].id);
    setApplyToAll(false);
  };

  const confirm = async () => {
    if (!choosing) return;
    setBusy(true);
    try {
      const res = await portalApi.post('voiceover-select', {
        dealId,
        videoId: applyToAll ? unpicked[0].id : targetVideo,
        artistId: choosing.id,
        applyToAll,
      });
      setData((d) => ({ ...d, videos: res.videos }));
      showToast(`${choosing.name} locked in 🎙️`);
      setChoosing(null);
      refreshOverview().catch(() => {});
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div>
        <a href="#/" className="btn-link" style={{ fontSize: 13 }}><ArrowLeft size={14} style={{ verticalAlign: -2 }} /> Back</a>
        <Card style={{ marginTop: 14 }}><EmptyState title="Couldn't load voiceovers" body={error} /></Card>
      </div>
    );
  }
  if (!data) return <div style={{ color: BRAND.muted, fontSize: 13, padding: 30, textAlign: 'center' }}>Loading voiceovers…</div>;

  const allPicked = videos.length > 0 && unpicked.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <a href={`#/project/${dealId}`} className="btn-link" style={{ fontSize: 13 }}>
          <ArrowLeft size={14} style={{ verticalAlign: -2 }} /> {data.dealTitle}
        </a>
        <h1 style={{ margin: '8px 0 4px', fontSize: 22, fontWeight: 800, color: BRAND.ink }}>Choose your voiceover 🎙️</h1>
        <p style={{ margin: 0, fontSize: 13.5, color: BRAND.muted, maxWidth: 580, lineHeight: 1.55 }}>
          Have a listen and pick the voice for {multiVideo ? 'each of your videos' : 'your video'}.
          {multiVideo ? ' You can use one artist for everything, or a different voice per video.' : ''} Once you confirm a choice it's locked in for recording.
        </p>
      </div>

      {/* Per-video status */}
      {videos.length > 0 && (
        <Card>
          <SectionHeading>{multiVideo ? 'Your videos' : 'Your video'}</SectionHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {videos.map((v) => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 2px', borderBottom: `1px solid ${BRAND.border}` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink }}>{v.title}</div>
                  {data.reference && v.videoNumber && (
                    <div style={{ fontSize: 11.5, color: BRAND.muted }}>{videoLabel(v, data.reference)}</div>
                  )}
                </div>
                {v.voiceover ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, color: '#16A34A' }}>
                    <Lock size={13} /> {v.voiceover.artistName}
                  </span>
                ) : (
                  <StatusPill label="Not chosen yet" color="#F59E0B" />
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {allPicked ? (
        <Card>
          <EmptyState title="All set — voiceovers chosen ✅" body="You've picked a voice for every video. Need a change? Just message your producer." />
        </Card>
      ) : (
        SECTIONS.map((section) => {
          const list = (data.artists?.[section.key]) || [];
          if (!list.length) return null;
          const Icon = section.Icon;
          return (
            <div key={section.key}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '0 0 12px' }}>
                <Icon size={17} color={section.accent} />
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: BRAND.ink }}>{section.label}</h2>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {list.map((a) => (
                  <ArtistCard key={a.id} artist={a} accent={section.accent} disabled={busy} onChoose={openChoose} />
                ))}
              </div>
            </div>
          );
        })
      )}

      {choosing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,42,61,0.5)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 24, maxWidth: 400, width: '100%' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 800, color: BRAND.ink }}>Use {choosing.name}?</h3>

            {multiVideo && !applyToAll && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: BRAND.muted, marginBottom: 6 }}>For which video?</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {unpicked.map((v) => (
                    <label key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, cursor: 'pointer' }}>
                      <input type="radio" name="vo-target" checked={targetVideo === v.id} onChange={() => setTargetVideo(v.id)} />
                      <span>{v.title}{data.reference && v.videoNumber ? ` (${videoLabel(v, data.reference)})` : ''}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {multiVideo && unpicked.length > 1 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, cursor: 'pointer', marginBottom: 14, padding: '10px 12px', background: '#F1F4F7', borderRadius: 8 }}>
                <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
                <span style={{ fontWeight: 600 }}>Use {choosing.name} for all {unpicked.length} remaining videos</span>
              </label>
            )}

            <p style={{ margin: '0 0 18px', fontSize: 12.5, color: BRAND.muted, lineHeight: 1.5 }}>
              This locks in {applyToAll ? 'your voiceover for the remaining videos' : 'the voiceover for this video'} — you won't be able to change it here afterwards. You'll get a confirmation email.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn-ghost" onClick={() => setChoosing(null)} disabled={busy}>Cancel</button>
              <button className="btn" disabled={busy} onClick={confirm}>
                {busy ? 'Saving…' : (<><Check size={14} /> Confirm choice</>)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
