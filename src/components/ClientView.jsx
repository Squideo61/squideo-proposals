import React, { useEffect, useRef, useState } from 'react';
import {
  Archive, Award, CalendarClock, Calendar, Captions, Check, ChevronLeft, Download,
  FileDown, FileText, Globe, LayoutGrid, Link2, Mic, Music, Palette, PenLine, Phone,
  RefreshCw, Rocket, Share2, Smartphone, Sparkles, Users
} from 'lucide-react';
import { BRAND, CONFIG, DEFAULT_PHOTOS } from '../theme.js';
import { SQUIDEO_LOGO, NEXT_STEPS, extraHasVariants } from '../defaults.js';
import { useStore } from '../store.jsx';
import { formatGBP, sendNotification, useIsMobile } from '../utils.js';
import { openPrintWindow, openReceiptWindow, printOptionsForSigned } from '../utils/printProposal.js';
import { startStripeCheckout } from '../utils/stripeCheckout.js';
import { Field, PageTitle, PaymentOption, PriceRow, StickyCTA } from './ui.jsx';
import { SignedBlock } from './SignedBlock.jsx';
import { StripeSimModal } from './StripeSimModal.jsx';

function getEmbedUrl(url) {
  if (!url) return null;
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (yt) return 'https://www.youtube.com/embed/' + yt[1];
  const vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return 'https://player.vimeo.com/video/' + vimeo[1];
  return url;
}

const INCLUSION_ICON_RULES = [
  [/script|copy(?!right)|narrative/i, PenLine],
  [/storyboard|slide\s*deck/i, LayoutGrid],
  [/voiceover|voice\s*artist/i, Mic],
  [/music|sound/i, Music],
  [/revis|amend/i, RefreshCw],
  [/timeline|schedule|turnaround/i, Calendar],
  [/kick.?off/i, Rocket],
  [/style|visual\s*direction|palette/i, Palette],
  [/logo/i, Sparkles],
  [/ownership|rights|licens/i, Award],
  [/storage|futureproof|archive|file/i, Archive],
  [/subtitle|caption/i, Captions],
  [/portrait|mobile|reels|tiktok/i, Smartphone],
  [/delivery|format|export|download/i, Download],
  [/share|platform|review/i, Share2],
  [/meeting|team|follow.?up/i, Users],
  [/word|narrative|140/i, FileText],
];

function iconForInclusion(title) {
  if (!title) return Check;
  for (const [pattern, Icon] of INCLUSION_ICON_RULES) {
    if (pattern.test(title)) return Icon;
  }
  return Check;
}

function parseDateUK(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  let [, dd, mm, yyyy] = m;
  if (yyyy.length === 2) yyyy = '20' + yyyy;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  return isNaN(d.getTime()) ? null : d;
}

function FutureRateCell({ label, value, muted, highlight, strike }) {
  return (
    <div style={{
      background: highlight ? '#FFFAEB' : '#F8FAFC',
      border: '1px solid ' + (highlight ? '#FDE68A' : '#E5E9EE'),
      borderRadius: 8,
      padding: '8px 10px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#6B7785', marginBottom: 4 }}>{label}</div>
      <div style={{
        fontSize: 14,
        fontWeight: 700,
        color: highlight ? '#92400E' : (muted ? '#6B7785' : '#0F2A3D'),
        textDecoration: strike ? 'line-through' : 'none',
        textDecorationColor: '#94A3B8',
      }}>
        {value}
      </div>
    </div>
  );
}

// Parse the partner-programme description (a `\n`-delimited string with
// dash-bullets) into structured JSX: paragraphs, sub-headings, and bullet lists.
// Render-time only — the underlying string in defaults / proposal data is
// unchanged so the team can keep editing copy in the BuilderView naturally.
function renderDescriptionMarkup(text) {
  if (!text) return null;
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let buffer = []; // current run of text lines (a paragraph)
  let listItems = []; // current run of bullet lines

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const joined = buffer.join(' ').trim();
    if (!joined) { buffer = []; return; }
    // Detect "Heading:" pattern (line ending with `:`)
    if (buffer.length === 1 && /:\s*$/.test(buffer[0].trim())) {
      blocks.push({ kind: 'heading', text: joined });
    } else {
      blocks.push({ kind: 'paragraph', text: joined });
    }
    buffer = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push({ kind: 'list', items: listItems });
    listItems = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushBuffer();
      flushList();
      continue;
    }
    const bullet = line.match(/^[-•]\s*(.+)$/);
    if (bullet) {
      flushBuffer();
      listItems.push(bullet[1].trim());
    } else {
      flushList();
      buffer.push(line);
    }
  }
  flushBuffer();
  flushList();

  return blocks.map((b, i) => {
    if (b.kind === 'heading') {
      return (
        <h4 key={i} style={{ fontSize: 14, fontWeight: 700, color: '#0F2A3D', margin: i === 0 ? '0 0 6px' : '14px 0 6px' }}>
          {b.text}
        </h4>
      );
    }
    if (b.kind === 'list') {
      return (
        <ul key={i} style={{ margin: '0 0 10px', paddingLeft: 22, color: BRAND.muted, fontSize: 13, lineHeight: 1.7 }}>
          {b.items.map((item, j) => (
            <li key={j} style={{ marginBottom: 2 }}>{item}</li>
          ))}
        </ul>
      );
    }
    return (
      <p key={i} style={{ margin: i === 0 ? '0 0 10px' : '10px 0', fontSize: 13, color: BRAND.muted, lineHeight: 1.7 }}>
        {b.text}
      </p>
    );
  });
}

