import React, { useState } from 'react';
import { CheckCircle2, Clock3, Play, Hourglass } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useIsMobile } from '../../utils.js';

// The menu a client lands on when a project holds more than one video (or
// storyboard). A share token covers the WHOLE project, and the only way in was
// a dropdown in the top-right of the header — which clients kept missing, so
// they reviewed one video and never realised the other two were waiting for
// them. The grid puts every item on the page, at poster size, with its status
// on the card; clicking one opens it on its latest draft.
//
// Shared by the video and storyboard viewers: both take the same shape
// ({ id, title, versions[] }) and differ only in how a card is illustrated,
// which is why `renderThumb` is a prop.

// The same tiled "DRAFT" watermark the player and the slide view carry, scaled
// down for a card. Drafts are watermarked wherever they're shown, and a poster
// frame is still a frame of the draft.
// `fill` differs by surface: light over a video frame, dark over a white
// storyboard page — the same pairing the player and PdfPage use.
const draftTile = (fill) => encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='150' height='104'>" +
  `<text x='6' y='66' transform='rotate(-28 75 52)' fill='${fill}' ` +
  "font-size='20' font-weight='700' font-family='Arial, Helvetica, sans-serif' " +
  "letter-spacing='2'>DRAFT</text></svg>"
);
const DRAFT_ON_VIDEO = draftTile('rgba(255,255,255,0.22)');
const DRAFT_ON_PAGE = draftTile('rgba(15,42,61,0.10)');

// Card status, so a client can see at a glance which item still needs them.
// `tone` maps to the pill colours below.
const TONES = {
  waiting: { bg: '#FEF3C7', fg: '#92400E', Icon: Clock3 },
  done: { bg: '#DCFCE7', fg: '#166534', Icon: CheckCircle2 },
  sent: { bg: '#E0F2FE', fg: '#075985', Icon: CheckCircle2 },
  none: { bg: '#F1F5F9', fg: BRAND.muted, Icon: Hourglass },
};

function StatusPill({ status }) {
  const tone = TONES[status?.tone] || TONES.none;
  const { Icon } = tone;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px',
      borderRadius: 999, background: tone.bg, color: tone.fg, fontSize: 11.5, fontWeight: 700 }}>
      <Icon size={13} /> {status?.label}
    </span>
  );
}

/**
 * @param {object}   props
 * @param {Function} props.icon        lucide icon for the header + empty thumbs
 * @param {string}   props.title       project title
 * @param {string}   props.clientName
 * @param {Array}    props.items       videos / storyboards ({ id, title, versions })
 * @param {Function} props.statusFor   item -> { label, tone, sub? }
 * @param {Function} props.renderThumb item -> node (the card's picture)
 * @param {Function} props.onOpen      item id -> void
 * @param {string}   props.noun        'video' | 'storyboard'
 * @param {string?}  props.highlightId the item the link was sent about, if any
 * @param {string}   props.thumbAspect CSS aspect-ratio for the card picture
 * @param {boolean}  props.embedded    rendered inside the portal shell
 */
