// The Partner Programme, inside the portal.
//
// It used to be a link to squideo.com — which meant a client who was interested
// left the portal to read a sales page written for strangers, and the only way
// back was the browser's back button. This is the same offer told to someone we
// already work with, ending in a booked call rather than a quote form.
//
// No price anywhere. The programme is scoped on the call — how much content,
// how often, what shape — and a number seen beforehand becomes the anchor every
// later conversation has to argue against. Same reason the brief builder asks
// for a budget band instead of publishing a rate.
import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { useIsMobile } from '../../utils.js';
import { Card, EmptyState } from '../components.jsx';
import {
  CalendarClock, Check, PiggyBank, PlayCircle, Repeat, Shuffle, Unlock, Zap, TrendingDown, Handshake,
} from 'lucide-react';

// Sizing, in the language of the offer: 1 credit = 60 seconds, so "minutes a
// month" and "credits a month" are the same question. "Not sure yet" is a real
// answer — forcing a figure would either lose the enquiry or invent a number
// the client doesn't stand behind. Kept in step with PARTNER_MINUTES in
// api/portal.js, which is the authority.
const MINUTES_OPTIONS = [
  { value: '1-2', label: '1–2 minutes' },
  { value: '3-4', label: '3–4 minutes' },
  { value: '5-9', label: '5–9 minutes' },
  { value: '10+', label: '10+ minutes' },
  { value: 'unsure', label: 'Not sure yet' },
];

const TIME_OPTIONS = [
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'either', label: 'Either' },
];

// Local date, not UTC — toISOString() would roll the min back a day for anyone
// west of Greenwich and forward for anyone east of it after their evening.
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function longDate(value) {
  // A plain YYYY-MM-DD parsed as UTC midnight, then read back in UTC, so the
  // day the client picked is the day the page shows them.
  const s = String(value).slice(0, 10);
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

// Vimeo / YouTube / Loom go in an iframe; a file we host plays natively.
//
// The third case matters. The portal's CSP allows exactly those three frame
// hosts, and media-src only 'self' and our own blob store — so an MP4 on
// somebody else's CDN is blocked, and a <video> pointed at it renders a black
// rectangle with the failure only visible in the console. `unsupported` exists
// so the page can say what happened instead of looking broken.
const PLAYABLE_MEDIA = /^(?:\/|https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/)/i;

export function videoEmbed(url) {
  if (!url) return null;
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/);
  if (yt) return { kind: 'frame', src: 'https://www.youtube.com/embed/' + yt[1] };
  // The trailing group is an unlisted film's privacy hash (vimeo.com/ID/HASH).
  // oembedUrl is rebuilt canonically rather than passed through: the proxy only
  // accepts vimeo.com/<id>, so a /video/ form or a ?share= suffix would come
  // back empty and silently drop the player to a 16:9 guess. The hash is kept,
  // because without it an unlisted film's metadata isn't readable at all.
  const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)(?:\/([A-Za-z0-9]+))?/);
  if (vimeo) {
    return {
      kind: 'frame',
      src: 'https://player.vimeo.com/video/' + vimeo[1],
      oembedUrl: 'https://vimeo.com/' + vimeo[1] + (vimeo[2] ? '/' + vimeo[2] : ''),
    };
  }
  const loom = url.match(/loom\.com\/(?:share|embed)\/([A-Za-z0-9]+)/);
  if (loom) return { kind: 'frame', src: 'https://www.loom.com/embed/' + loom[1] };
  if (PLAYABLE_MEDIA.test(url)) return { kind: 'file', src: url };
  return { kind: 'unsupported', src: url };
}

// An embedded player has to be given a height, and guessing 16:9 is what put
// black bars above and below a film that isn't. Vimeo's oEmbed knows the real
// dimensions, so we ask (through our own proxy — the CSP blocks vimeo.com
// directly) and shape the box to the answer. 16:9 until it replies, and if it
// never does; that's the right guess, just not always the right one.
const DEFAULT_RATIO = 9 / 16;

