// "Choose your voiceover" — a project task. The sections a client sees, and
// what each pick costs, come from their signed proposal (server-decided):
//   • AI (green) is included as standard (free).
//   • Human (blue) is a paid upgrade — unless they already bought it.
//   • Premium (orange) is a higher paid upgrade.
// A £0 pick locks immediately; a paid pick either rides the final invoice (PO
// deals) or takes a card payment now (full / 50-50). One pick per video, with a
// "use this artist for all videos" shortcut (charged once).
import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi, mediaUrl } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, SectionHeading, StatusPill } from '../components.jsx';
import { ArrowLeft, Check, Mic, Lock, CreditCard } from 'lucide-react';
import { sectionFor } from '../../lib/voiceoverSections.js';

const money = (n) => '£' + (Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2));
const videoLabel = (v, reference) =>
  reference && v.videoNumber ? `${reference}-${String(v.videoNumber).padStart(2, '0')}` : (v.title || 'Video');

function ArtistCard({ artist, section, charge, onChoose, disabled }) {
  return (
    <div style={{ border: `1px solid ${BRAND.border}`, borderRadius: 12, padding: '12px 14px', background: '#fff', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14, color: BRAND.ink }}>{artist.name}</div>
        {artist.description && <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.4, marginTop: 1 }}>{artist.description}</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {artist.hasSample ? (
          <audio controls preload="none" src={mediaUrl(`voiceover-sample?artistId=${encodeURIComponent(artist.id)}&v=${artist.sizeBytes || 0}`)} style={{ flex: '1 1 240px', minWidth: 200, height: 38 }} />
        ) : (
          <div style={{ flex: '1 1 240px', minWidth: 200, fontSize: 12, color: BRAND.muted, fontStyle: 'italic' }}>Sample coming soon</div>
        )}
        <button
          className="btn"
          disabled={disabled}
          onClick={() => onChoose(artist, section, charge)}
          style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: section.accent, borderColor: section.accent }}
        >
          <Mic size={14} /> {charge > 0 ? `Choose · +${money(charge)}` : 'Choose this voice'}
        </button>
      </div>
    </div>
  );
}