export function ReviewPicker({ icon: Icon, title, clientName, items, statusFor, renderThumb,
  onOpen, noun, highlightId = null, thumbAspect = '16 / 9', embedded = false }) {
  const isMobile = useIsMobile();
  const [hoverId, setHoverId] = useState(null);

  return (
    <div style={embedded
      ? { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'auto' }
      : { display: 'flex', flexDirection: 'column', minHeight: isMobile ? '100dvh' : '100vh' }}>
      {/* Header — same bar as the viewer's, minus the per-item controls. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12,
        padding: isMobile ? '10px 12px' : '12px 18px', flexShrink: 0,
        borderBottom: `1px solid ${BRAND.border}`, background: '#fff' }}>
        <Icon size={20} color={BRAND.blue} />
        <strong style={{ color: BRAND.ink, fontSize: isMobile ? 14 : 15, minWidth: 0, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</strong>
        {clientName && !isMobile && <span style={{ color: BRAND.muted, fontSize: 13 }}>· {clientName}</span>}
      </div>

      <div style={{ padding: isMobile ? '18px 14px 32px' : '28px 24px 40px', maxWidth: 1100,
        width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        <h1 style={{ fontSize: isMobile ? 18 : 22, color: BRAND.ink, margin: '0 0 4px' }}>
          Your {noun}s
        </h1>
        <p style={{ color: BRAND.muted, fontSize: 13.5, margin: '0 0 20px', maxWidth: 640 }}>
          This project has {items.length} {noun}s. Choose one to open it on its latest draft — each is
          reviewed separately, and you can come back to the others at any time.
        </p>

        <div style={{ display: 'grid', gap: isMobile ? 14 : 18,
          gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {items.map((item, i) => {
            const status = statusFor(item) || {};
            const ready = (item.versions || []).length > 0;
            const highlighted = item.id === highlightId;
            const lifted = hoverId === item.id && ready;
            return (
              <button key={item.id} type="button" disabled={!ready}
                onClick={() => ready && onOpen(item.id)}
                onMouseEnter={() => setHoverId(item.id)}
                onMouseLeave={() => setHoverId(null)}
                style={{ textAlign: 'left', padding: 0, font: 'inherit', background: '#fff',
                  border: `${highlighted ? 2 : 1}px solid ${highlighted ? BRAND.blue : BRAND.border}`,
                  borderRadius: 12, overflow: 'hidden', cursor: ready ? 'pointer' : 'default',
                  opacity: ready ? 1 : 0.65, display: 'flex', flexDirection: 'column',
                  boxShadow: lifted ? '0 8px 20px rgba(15,42,61,0.14)' : '0 1px 2px rgba(15,42,61,0.05)',
                  transform: lifted ? 'translateY(-2px)' : 'none',
                  transition: 'box-shadow .15s ease, transform .15s ease' }}>
                <div style={{ position: 'relative', background: '#0B1B26', aspectRatio: thumbAspect,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                  {ready ? renderThumb(item) : <Icon size={28} color="rgba(255,255,255,0.35)" />}
                  {ready && (
                    <span aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
                      backgroundRepeat: 'repeat',
                      backgroundImage: `url("data:image/svg+xml,${noun === 'video' ? DRAFT_ON_VIDEO : DRAFT_ON_PAGE}")` }} />
                  )}
                  {ready && noun === 'video' && (
                    <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                      justifyContent: 'center', pointerEvents: 'none' }}>
                      <span style={{ width: 46, height: 46, borderRadius: 999, background: 'rgba(11,27,38,0.62)',
                        border: '2px solid rgba(255,255,255,0.85)', display: 'flex', alignItems: 'center',
                        justifyContent: 'center' }}>
                        <Play size={20} color="#fff" fill="#fff" style={{ marginLeft: 2 }} />
                      </span>
                    </span>
                  )}
                  <span style={{ position: 'absolute', top: 8, left: 8, padding: '2px 8px', borderRadius: 999,
                    background: 'rgba(11,27,38,0.75)', color: '#fff', fontSize: 11, fontWeight: 700 }}>
                    {noun === 'video' ? 'Video' : 'Storyboard'} {i + 1}
                  </span>
                  {status.corner && (
                    <span style={{ position: 'absolute', bottom: 8, right: 8, padding: '2px 8px',
                      borderRadius: 999, background: 'rgba(11,27,38,0.75)', color: '#fff', fontSize: 11,
                      fontWeight: 700 }}>
                      {status.corner}
                    </span>
                  )}
                </div>
                <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <strong style={{ color: BRAND.ink, fontSize: 14.5, lineHeight: 1.3 }}>{item.title}</strong>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <StatusPill status={status} />
                    {status.sub && <span style={{ color: BRAND.muted, fontSize: 12 }}>{status.sub}</span>}
                  </div>
                  {highlighted && (
                    <span style={{ color: BRAND.blue, fontSize: 12, fontWeight: 700 }}>
                      This is the one we emailed you about
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Poster frame for a video card: the file itself, seeked a fraction in so the
// browser paints a real frame rather than a black one. No thumbnails are stored
// server-side, and the revision blob store is public, so this costs one metadata
// range request per card.
export function VideoThumb({ url }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return null;
  return (
    <video src={`${url}#t=0.5`} preload="metadata" muted playsInline
      onError={() => setFailed(true)}
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
  );
}