function FrameVideo({ embed, title }) {
  const [ratio, setRatio] = useState(DEFAULT_RATIO);

  useEffect(() => {
    if (!embed.oembedUrl) return undefined;
    let alive = true;
    fetch('/api/vimeo-oembed?url=' + encodeURIComponent(embed.oembedUrl))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.width || !d?.height) return;
        setRatio(d.height / d.width);
      })
      .catch(() => { /* the 16:9 default stands */ });
    return () => { alive = false; };
  }, [embed.oembedUrl]);

  return (
    <div style={{ position: 'relative', width: '100%', paddingTop: `${ratio * 100}%`, background: '#000' }}>
      <iframe
        src={embed.src}
        title={title || 'Partner Programme'}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        allowFullScreen
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
      />
    </div>
  );
}

function VideoBlock({ video }) {
  const embed = videoEmbed(video?.url);
  if (!embed) return null;
  // A link we can't play in the page. Offer it rather than pretend — and say
  // enough that whoever set it knows to move it to Vimeo or upload it.
  if (embed.kind === 'unsupported') {
    return (
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <PlayCircle size={20} color={BRAND.blue} style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 200, fontSize: 13.5, color: BRAND.ink }}>
            {video.title || 'Watch the Partner Programme explainer'}
          </div>
          <a href={embed.src} target="_blank" rel="noreferrer" className="btn" style={{ textDecoration: 'none' }}>
            Watch the video
          </a>
        </div>
      </Card>
    );
  }
  return (
    // Capped and centred rather than running the full content width. It's a
    // supporting explainer on a page that's mostly reading, and at 1080px wide
    // it was the loudest thing here by a distance.
    <Card style={{ padding: 0, overflow: 'hidden', maxWidth: 620, margin: '0 auto', width: '100%' }}>
      {embed.kind === 'frame' ? (
        <FrameVideo embed={embed} title={video.title} />
      ) : (
        // No fixed-ratio box and no black backdrop: the element sizes itself to
        // the file, so a film that isn't 16:9 can't be letterboxed into one.
        <video
          src={embed.src}
          controls
          playsInline
          preload="metadata"
          style={{ display: 'block', width: '100%', height: 'auto' }}
        />
      )}
      {video.title && (
        <div style={{ padding: '11px 16px', fontSize: 13.5, fontWeight: 700, color: BRAND.ink }}>
          {video.title}
        </div>
      )}
    </Card>
  );
}


const CREDIT_USES = [
  'New animated explainer videos',
  'Additional modules or chapters (shorter videos)',
  'Edits and updates to existing videos',
  'Alternate versions — different audience, messaging or language',
  'Cutdowns for social, email and intranet',
  'Reformatting and resizing for each channel',
  'Extras like thumbnails, end screens and subtitled versions',
];

const STEPS = [
  {
    title: 'Choose a credit level',
    body: 'Pick a monthly level that sits comfortably with your budget and the content you have planned.',
  },
  {
    title: 'Build a video plan',
    body: "Tell us what's coming up. We'll help you prioritise it and plan the production around it.",
  },
  {
    title: 'Use credits as you need them',
    body: 'Spend them on a single video, on smaller updates, or save them up and combine them for something bigger.',
  },
];

const ASSURANCES = [
  { Icon: Repeat, title: 'Credits roll over', body: "Anything you don't use carries forward. A quiet month isn't a wasted one." },
  { Icon: Shuffle, title: 'Spend them how you like', body: 'Allocate them any way you need, pause, or combine months for a bigger piece of work.' },
  { Icon: Unlock, title: 'Cancel any time', body: 'No long-term commitment — you stay because it works, not because you signed something.' },
];