export default function Voiceover({ dealId }) {
  const { showToast, refreshOverview } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [choosing, setChoosing] = useState(null);   // { artist, section, charge }
  const [targetVideo, setTargetVideo] = useState(null);
  const [applyToAll, setApplyToAll] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setData(await portalApi.get(`voiceover?dealId=${encodeURIComponent(dealId)}`)); }
    catch (err) { setError(err.message); }
  };
  useEffect(() => { load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Returning from a Stripe payment (?vo_paid=1 in the query, before the hash).
  // The webhook applies the pick; give it a moment, then reload so the locked
  // row shows.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.get('vo_paid')) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    showToast('Payment received — locking in your voiceover 🎙️');
    const t1 = setTimeout(load, 1500);
    const t2 = setTimeout(load, 4500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const videos = data?.videos || [];
  const unpicked = videos.filter((v) => !v.voiceover);
  const multiVideo = videos.length > 1;

  const openChoose = (artist, section, charge) => {
    if (!unpicked.length) return;
    setChoosing({ artist, section, charge });
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
        artistId: choosing.artist.id,
        applyToAll,
      });
      if (res.requiresPayment && res.checkoutUrl) {
        window.location.href = res.checkoutUrl; // off to Stripe; return via ?vo_paid=1
        return;
      }
      setData((d) => ({ ...d, videos: res.videos }));
      showToast(res.charged ? `${choosing.artist.name} locked in — ${money(res.charged.amount)} added to your final invoice` : `${choosing.artist.name} locked in 🎙️`);
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

  const header = (
    <div>
      <a href={`#/project/${dealId}`} className="btn-link" style={{ fontSize: 13 }}>
        <ArrowLeft size={14} style={{ verticalAlign: -2 }} /> {data.dealTitle}
      </a>
      <h1 style={{ margin: '8px 0 4px', fontSize: 22, fontWeight: 800, color: BRAND.ink }}>Choose your voiceover 🎙️</h1>
    </div>
  );

  // This project has no voiceover (the standard AI VO was removed and no human
  // VO was bought) — nothing to choose.
  if (!data.hasVo) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {header}
        <Card><EmptyState title="No voiceover on this project" body="Your project doesn't include a voiceover. If you'd like to add one, just message your producer." /></Card>
      </div>
    );
  }

  const allPicked = videos.length > 0 && unpicked.length === 0;
  const payNow = data.paymentMode === 'now';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {header}
      <p style={{ margin: 0, fontSize: 13.5, color: BRAND.muted, maxWidth: 600, lineHeight: 1.55 }}>
        Have a listen and pick the voice for {multiVideo ? 'each of your videos' : 'your video'}.
        Your project includes a voice as standard; upgrades are marked with their price.
        {multiVideo ? ' You can use one artist for everything, or a different voice per video.' : ''} Once you confirm it's locked in.
      </p>

      {/* Per-video status */}
      {videos.length > 0 && (
        <Card>
          <SectionHeading>{multiVideo ? 'Your videos' : 'Your video'}</SectionHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {videos.map((v) => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 2px', borderBottom: `1px solid ${BRAND.border}` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink }}>{v.title}</div>
                  {data.reference && v.videoNumber && (<div style={{ fontSize: 11.5, color: BRAND.muted }}>{videoLabel(v, data.reference)}</div>)}
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
        (data.sections || []).map((s) => {
          const meta = sectionFor(s.key);
          if (!s.artists?.length) return null;
          const Icon = meta.icon;
          return (
            <div key={s.key} style={{ background: meta.tint, border: `1px solid ${meta.border}`, borderRadius: 14, padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', margin: '0 0 12px' }}>
                <Icon size={17} color={meta.accent} />
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: meta.accent }}>{meta.label}</h2>
                <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 800, color: meta.accent, background: '#fff', border: `1px solid ${meta.border}`, borderRadius: 999, padding: '2px 10px' }}>
                  {s.charge > 0 ? `+${money(s.charge)}` : 'Included'}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {s.artists.map((a) => (
                  <ArtistCard key={a.id} artist={a} section={meta} charge={s.charge} disabled={busy} onChoose={openChoose} />
                ))}
              </div>
            </div>
          );
        })
      )}

      {choosing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,42,61,0.5)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 24, maxWidth: 400, width: '100%' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 800, color: BRAND.ink }}>Use {choosing.artist.name}?</h3>

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
                <span style={{ fontWeight: 600 }}>Use {choosing.artist.name} for all {unpicked.length} remaining videos</span>
              </label>
            )}

            {choosing.charge > 0 ? (
              <div style={{ margin: '0 0 16px', padding: '11px 13px', borderRadius: 10, background: payNow ? '#EFF6FF' : '#FFF7ED', border: `1px solid ${payNow ? '#BFDBFE' : '#FED7AA'}` }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 7 }}>
                  <CreditCard size={15} /> {money(choosing.charge)} upgrade
                </div>
                <div style={{ fontSize: 12.5, color: BRAND.muted, marginTop: 3, lineHeight: 1.45 }}>
                  {payNow
                    ? "You'll be taken to a secure card payment. Your pick locks in once payment completes."
                    : "This will be added to your project's final invoice — nothing to pay right now."}
                </div>
              </div>
            ) : (
              <p style={{ margin: '0 0 16px', fontSize: 12.5, color: BRAND.muted, lineHeight: 1.5 }}>
                This locks in {applyToAll ? 'your voiceover for the remaining videos' : 'the voiceover for this video'} — you won't be able to change it here afterwards.
              </p>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn-ghost" onClick={() => setChoosing(null)} disabled={busy}>Cancel</button>
              <button className="btn" disabled={busy} onClick={confirm}>
                {busy ? 'Saving…' : choosing.charge > 0 && payNow ? (<><CreditCard size={14} /> Pay {money(choosing.charge)}</>) : (<><Check size={14} /> Confirm choice</>)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