function validityLabel(dateStr, days, expiryDateISO) {
  if (expiryDateISO) {
    const d = new Date(expiryDateISO);
    if (!isNaN(d)) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const start = parseDateUK(dateStr);
  if (!start || !days) return null;
  const expiry = new Date(start);
  expiry.setDate(expiry.getDate() + Number(days));
  return expiry.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ClientView({ id, onBack, useRealStripe = false, onSigned }) {
  const { state, actions, showMsg } = useStore();
  const data = state.proposals[id];
  const isPreview = !useRealStripe;
  const storeSigned = state.signatures[id] || null;
  const storePayment = state.payments[id] || null;
  // In preview mode, any "signature" is local-only — never persisted.
  const [previewSigned, setPreviewSigned] = useState(null);
  const signed = isPreview && previewSigned ? previewSigned : storeSigned;
  const payment = storePayment;

  // Track viewing session: open + heartbeat (active time only) + close beacon
  // Only fires for real client views (public URL). Internal previews from the
  // dashboard skip tracking so they don't pollute analytics or trigger the
  // first-view notification email.
  useEffect(() => {
    if (!data || !useRealStripe) return;
    const sessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    let active = 0;
    let lastTick = Date.now();

    const post = (durationSeconds) => {
      try {
        fetch('/api/views/' + id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, durationSeconds }),
          keepalive: true,
        }).catch(() => {});
      } catch { /* ignore */ }
    };

    post(0); // initial open

    const tick = () => {
      if (document.visibilityState === 'visible') {
        active += Math.round((Date.now() - lastTick) / 1000);
        post(active);
      }
      lastTick = Date.now();
    };
    const heartbeat = setInterval(tick, 15000);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') tick();
      else lastTick = Date.now();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const finalSend = () => {
      const final = active + (document.visibilityState === 'visible'
        ? Math.round((Date.now() - lastTick) / 1000)
        : 0);
      try {
        const blob = new Blob(
          [JSON.stringify({ sessionId, durationSeconds: final })],
          { type: 'application/json' }
        );
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/views/' + id, blob);
        } else {
          post(final);
        }
      } catch { /* ignore */ }
    };
    window.addEventListener('pagehide', finalSend);

    return () => {
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', finalSend);
      finalSend();
    };
  }, [id, data, useRealStripe]);

  const [selectedVideoOptionIdx, setSelectedVideoOptionIdx] = useState(0);
  const [selectedExtras, setSelectedExtras] = useState({});
  const [extrasMeta, setExtrasMeta] = useState({});
  const getMeta = (eid) => extrasMeta[eid] || { quantity: 1, languages: '' };
  const setMeta = (eid, patch) => setExtrasMeta(prev => ({ ...prev, [eid]: { ...getMeta(eid), ...patch } }));
  const [partnerSelected, setPartnerSelected] = useState(false);
  const [partnerCredits, setPartnerCredits] = useState(1);
  const [paymentOption, setPaymentOption] = useState(() => {
    const opts = data?.paymentOptions || ['5050', 'full'];
    return opts[0];
  });

  // Partner Programme unlocks its discount only on full payment (or PO).
  // When the client opts in, bump them off 50/50 onto the next available option.
  useEffect(() => {
    if (!partnerSelected || signed || paymentOption !== '5050') return;
    const opts = data?.paymentOptions || ['5050', 'full'];
    const next = opts.find(o => o !== '5050') || 'full';
    setPaymentOption(next);
  }, [partnerSelected, signed, paymentOption, data]);
  const [sigName, setSigName] = useState('');
  const [sigEmail, setSigEmail] = useState('');
  const [sigAccepted, setSigAccepted] = useState(false);
  const [paymentChoice, setPaymentChoice] = useState(null);
  const isMobile = useIsMobile();
  const signRef = useRef(null);

  const scrollToSign = () => {
    if (!signRef.current) return;
    const reduceMotion = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
    signRef.current.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  };

  if (!data) {
    if (state.loading) {
      return (
        <div style={{ minHeight: '60vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 60, gap: 20 }}>
          <img src={SQUIDEO_LOGO} alt="Squideo" style={{ width: 140, height: 'auto', opacity: 0.95, animation: 'squideo-pulse 1.6s ease-in-out infinite' }} />
          <style>{`@keyframes squideo-pulse { 0%, 100% { opacity: 0.55; transform: scale(0.98); } 50% { opacity: 1; transform: scale(1); } }`}</style>
        </div>
      );
    }
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        Proposal not found.
        <div style={{ marginTop: 16 }}><button onClick={onBack} className="btn-ghost">Back</button></div>
      </div>
    );
  }

  // Render a 0–1 discount rate as a tidy percentage: whole numbers without
  // decimals (15%) and half/quarter steps with one decimal place (17.5%).
  const formatPct = (rate) => {
    const pct = Math.round(rate * 1000) / 10;
    return pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1);
  };

  const videoOptions = Array.isArray(data.videoOptions) && data.videoOptions.length >= 2
    ? data.videoOptions : null;
  const effectiveBasePrice = videoOptions
    ? (videoOptions[selectedVideoOptionIdx]?.price ?? data.basePrice)
    : data.basePrice;

  const extrasTotal = data.optionalExtras.reduce((s, e) => {
    if (!selectedExtras[e.id]) return s;
    const qty = extraHasVariants(e) ? Math.max(1, Number(getMeta(e.id).quantity) || 1) : 1;
    return s + e.price * qty;
  }, 0);
  const subtotal = effectiveBasePrice + extrasTotal;
  const vat = subtotal * data.vatRate;
  const total = subtotal + vat;
  // Tiered project-discount ladder: base + (extra * (credits-1)), capped at max.
  // Legacy proposals (no extraDiscountPerCredit / maxDiscount) collapse to a flat
  // discountRate because extraPerCredit defaults to 0 and max defaults to base.
  const partnerBaseDiscount   = data.partnerProgramme.discountRate          ?? 0.10;
  const partnerExtraPerCredit = data.partnerProgramme.extraDiscountPerCredit ?? 0;
  const partnerMaxDiscount    = data.partnerProgramme.maxDiscount            ?? partnerBaseDiscount;
  const effectiveDiscount = Math.min(
    partnerBaseDiscount + Math.max(0, partnerCredits - 1) * partnerExtraPerCredit,
    partnerMaxDiscount
  );
  // Per-minute partner rate is derived from the standard rate per minute
  // (independent of basePrice — basePrice is the project price, not a per-min
  // rate) times the live tier-ladder discount. Falls back to basePrice for
  // legacy proposals saved before standardRatePerMin existed.
  const standardRatePerMin = Number(data.partnerProgramme?.standardRatePerMin) || Number(data.basePrice) || 0;
  const partnerRatePerMin = standardRatePerMin * (1 - effectiveDiscount);
  const partnerSubtotal = partnerRatePerMin * partnerCredits;
  const partnerVat = partnerSubtotal * data.vatRate;
  const partnerTotal = partnerSubtotal + partnerVat;
  const partnerDiscount = subtotal * effectiveDiscount;
  const discountedSubtotal = subtotal - partnerDiscount;
  const discountedVat = discountedSubtotal * data.vatRate;
  const discountedTotal = discountedSubtotal + discountedVat;
  // Combined "due today" when client opts into the Partner Programme:
  // discounted project + first month of the partner subscription.
  const dueNowTotal = partnerSelected ? (discountedTotal + partnerTotal) : total;
  const incVat = (n) => formatGBP(n * (1 + (data.vatRate || 0)));

  const handleSign = async () => {
    if (!sigName.trim() || !sigEmail.trim() || !sigAccepted) {
      showMsg('Please complete name, email and tick the acceptance box.');
      return;
    }
    const sig = {
      name: sigName,
      email: sigEmail,
      signedAt: new Date().toISOString(),
      selectedExtras: data.optionalExtras
        .filter((e) => selectedExtras[e.id])
        .map((e) => extraHasVariants(e)
          ? { ...e, variantsEnabled: true, quantity: Math.max(1, Number(getMeta(e.id).quantity) || 1), languages: getMeta(e.id).languages || '' }
          : e),
      ...(videoOptions ? { selectedVideoOption: videoOptions[selectedVideoOptionIdx] } : {}),
      partnerSelected,
      partnerCredits,
      paymentOption,
      total: dueNowTotal,
      partnerTotal: partnerSelected ? partnerTotal : 0,
      amountBreakdown: partnerSelected ? {
        projectExVat: discountedSubtotal,
        projectTotal: discountedTotal,
        partnerExVat: partnerSubtotal,
        partnerTotal,
        partnerCredits,
        discountRate: effectiveDiscount,
        vatRate: data.vatRate,
      } : null,
    };

    if (isPreview) {
      setPreviewSigned(sig);
      showMsg('Signature simulated - preview only, not saved');
      return;
    }

    actions.saveSignature(id, sig);

    if (onSigned) onSigned(sig);

    const n = await sendNotification('signed', data, sig, null, state.notificationRecipients);
    if (n > 0) showMsg('Proposal accepted! Team notified (' + n + ').');
    else showMsg('Proposal accepted!');
  };

  const handlePayNow = async ({ billing } = {}) => {
    if (!useRealStripe) {
      showMsg('Payments are disabled in preview mode');
      return;
    }
    setPaymentChoice('processing');
    try {
      await startStripeCheckout({ proposalId: id, signed, billing });
    } catch (err) {
      console.error('[stripe checkout]', err);
      setPaymentChoice(null);
      showMsg(err?.message ? 'Checkout error: ' + err.message : 'Could not start checkout. Please try again.');
    }
  };

  const handlePoConfirm = async ({ billing }) => {
    if (isPreview) {
      showMsg('PO quote issuance simulated - preview only, not saved');
      return;
    }
    try {
      const res = await fetch(`/api/po/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billing }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || ('PO quote failed: ' + res.status));
      }
      showMsg('PO quote sent.');
    } catch (err) {
      console.error('[po confirm]', err);
      showMsg(err?.message ? 'Could not issue quote: ' + err.message : 'Could not issue quote. Please try again.');
      throw err;
    }
  };

  const handleConfirmInvoice = async ({ billing }) => {
    if (isPreview) {
      showMsg('Invoice issuance simulated - preview only, not saved');
      return;
    }
    try {
      const res = await fetch('/api/xero/invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId: id, billing }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || ('Invoice issue failed: ' + res.status));
      }
      showMsg('Invoice sent.');
    } catch (err) {
      console.error('[invoice issue]', err);
      showMsg(err?.message ? 'Could not issue invoice: ' + err.message : 'Could not issue invoice. Please try again.');
      throw err;
    }
  };

  const confirmStripeSim = async () => {
    const amountDue = signed.paymentOption === '5050' ? signed.total / 2 : signed.total;
    const isDeposit = signed.paymentOption === '5050';
    const p = {
      amount: amountDue,
      paymentType: isDeposit ? 'deposit' : 'full',
      paidAt: new Date().toISOString(),
      stripeSessionId: 'sim_' + Date.now(),
      customerEmail: signed.email
    };
    actions.savePayment(id, p);
    setPaymentChoice(null);
    const n = await sendNotification('paid', data, signed, p, state.notificationRecipients);
    if (n > 0) showMsg('Payment received! Team notified.');
    else showMsg('Payment received!');
  };

  return (
    <div style={{ background: BRAND.paper, minHeight: '100vh' }}>
      {isPreview && (
        <div style={{ position: 'sticky', top: 0, background: 'white', borderBottom: '1px solid ' + BRAND.border, padding: '12px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 100 }}>
          {onBack ? <button onClick={onBack} className="btn-ghost"><ChevronLeft size={16} /> Back</button> : <div />}
          <div style={{ fontSize: 12, color: '#92400E', fontWeight: 700, letterSpacing: 0.5 }}>
            PREVIEW MODE
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => {
                const url = 'https://squideo-proposals-tu96.vercel.app/?proposal=' + id;
                navigator.clipboard.writeText(url)
                  .then(() => showMsg('Link copied to clipboard'))
                  .catch(() => showMsg('Copy failed — link: ' + url));
              }}
              className="btn-ghost"
              style={{ fontSize: 13 }}
            >
              <Link2 size={14} /> Copy link
            </button>
            <button
              onClick={() => openPrintWindow(
                data,
                signed
                  ? printOptionsForSigned(signed, payment)
                  : { signable: true, selectedExtras, selectedExtrasMeta: extrasMeta, paymentOption, partnerSelected }
              )}
              className="btn-ghost"
              style={{ fontSize: 13 }}
            >
              <FileDown size={14} /> {signed ? 'Download signed copy' : 'Download PDF'}
            </button>
          </div>
        </div>
      )}

      {isPreview && (
        <div style={{ background: '#FEF3C7', borderBottom: '1px solid #FDE68A', color: '#78350F', padding: '10px 24px', fontSize: 13, lineHeight: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <strong>Preview mode</strong> - changes are not saved. You can simulate the client experience (selections, signature, payment), but nothing here will affect the live proposal or notify the team.
          </div>
          {previewSigned && (
            <button
              onClick={() => { setPreviewSigned(null); showMsg('Simulated signature cleared'); }}
              className="btn-ghost"
              style={{ fontSize: 12, padding: '6px 12px' }}
            >
              Clear simulated signature
            </button>
          )}
        </div>
      )}

      <div style={{ maxWidth: 960, margin: '0 auto', padding: signed ? '32px 24px 80px' : '32px 24px 140px', background: 'white' }}>
        <div style={{ background: BRAND.blue, color: 'white', padding: 32, borderRadius: 12, marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
            <img src={SQUIDEO_LOGO} alt="Squideo" style={{ height: 48, width: 'auto', display: 'block' }} />
          </div>
          <h1 style={{ fontSize: isMobile ? 20 : 28, fontWeight: 700, margin: '0 0 16px', lineHeight: 1.2 }}>{(data.proposalTitle && data.proposalTitle.trim()) || 'Explainer Video Proposal'}</h1>
          <div style={{ fontSize: isMobile ? 13 : 16, opacity: 0.95, lineHeight: 1.6 }}>
            <div>Prepared for <strong>{data.clientName || '[Client Name]'}</strong></div>
            <div>{data.contactBusinessName || '[Business Name]'}</div>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, opacity: 0.85 }}>{data.date}</span>
              {(() => {
                const expiry = validityLabel(data.date, data.validityDays, data.expiryDate);
                if (!expiry) return null;
                return (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.35)', color: 'white', padding: '3px 10px', borderRadius: 999 }}>
                    <CalendarClock size={12} /> Valid until {expiry}
                  </span>
                );
              })()}
            </div>
          </div>
          <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid rgba(255,255,255,0.25)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, fontSize: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {DEFAULT_PHOTOS[data.preparedBy] && (
                <img src={DEFAULT_PHOTOS[data.preparedBy]} alt={data.preparedBy} style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', border: '2px solid rgba(255,255,255,0.4)', flexShrink: 0 }} />
              )}
              <div>
                <div>By <strong>{data.preparedBy}</strong></div>
                {data.preparedByTitle && <div style={{ fontSize: 12, opacity: 0.8 }}>{data.preparedByTitle}</div>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16 }}>
              <span><Globe size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />{CONFIG.company.website}</span>
              <span><Phone size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />{CONFIG.company.phone}</span>
            </div>
          </div>
        </div>

        {data.clientLogo && (
          <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: '32px 24px', marginBottom: 32, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Prepared for</div>
            <img src={data.clientLogo} alt="Client logo" style={{ maxWidth: '100%', maxHeight: 120, objectFit: 'contain' }} />
            {data.contactBusinessName && (
              <div style={{ fontSize: 14, color: BRAND.muted, fontWeight: 500 }}>{data.contactBusinessName}</div>
            )}
          </div>
        )}

        <PageTitle>{data.contactBusinessName ? `${data.contactBusinessName}, thank you for considering Squideo as your creative partner` : 'Thank you for considering Squideo as your creative partner'}</PageTitle>
        {data.intro.split('\n\n').map((p, i) => (
          <p key={i} style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 12 }}>{p}</p>
        ))}

        <PageTitle>Your Delivery Team</PageTitle>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: 16, marginBottom: 16 }}>
          {data.team.map((m, i) => {
            const photoSrc = m.photo || DEFAULT_PHOTOS[m.name];
            return (
              <div key={i} style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  {photoSrc ? (
                    <img src={photoSrc} alt={m.name} style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', border: '2px solid ' + BRAND.blue }} />
                  ) : (
                    <div style={{ width: 56, height: 56, borderRadius: '50%', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 20 }}>
                      {m.name[0]}
                    </div>
                  )}
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{m.name}</div>
                    <div style={{ fontSize: 12, color: BRAND.muted }}>{m.role}</div>
                  </div>
                </div>
                <p style={{ fontSize: 13, color: BRAND.muted, lineHeight: 1.5, margin: 0 }}>{m.bio}</p>
              </div>
            );
          })}
        </div>
        <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 20, marginBottom: 32, display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
          <img src="/team-photos/producers.png" alt="Our Production Team" style={{ width: isMobile ? '100%' : 220, maxWidth: '100%', borderRadius: 10, objectFit: 'cover' }} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>Our Producers</div>
            <p style={{ fontSize: 13, color: BRAND.muted, lineHeight: 1.5, margin: 0 }}>Our experienced producers will be involved throughout the production process, each contributing their expertise to ensure the highest standard of work. You'll have the opportunity to communicate with them directly at key stages of the project, from initial planning through to final delivery. Every member of our production team takes pride in delivering exceptional results that reflect Squideo's commitment to quality and creativity.</p>
          </div>
        </div>

        <PageTitle>Your Requirement</PageTitle>
        {videoOptions ? (
          <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
            {videoOptions.map((opt, i) => (
              <label key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 16px', borderBottom: i < videoOptions.length - 1 ? '1px solid ' + BRAND.border : 'none', cursor: signed ? 'default' : 'pointer', background: selectedVideoOptionIdx === i ? '#F0F9FF' : 'white' }}>
                <input
                  type="radio"
                  name="videoOption"
                  checked={selectedVideoOptionIdx === i}
                  onChange={() => setSelectedVideoOptionIdx(i)}
                  disabled={!!signed}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: opt.description ? 6 : 0 }}>{opt.label || `Option ${i + 1}`}</div>
                  {opt.description && <p style={{ fontSize: 14, lineHeight: 1.7, margin: 0, whiteSpace: 'pre-wrap', color: BRAND.text }}>{opt.description}</p>}
                </div>
                <span style={{ fontSize: 14, fontWeight: 600, flexShrink: 0, paddingTop: 2 }}>{formatGBP(opt.price)} <span style={{ fontWeight: 400, fontSize: 12, color: BRAND.muted }}>+ VAT</span></span>
              </label>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 12, fontWeight: 500, whiteSpace: 'pre-wrap' }}>{data.requirement}</p>
        )}
        {data.projectVision && (
          <>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginTop: 20, marginBottom: 8 }}>Project Vision</h3>
            <p style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{data.projectVision}</p>
          </>
        )}

        {data.showProcessVideo !== false && data.processVideoUrl && (() => {
          const embedUrl = getEmbedUrl(data.processVideoUrl);
          return (
            <div style={{ marginBottom: 32 }}>
              <PageTitle>Production Process</PageTitle>
              <p style={{ fontSize: 14, color: BRAND.muted, marginBottom: 16, lineHeight: 1.6 }}>Here is a detailed overview of our proven production process:</p>
              <div style={{ position: 'relative', paddingBottom: '56.25%', borderRadius: 10, overflow: 'hidden' }}>
                <iframe
                  src={embedUrl}
                  title="Production Process"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' }}
                />
              </div>
            </div>
          );
        })()}

        <PageTitle>Your Quote</PageTitle>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>What's included:</h3>
        <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16, marginBottom: 16 }}>
          {data.baseInclusions.map((inc, i) => {
            const Icon = iconForInclusion(inc.title);
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0', fontSize: 14, borderBottom: i < data.baseInclusions.length - 1 ? '1px solid ' + BRAND.border : 'none' }}>
                <span style={{ flexShrink: 0, marginTop: 1, width: 28, height: 28, borderRadius: 8, background: BRAND.blue + '14', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon size={16} color={BRAND.blue} strokeWidth={2.25} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{inc.title}</div>
                  {inc.description && (
                    <div style={{ fontSize: 13, color: BRAND.muted, lineHeight: 1.5, marginTop: 3 }}>{inc.description}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '14px 16px', border: '1px solid ' + BRAND.border, borderRadius: 10, fontSize: 16, fontWeight: 700 }}>
          <span>
            {videoOptions ? (videoOptions[selectedVideoOptionIdx]?.label || `Option ${selectedVideoOptionIdx + 1}`) : 'Project base price'}
          </span>
          <span>{formatGBP(effectiveBasePrice)} <span style={{ fontWeight: 500, fontSize: 13, color: BRAND.muted }}>+ VAT</span></span>
        </div>

        <PageTitle>Optional Extras</PageTitle>
        <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden', marginBottom: 24 }}>
          {data.optionalExtras.map((extra, i) => {
            const isSelected = !!selectedExtras[extra.id];
            const meta = getMeta(extra.id);
            const variantsOn = extraHasVariants(extra);
            const qty = variantsOn ? Math.max(1, Number(meta.quantity) || 1) : 1;
            const showVariants = variantsOn && isSelected;
            return (
              <div key={extra.id} style={{ borderBottom: i < data.optionalExtras.length - 1 ? '1px solid ' + BRAND.border : 'none', background: isSelected ? '#F0F9FF' : 'white' }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 16px', cursor: signed ? 'default' : 'pointer' }}>
                  <input type="checkbox" checked={isSelected} onChange={(e) => setSelectedExtras({ ...selectedExtras, [extra.id]: e.target.checked })} disabled={!!signed} style={{ marginTop: 3 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{extra.label}</div>
                    {extra.description && <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.5, marginTop: 4 }}>{extra.description}</div>}
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 600, flexShrink: 0, textAlign: 'right' }}>
                    {variantsOn
                      ? (isSelected
                          ? <>{formatGBP(extra.price * qty)}<div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 500 }}>{formatGBP(extra.price)} × {qty}</div></>
                          : <>{formatGBP(extra.price)}<div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 500 }}>per language</div></>)
                      : formatGBP(extra.price)}
                  </span>
                </label>
                {showVariants && (
                  <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: '0 16px 14px 44px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, color: BRAND.muted }}>How many languages?</span>
                      <button type="button" disabled={!!signed || qty <= 1} onClick={() => setMeta(extra.id, { quantity: qty - 1 })} className="btn-icon" aria-label="Decrease languages">−</button>
                      <input
                        type="number"
                        min={1}
                        value={qty}
                        disabled={!!signed}
                        onChange={(e) => setMeta(extra.id, { quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                        className="input"
                        style={{ width: 56, textAlign: 'center', padding: '4px 6px' }}
                      />
                      <button type="button" disabled={!!signed} onClick={() => setMeta(extra.id, { quantity: qty + 1 })} className="btn-icon" aria-label="Increase languages">+</button>
                    </div>
                    <input
                      type="text"
                      placeholder="Which languages? (optional, e.g. French, German, Spanish)"
                      value={meta.languages || ''}
                      disabled={!!signed}
                      onChange={(e) => setMeta(extra.id, { languages: e.target.value })}
                      className="input"
                      style={{ flex: '1 1 240px', minWidth: 200, fontSize: 13 }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {data.partnerProgramme.enabled && (
          <div style={{ position: 'relative', marginTop: 24, marginBottom: 16, background: '#FFFAEB', border: '1px solid #C9A227', borderRadius: 12, padding: 16 }}>
            <span style={{ position: 'absolute', top: -16, right: 16, background: 'linear-gradient(135deg, #FFD700 0%, #C9A227 50%, #8B6914 100%)', color: 'white', fontSize: 14, fontWeight: 700, padding: '6px 14px', borderRadius: 999, boxShadow: '0 2px 8px rgba(146, 64, 14, 0.35), inset 0 1px 0 rgba(255,255,255,0.3)', textShadow: '0 1px 2px rgba(0,0,0,0.35)', letterSpacing: 0.3 }}>
              Opt in today and save {formatGBP(partnerDiscount)} on this project
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <img
                src="/partner-logo.png"
                alt=""
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                style={{ height: 40, width: 'auto', flexShrink: 0 }}
              />
              <div style={{ fontSize: 16, fontWeight: 700, color: '#92400E' }}>
                Squideo Partner Programme -{' '}
                <a href="https://www.squideo.com/partner-programme" target="_blank" rel="noreferrer" style={{ color: BRAND.blue }}>Click Here to Learn More</a>
              </div>
            </div>

            <div style={{ display: isMobile ? 'block' : 'grid', gridTemplateColumns: isMobile ? undefined : '1fr 1fr', gap: 16, alignItems: 'start' }}>
              {/* LEFT — benefits */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(() => {
                  const standardRate = standardRatePerMin;
                  if (standardRate <= 0 || effectiveDiscount <= 0) return null;
                  const futureRate = partnerRatePerMin;
                  const savingPerMin = standardRate - futureRate;
                  const futurePct = formatPct(effectiveDiscount);
                  const maxPct = formatPct(partnerMaxDiscount);
                  return (
                    <div style={{ background: 'white', border: '1px solid #FDE68A', borderRadius: 10, padding: '14px 16px' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#92400E', marginBottom: 4 }}>
                        Your Partner rate per minute
                      </div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                        <span style={{ fontSize: 28, fontWeight: 800, color: '#0F2A3D', lineHeight: 1.1 }}>
                          {formatGBP(futureRate)}<span style={{ fontSize: 16, fontWeight: 600, color: '#6B7785' }}>/min</span>
                        </span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 1, fontSize: 12, fontWeight: 700, background: 'linear-gradient(135deg, #FFD700 0%, #C9A227 50%, #8B6914 100%)', color: 'white', padding: '5px 10px', borderRadius: 999, textShadow: '0 1px 1px rgba(0,0,0,0.25)', alignSelf: 'center' }}>
                          −{futurePct}%
                        </span>
                      </div>
                      <div style={{ fontSize: 13, color: '#78350F', marginBottom: 12, lineHeight: 1.5 }}>
                        {formatGBP(savingPerMin)} less per minute than the standard rate - locked in as long as you stay subscribed.
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 8 }}>
                        <FutureRateCell label="Standard" value={formatGBP(standardRate) + '/min'} muted strike />
                        <FutureRateCell label="Partner rate" value={formatGBP(futureRate) + '/min'} highlight />
                        <FutureRateCell label="You save" value={futurePct + '% · ' + formatGBP(savingPerMin)} highlight />
                      </div>
                      {partnerExtraPerCredit > 0 && effectiveDiscount < partnerMaxDiscount && (
                        <div style={{ fontSize: 12, color: '#78350F', lineHeight: 1.5 }}>
                          Add another minute to lock in up to <strong>{maxPct}% off</strong>.
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* RIGHT — action */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ background: 'white', border: '1px solid #FDE68A', borderRadius: 8, padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink }}>Monthly content credit:</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button onClick={() => !signed && setPartnerCredits(c => Math.max(1, c - 1))} disabled={!!signed || partnerCredits <= 1} style={{ width: isMobile ? 44 : 30, height: isMobile ? 44 : 30, borderRadius: 6, border: '1px solid #FDE68A', background: '#FFFAEB', cursor: signed || partnerCredits <= 1 ? 'default' : 'pointer', fontWeight: 700, fontSize: 16, lineHeight: 1 }}>−</button>
                    <span style={{ fontWeight: 700, fontSize: 16, minWidth: 28, textAlign: 'center' }}>{partnerCredits}</span>
                    <button onClick={() => !signed && setPartnerCredits(c => c + 1)} disabled={!!signed} style={{ width: isMobile ? 44 : 30, height: isMobile ? 44 : 30, borderRadius: 6, border: '1px solid #FDE68A', background: '#FFFAEB', cursor: signed ? 'default' : 'pointer', fontWeight: 700, fontSize: 16, lineHeight: 1 }}>+</button>
                    <span style={{ fontSize: 13, color: BRAND.muted }}>{partnerCredits === 1 ? 'min' : 'mins'}/mo</span>
                  </div>
                </div>
                {partnerExtraPerCredit > 0 && (
                  <div style={{ background: '#FFFAEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#78350F', lineHeight: 1.5 }}>
                    Each extra minute/month adds <strong>{formatPct(partnerExtraPerCredit)}% off</strong> this project, up to <strong>{formatPct(partnerMaxDiscount)}%</strong>.
                    {' '}You&apos;re at <strong>{partnerCredits} {partnerCredits === 1 ? 'min' : 'mins'} = {formatPct(effectiveDiscount)}% off</strong>
                    {effectiveDiscount < partnerMaxDiscount
                      ? <> · add another to save <strong>{formatPct(Math.min(partnerMaxDiscount, effectiveDiscount + partnerExtraPerCredit))}%</strong>.</>
                      : <> - maximum.</>}
                  </div>
                )}
                <div style={{ background: 'white', border: '1px solid #FDE68A', borderRadius: 8, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 15, fontWeight: 700 }}>
                  <span>Monthly subscription</span>
                  <span>{formatGBP(partnerSubtotal)} <span style={{ color: BRAND.muted, fontWeight: 500, fontSize: 13 }}>+ VAT / month</span></span>
                </div>
                <div style={{ fontSize: 12, color: '#78350F', lineHeight: 1.5, padding: '4px 2px' }}>
                  💳 <strong>First month charged when you sign.</strong> Renews monthly - cancel any time, even mid-project.
                </div>
              </div>
            </div>

            {data.partnerProgramme.description && (
              <div style={{ marginTop: 14, background: 'white', border: '1px solid #FDE68A', borderRadius: 10, padding: '14px 18px' }}>
                {renderDescriptionMarkup((data.partnerProgramme.description || '').replace(/^\s*\d+\s+minute(?:s)?\s+of\s+additional\s+content\s+credit\s+per\s+month\s*[-–—]\s*Cancel\s+any\s+time\s*\n+/i, ''))}
              </div>
            )}

            <div style={{ marginTop: 14 }}>
              <button
                onClick={() => !signed && setPartnerSelected(p => !p)}
                disabled={!!signed}
                style={{
                  width: '100%',
                  padding: '14px 20px',
                  border: 'none',
                  borderRadius: 10,
                  fontSize: 15,
                  fontWeight: 700,
                  fontFamily: 'inherit',
                  cursor: signed ? 'default' : 'pointer',
                  transition: 'background 120ms, color 120ms, transform 80ms',
                  ...(partnerSelected
                    ? {
                        background: '#E5E7EB',
                        color: '#4B5563',
                        border: '1px solid #D1D5DB',
                      }
                    : {
                        background: 'linear-gradient(135deg, #FFD700 0%, #C9A227 50%, #8B6914 100%)',
                        color: 'white',
                        textShadow: '0 1px 2px rgba(0,0,0,0.35)',
                        boxShadow: '0 2px 10px rgba(146, 64, 14, 0.35), inset 0 1px 0 rgba(255,255,255,0.35)',
                      }),
                }}
              >
                {partnerSelected
                  ? `✓ Joined - saving ${formatGBP(partnerDiscount)} (${formatPct(effectiveDiscount)}% off) - click to remove`
                  : `Opt in to Partner Programme - save ${formatGBP(partnerDiscount)} (${formatPct(effectiveDiscount)}% off)`}
              </button>
              <div style={{ fontSize: 12, color: '#5D8A00', textAlign: 'center', marginTop: 8 }}>✓ Cancel any time &nbsp;·&nbsp; No minimum term</div>
            </div>
          </div>
        )}

        <div style={{ background: BRAND.ink, color: 'white', padding: 20, borderRadius: 10, marginBottom: 32 }}>
          {partnerSelected && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6, opacity: 0.8 }}>
              <span>Project price (without Partner)</span>
              <span style={{ textDecoration: 'line-through' }}>{formatGBP(subtotal)} + VAT</span>
            </div>
          )}
          {partnerSelected && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 12, color: '#FFD54F' }}>
              <span>Partner discount ({formatPct(effectiveDiscount)}%)</span>
              <span>−{formatGBP(partnerDiscount)} + VAT</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: partnerSelected ? 15 : 18, fontWeight: partnerSelected ? 600 : 700, paddingTop: partnerSelected ? 12 : 0, borderTop: partnerSelected ? '1px solid rgba(255,255,255,0.2)' : 'none' }}>
            <span>{partnerSelected ? 'Project (discounted)' : `Project total${extrasTotal > 0 ? ' (including selected extras)' : ''}`}</span>
            <span>
              {formatGBP(partnerSelected ? discountedSubtotal : subtotal)} <span style={{ fontWeight: 500, fontSize: 14, opacity: 0.7 }}>+ VAT <span style={{ opacity: 0.55 }}>· {incVat(partnerSelected ? discountedSubtotal : subtotal)} inc.</span></span>
            </span>
          </div>
          {partnerSelected && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 600, marginTop: 6 }}>
                <span>
                  + First month Partner Programme
                  <span style={{ opacity: 0.7, fontWeight: 500, fontSize: 13, marginLeft: 6 }}>
                    ({partnerCredits} {partnerCredits === 1 ? 'min' : 'mins'}/mo)
                  </span>
                </span>
                <span>{formatGBP(partnerSubtotal)} <span style={{ fontWeight: 500, fontSize: 13, opacity: 0.7 }}>+ VAT</span></span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontWeight: 700, marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.2)' }}>
                <span>Due today</span>
                <span>{formatGBP(discountedSubtotal + partnerSubtotal)} <span style={{ fontWeight: 500, fontSize: 14, opacity: 0.7 }}>+ VAT <span style={{ opacity: 0.55 }}>· {incVat(discountedSubtotal + partnerSubtotal)} inc.</span></span></span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 8, color: '#FFD54F' }}>
                <span>Then {formatGBP(partnerSubtotal)} + VAT / month for {partnerCredits} {partnerCredits === 1 ? 'min' : 'mins'} of content credit, cancel any time</span>
                <span></span>
              </div>
            </>
          )}
        </div>

        <PageTitle>Payment Options</PageTitle>
        {partnerSelected && (
          <div style={{ background: '#FFFAEB', border: '1px solid #FDE68A', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#78350F', lineHeight: 1.5, marginBottom: 12 }}>
            <strong>Partner Programme selected.</strong> To unlock the {formatPct(effectiveDiscount)}% project discount, payment must be made in full (card/BACS). The 50/50 split is not available with the Partner Programme.
          </div>
        )}
        <div style={{ display: 'grid', gap: 12, marginBottom: 12 }}>
          {(() => {
            const subtitlesPrice = data.optionalExtras.find(e => e.id === 'subtitles')?.price ?? 125;
            const fullIncentive = data.paymentOptionDescs?.full?.trim() || `get a free subtitled version (worth £${subtitlesPrice})`;
            const fullTitle = partnerSelected ? 'Pay in full' : `Pay in full - ${fullIncentive}`;
            const OPTION_CONFIG = {
              '5050': { title: '50/50 split', desc: '50% deposit to start, balance invoiced when you approve the final video.' },
              'full': { title: fullTitle, desc: 'Pay upfront via card or BACS.' },
              'po': { title: 'Purchase Order', desc: 'Raise a Purchase Order - our team will be in touch to set up supplier details and confirm payment.' },
            };
            return (data.paymentOptions || ['5050', 'full']).map((key) => {
              const cfg = OPTION_CONFIG[key];
              if (!cfg) return null;
              const lockedByPartner = key === '5050' && partnerSelected;
              const disabled = !!signed || lockedByPartner;
              const disabledReason = lockedByPartner
                ? 'Unavailable with the Partner Programme - choose Pay in full or Purchase Order.'
                : undefined;
              return (
                <PaymentOption
                  key={key}
                  selected={paymentOption === key}
                  onSelect={() => !signed && !lockedByPartner && setPaymentOption(key)}
                  title={cfg.title}
                  desc={cfg.desc}
                  disabled={disabled}
                  disabledReason={disabledReason}
                />
              );
            });
          })()}
        </div>
        {(() => {
          const exVat = partnerSelected ? discountedSubtotal : subtotal;
          const half = exVat / 2;
          const vatNote = <span style={{ color: BRAND.muted, fontWeight: 500 }}>+ VAT</span>;
          const dueExVat = partnerSelected ? (discountedSubtotal + partnerSubtotal) : exVat;
          let line = null;
          if (paymentOption === '5050') {
            line = <>You pay <strong style={{ color: BRAND.blue }}>{formatGBP(half)}</strong> {vatNote} today, <strong>{formatGBP(half)}</strong> {vatNote} on final approval.</>;
          } else if (paymentOption === 'full') {
            line = partnerSelected
              ? <>You pay <strong style={{ color: BRAND.blue }}>{formatGBP(dueExVat)}</strong> {vatNote} today ({formatGBP(discountedSubtotal)} project + {formatGBP(partnerSubtotal)} first month Partner Programme), then {formatGBP(partnerSubtotal)} {vatNote}/month - cancel any time.</>
              : <>You pay <strong style={{ color: BRAND.blue }}>{formatGBP(exVat)}</strong> {vatNote} today.</>;
          } else if (paymentOption === 'po') {
            line = partnerSelected
              ? <>We&apos;ll invoice <strong style={{ color: BRAND.blue }}>{formatGBP(dueExVat)}</strong> {vatNote} once your Purchase Order is set up ({formatGBP(discountedSubtotal)} project + {formatGBP(partnerSubtotal)} first month Partner Programme), then {formatGBP(partnerSubtotal)} {vatNote}/month.</>
              : <>We&apos;ll invoice <strong style={{ color: BRAND.blue }}>{formatGBP(exVat)}</strong> {vatNote} once your Purchase Order is set up.</>;
          }
          if (!line) return null;
          return (
            <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '12px 16px', fontSize: 13, color: BRAND.ink, marginBottom: 32, lineHeight: 1.5 }}>
              {line}
            </div>
          );
        })()}

        {(() => {
          const expiry = validityLabel(data.date, data.validityDays, data.expiryDate);
          if (!expiry) return null;
          return (
            <div style={{ background: '#FFFAEB', border: '1px solid #FDE68A', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
              <CalendarClock size={18} color="#B45309" style={{ flexShrink: 0 }} />
              <div style={{ fontSize: 13, color: '#78350F', lineHeight: 1.5 }}>
                <strong style={{ color: '#92400E' }}>This proposal expires {expiry}.</strong>{' '}
                Production slots fill up - please confirm before then to secure yours.
              </div>
            </div>
          );
        })()}

        <PageTitle>Next Steps</PageTitle>
        <div style={{ marginBottom: 32 }}>
          {NEXT_STEPS.map((step, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 12, fontSize: 14, lineHeight: 1.7 }}>
              <div style={{ width: 24, height: 24, borderRadius: '50%', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>
                {i + 1}
              </div>
              <span>{step}</span>
            </div>
          ))}
          <p style={{ fontSize: 14, marginTop: 20, marginBottom: 20 }}>
            Still got questions? Give us a call on{' '}
            <a href={`tel:${CONFIG.company.phone}`} style={{ color: BRAND.blue, fontWeight: 600 }}>
              +44 (0){CONFIG.company.phone}
            </a>
            .
          </p>
          <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16, fontSize: 13, color: BRAND.muted, lineHeight: 1.7 }}>
            <strong style={{ color: BRAND.ink }}>Please note:</strong>{' '}Our production schedule is often booked several weeks in advance.
            To ensure we can deliver within your desired timeframe, we recommend confirming this quote as soon as possible.
            <br /><br />
            <strong style={{ color: BRAND.ink }}>You don't need to have your brief finalised before securing your slot</strong>{' '}-
            once confirmed, we'll help you refine your content and creative direction as part of the process.
            <br /><br />
            After the 28-day validity period, we may not be able to fulfil the project due to existing commitments.
          </div>
        </div>

        {signed ? (
          <SignedBlock
            signed={signed}
            payment={payment}
            paymentChoice={paymentChoice}
            vatRate={data.vatRate}
            onPayNow={handlePayNow}
            onChooseInvoice={() => setPaymentChoice('invoice')}
            onUndoInvoice={() => setPaymentChoice(null)}
            onConfirmInvoice={handleConfirmInvoice}
            onPoConfirm={handlePoConfirm}
            onDownloadReceipt={payment ? () => openReceiptWindow(data, signed, payment) : undefined}
            onDownloadSignedProposal={signed ? () => openPrintWindow(data, printOptionsForSigned(signed, payment)) : undefined}
          />
        ) : (
          <div ref={signRef} style={{ background: BRAND.paper, border: '2px solid ' + BRAND.blue, borderRadius: 12, padding: 24, scrollMarginTop: 80 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>Accept this proposal</h3>
            <Field label="Your full name">
              <input className="input" value={sigName} onChange={(e) => setSigName(e.target.value)} placeholder="Type your name to sign" />
            </Field>
            <Field label="Email address">
              <input className="input" type="email" value={sigEmail} onChange={(e) => setSigEmail(e.target.value)} placeholder="you@company.com" />
            </Field>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 0', cursor: 'pointer', fontSize: 14 }}>
              <input type="checkbox" checked={sigAccepted} onChange={(e) => setSigAccepted(e.target.checked)} style={{ marginTop: 3 }} />
              <span>
                I accept this proposal and authorise Squideo to begin work. By typing my name, I am providing my electronic signature
                {CONFIG.company.termsUrl ? <>, and agree to our <a href={CONFIG.company.termsUrl} target="_blank" rel="noreferrer" style={{ color: BRAND.blue }}>Terms & Conditions</a></> : null}.
              </span>
            </label>
            <button onClick={handleSign} className="btn" style={{ width: '100%', justifyContent: 'center', padding: '14px 20px', fontSize: 15, marginTop: 12, background: '#16A34A', flexDirection: 'column', gap: 4 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 16 }}>
                <Check size={18} /> Accept &amp; Sign
              </span>
              <span style={{ fontSize: 13, fontWeight: 500, opacity: 0.95 }}>
                {partnerSelected ? (
                  <>
                    {formatGBP(discountedSubtotal)} project + {formatGBP(partnerSubtotal)} first month = <strong>{formatGBP(discountedSubtotal + partnerSubtotal)} + VAT</strong> <span style={{ opacity: 0.75 }}>· {incVat(discountedSubtotal + partnerSubtotal)} inc.</span>
                  </>
                ) : (
                  <>
                    <strong>{formatGBP(subtotal)} + VAT</strong> <span style={{ opacity: 0.75 }}>· {incVat(subtotal)} inc.</span>
                  </>
                )}
              </span>
            </button>
          </div>
        )}

        <div style={{ marginTop: 40, paddingTop: 20, borderTop: '1px solid ' + BRAND.border, fontSize: 12, color: BRAND.muted, textAlign: 'center' }}>
          {CONFIG.company.name} · {CONFIG.company.website} · {CONFIG.company.phone}
        </div>
      </div>

      {!signed && (
        <StickyCTA
          totalExVat={partnerSelected ? discountedSubtotal : subtotal}
          partnerMonthlyExVat={partnerSubtotal}
          partnerSelected={partnerSelected}
          phone={CONFIG.company.phone}
          email={data.preparedByEmail}
          emailName={data.preparedBy ? String(data.preparedBy).trim().split(/\s+/)[0] : null}
          onSign={scrollToSign}
        />
      )}

      {paymentChoice === 'stripe-sim' && signed && (
        <StripeSimModal
          amount={signed.paymentOption === '5050' ? signed.total / 2 : signed.total}
          isDeposit={signed.paymentOption === '5050'}
          onConfirm={confirmStripeSim}
          onClose={() => setPaymentChoice(null)}
        />
      )}
    </div>
  );
}