// A text/image row that becomes one column on a phone. The image is optional in
// practice: if the file isn't there yet it removes itself rather than leaving a
// broken-image icon in the middle of a sales page.
function Split({ title, image, imageAlt, reverse = false, isMobile, children }) {
  const [broken, setBroken] = useState(false);
  const showImage = image && !broken;
  const text = (
    <div style={{ fontSize: 13.5, color: BRAND.ink, lineHeight: 1.65 }}>
      <h2 style={{ margin: '0 0 10px', fontSize: 19, fontWeight: 800, color: BRAND.blue }}>{title}</h2>
      {children}
    </div>
  );
  const pic = showImage ? (
    <img
      src={image}
      alt={imageAlt || ''}
      loading="lazy"
      onError={() => setBroken(true)}
      style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 10 }}
    />
  ) : null;
  return (
    <Card>
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile || !showImage ? '1fr' : '1fr 1fr',
        gap: isMobile ? 16 : 28,
        alignItems: 'center',
      }}>
        {/* On a phone the image always follows the words — a reversed row would
            otherwise open with a picture and no context. */}
        {reverse && !isMobile ? <>{pic}{text}</> : <>{text}{pic}</>}
      </div>
    </Card>
  );
}

// The four pillars from the public page, in the second person — they're already
// a client, so "your team" and "your content", not "organisations that…".
const PILLARS = [
  {
    Icon: PiggyBank,
    title: 'A predictable monthly budget',
    body: 'One agreed monthly figure instead of a quote per project. Easier to get signed off once, and easier to plan a year of content around.',
  },
  {
    Icon: Shuffle,
    title: 'Credits you can spend how you like',
    body: 'Unused credit banks up. Spend it on a long piece, a run of short ones, cutdowns, versions or updates — whatever the month actually calls for.',
  },
  {
    Icon: Zap,
    title: 'Faster turnaround',
    body: 'We hold production capacity for you in advance, so your work starts sooner and moves through fewer steps to get going.',
  },
  {
    Icon: TrendingDown,
    title: 'Better value the more you make',
    body: 'Your style, characters and assets carry across everything, so each video costs less to make than the one before — and you get that back in the rate.',
  },
];

export default function Partner() {
  const { showToast } = usePortal();
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [minutes, setMinutes] = useState(null);
  const [date, setDate] = useState('');
  const [timeOfDay, setTimeOfDay] = useState('either');
  const [note, setNote] = useState('');

  const load = async () => {
    try { setData(await portalApi.get('partner')); }
    catch (err) { setError(err.message); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!minutes) { showToast('Pick roughly how much video you need each month.'); return; }
    setBusy(true);
    try {
      const res = await portalApi.post('partner-enquire', {
        minutesPerMonth: minutes, preferredDate: date || null, preferredTime: timeOfDay, note: note.trim() || null,
      });
      setData((d) => ({ ...d, enquiry: res.enquiry }));
      setEditing(false);
      showToast('Thanks — we\'ll be in touch to confirm 🎉');
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Editing an existing enquiry starts from what they told us, not from blank.
  const startEditing = () => {
    const e = data?.enquiry;
    if (e) {
      setMinutes(e.minutesPerMonth || null);
      setDate(e.preferredDate ? String(e.preferredDate).slice(0, 10) : '');
      setTimeOfDay(e.preferredTime || 'either');
    }
    setEditing(true);
  };

  if (error) {
    return <Card><EmptyState title="Couldn't load the Partner Programme" body={error} /></Card>;
  }
  if (!data) return <div style={{ color: BRAND.muted, fontSize: 13, padding: 30, textAlign: 'center' }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* ── The offer ── */}
      <div style={{
        background: 'linear-gradient(135deg, #0B2740 0%, #123A5A 100%)',
        borderRadius: 14, padding: '26px 26px 24px', color: 'white',
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, background: '#2BB8E633',
          color: '#7FDBFF', fontSize: 11, fontWeight: 800, letterSpacing: 0.5,
          textTransform: 'uppercase', padding: '4px 10px', borderRadius: 5, marginBottom: 12,
        }}>
          <Handshake size={13} /> Partner Programme
        </div>
        <h1 style={{ margin: '0 0 8px', fontSize: 25, fontWeight: 800, lineHeight: 1.2 }}>
          Bank flexible video credits every month
        </h1>
        <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, opacity: 0.92, maxWidth: 620 }}>
          Instead of re-quoting every project, subscribe and bank monthly credits. Use them for
          new videos, edits, cutdowns, versions or updates — at your pace.
        </p>
        <div style={{
          marginTop: 16, display: 'inline-block', background: '#FFFFFF14',
          border: '1px solid #FFFFFF2E', borderRadius: 8, padding: '8px 14px',
          fontSize: 13.5, fontWeight: 700,
        }}>
          1 video credit = 60 seconds of finished video
        </div>
      </div>

      {/* Ben explaining it, straight after the promise and before the detail —
          the same order the public page uses, because most people would rather
          be told than read. Omitted entirely until a video is set. */}
      <VideoBlock video={data.video} />

      {/* ── Why ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12 }}>
        {PILLARS.map(({ Icon, title, body }) => (
          <Card key={title}>
            <Icon size={20} color={BRAND.blue} />
            <div style={{ fontSize: 14.5, fontWeight: 700, color: BRAND.ink, margin: '10px 0 5px' }}>{title}</div>
            <div style={{ fontSize: 13, color: BRAND.muted, lineHeight: 1.55 }}>{body}</div>
          </Card>
        ))}
      </div>

      {/* ── The explainer sections, mirroring squideo.com/partner-programme ── */}
      <Split
        isMobile={isMobile}
        title="What are video credits?"
        image="/partner/what-are-credits.png"
        imageAlt="Video credits spent across clarity, conversion and SEO"
      >
        <p style={{ margin: '0 0 14px' }}>
          Video credits are <strong>pre-purchased production time</strong> you can use across
          different types of video work.
        </p>
        <p style={{ margin: '0 0 8px' }}>Think of it like a content account:</p>
        <ul style={{ margin: '0 0 14px', paddingLeft: 20 }}>
          <li style={{ marginBottom: 4 }}>You pay a fixed monthly amount</li>
          <li>You receive a set amount of credits</li>
        </ul>
        <p style={{ margin: 0 }}>You spend credits on whatever video output you need most.</p>
      </Split>

      <Split
        isMobile={isMobile}
        reverse
        title="What can credits be used for?"
        image="/partner/what-credits-do.png"
        imageAlt="A video being edited for focal point, call to action and pace"
      >
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {CREDIT_USES.map((u) => <li key={u} style={{ marginBottom: 6 }}>{u}</li>)}
        </ul>
      </Split>

      {/* ── How it works ── */}
      <div>
        <h2 style={{ margin: '4px 0 14px', fontSize: 19, fontWeight: 800, color: BRAND.ink, textAlign: 'center' }}>
          How it works
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 12 }}>
          {STEPS.map((s, i) => (
            <Card key={s.title}>
              <div style={{
                width: 28, height: 28, borderRadius: 999, background: BRAND.blue, color: '#0F2A3D',
                display: 'grid', placeItems: 'center', fontSize: 13.5, fontWeight: 800, marginBottom: 10,
              }}>
                {i + 1}
              </div>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: BRAND.ink, marginBottom: 5 }}>{s.title}</div>
              <div style={{ fontSize: 13, color: BRAND.muted, lineHeight: 1.55 }}>{s.body}</div>
            </Card>
          ))}
        </div>
      </div>

      {/* ── The three promises that decide whether it's safe to commit ── */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 12 }}>
        {ASSURANCES.map(({ Icon, title, body }) => (
          <Card key={title}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Icon size={17} color="#16A34A" />
              <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>{title}</span>
            </div>
            <div style={{ fontSize: 13, color: BRAND.muted, lineHeight: 1.55 }}>{body}</div>
          </Card>
        ))}
      </div>

      <Card>
        <p style={{ margin: 0, fontSize: 13.5, color: BRAND.ink, lineHeight: 1.6 }}>
          It's built for teams that want <strong>consistent, ongoing video</strong> without starting
          from scratch each time. We'll build the plan around what you're actually making —
          <strong> there's no fixed package to fit into</strong>, which is why the next step is a
          conversation rather than a price list.
        </p>
      </Card>

      {/* ── Tell us what you need ──
          Two questions and a date, not a calendar. See the route comment in
          api/portal.js for why this doesn't book a real slot. */}
      {data.enquiry && !editing ? (
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: '#DCFCE7', color: '#16A34A', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Check size={20} />
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontSize: 15.5, fontWeight: 800, color: BRAND.ink, marginBottom: 4 }}>
                We've got your details
              </div>
              <div style={{ fontSize: 13.5, color: BRAND.ink, lineHeight: 1.6 }}>
                {data.enquiry.minutesLabel || MINUTES_OPTIONS.find((m) => m.value === data.enquiry.minutesPerMonth)?.label}
                {data.enquiry.preferredDate && (
                  <> · you're free <strong>{longDate(data.enquiry.preferredDate)}</strong>
                    {data.enquiry.preferredTime && data.enquiry.preferredTime !== 'either'
                      ? ` (${data.enquiry.preferredTime})` : ''}</>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: BRAND.muted, marginTop: 4 }}>
                Someone from the team will email you to confirm the time.
              </div>
              <button className="btn-ghost" style={{ marginTop: 12 }} onClick={startEditing}>
                Change my answers
              </button>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <div style={{ fontSize: 15.5, fontWeight: 800, color: BRAND.ink, marginBottom: 3 }}>
            Talk it through with us
          </div>
          <p style={{ margin: '0 0 18px', fontSize: 13.5, color: BRAND.muted, lineHeight: 1.55 }}>
            Two quick questions and we'll come back to you with a plan built around what you're
            actually making. No obligation.
          </p>

          <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink, marginBottom: 8 }}>
            Roughly how much video do you need each month?
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
            {MINUTES_OPTIONS.map((m) => {
              const on = minutes === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMinutes(m.value)}
                  style={{
                    padding: '8px 14px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                    fontSize: 13, fontWeight: on ? 700 : 500,
                    background: on ? BRAND.blue : 'white',
                    color: on ? '#0F2A3D' : BRAND.ink,
                    border: '1px solid ' + (on ? BRAND.blue : '#D5DEE5'),
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          <div style={{ fontSize: 13.5, fontWeight: 700, color: BRAND.ink, marginBottom: 8 }}>
            When suits you for a chat?
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <input
              type="date"
              className="input"
              value={date}
              min={todayISO()}
              onChange={(e) => setDate(e.target.value)}
              style={{ maxWidth: 200 }}
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {TIME_OPTIONS.map((t) => {
                const on = timeOfDay === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setTimeOfDay(t.value)}
                    style={{
                      padding: '7px 13px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                      fontSize: 12.5, fontWeight: on ? 700 : 500,
                      background: on ? '#EAF7FC' : 'white',
                      color: on ? '#0B6E93' : BRAND.muted,
                      border: '1px solid ' + (on ? '#9FDCEF' : '#D5DEE5'),
                    }}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 18 }}>
            A day is enough — we'll email you to fix the exact time.
          </div>

          <label style={{ display: 'block', fontSize: 12.5, color: BRAND.muted, marginBottom: 18 }}>
            Anything else we should know? (optional)
            <textarea
              className="input"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What you're planning to make, who else needs to be on the call…"
              style={{ width: '100%', marginTop: 5, resize: 'vertical' }}
            />
          </label>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn" disabled={busy || !minutes} onClick={submit}>
              <CalendarClock size={14} /> {busy ? 'Sending…' : 'Send my details'}
            </button>
            {editing && data.enquiry && (
              <button className="btn-ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
