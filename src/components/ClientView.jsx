import React, { useEffect, useRef, useState } from 'react';
import {
  Archive, Award, CalendarClock, Calendar, Captions, Check, ChevronLeft, Download,
  FileDown, FileText, Globe, LayoutGrid, Link2, Mic, Music, Palette, PenLine, Phone,
  Play, RefreshCw, Rocket, Share2, Smartphone, Sparkles, Users
} from 'lucide-react';
import { BRAND, CONFIG, DEFAULT_PHOTOS } from '../theme.js';
import { SQUIDEO_LOGO, NEXT_STEPS, extraHasVariants, extraHasQuantity, extraUnitPrice, resolveExtraPricing } from '../defaults.js';
import { useStore } from '../store.jsx';
import { formatGBP, sendNotification, useIsMobile, computeBaseDiscount } from '../utils.js';
import { openPrintWindow, openReceiptWindow, printOptionsForSigned } from '../utils/printProposal.js';
import { startStripeCheckout } from '../utils/stripeCheckout.js';
import { Field, Modal, PageTitle, PaymentOption, PriceRow, StickyCTA } from './ui.jsx';
import { SignedBlock } from './SignedBlock.jsx';
import { SignaturePad } from './SignaturePad.jsx';
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

export function ClientView({ id, onBack, onEdit, useRealStripe = false, onSigned }) {
  const { state, actions, showMsg } = useStore();
  const data = state.proposals[id];
  const isPreview = !useRealStripe;
  const storeSigned = state.signatures[id] || null;
  const storePayment = state.payments[id] || null;
  // In preview mode, any "signature" is local-only — never persisted.
  const [previewSigned, setPreviewSigned] = useState(null);
  const signed = isPreview && previewSigned ? previewSigned : storeSigned;
  const payment = storePayment;

  // Staff preview only: pull the linked deal's invoices so the signed block can
  // reflect real payments taken outside the proposal's own Stripe flow (e.g. a
  // deposit paid against a Xero invoice on the deal). Never runs on public links.
  const dealId = data?._dealId || null;
  const [dealInvoices, setDealInvoices] = useState(null);
  useEffect(() => {
    if (!isPreview || !signed || payment || !dealId) { setDealInvoices(null); return; }
    let alive = true;
    actions.loadDealInvoices(dealId).then((rows) => { if (alive) setDealInvoices(rows); });
    return () => { alive = false; };
  }, [isPreview, signed, payment, dealId]);

  // Track viewing session: open + heartbeat (active time only) + close beacon
  // Only fires for real client views (public URL). Internal previews from the
  // dashboard skip tracking so they don't pollute analytics or trigger the
  // first-view notification email.
  useEffect(() => {
    if (!data || !useRealStripe) return;
    // Reuse one session id per proposal+browser so a reload/return visit isn't
    // counted as a brand-new viewer (which would re-fire the "opened" alert every
    // time). A genuinely different device/browser still gets its own session.
    const makeSession = () => ((typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10));
    const storageKey = 'sq_view_session_' + id;
    let sessionId = null;
    try { sessionId = localStorage.getItem(storageKey); } catch { /* ignore */ }
    if (!sessionId) {
      sessionId = makeSession();
      try { localStorage.setItem(storageKey, sessionId); } catch { /* ignore */ }
    }
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
  // Credit-only proposals add credit inline at the total (no opt-in panel), so
  // they start at zero added minutes and selection follows the stepper.
  const [partnerCredits, setPartnerCredits] = useState(() =>
    (data?.partnerProgramme?.mode === 'oneoff' && data?.partnerProgramme?.creditOnly) ? 0 : 1
  );
  const [partnerHowOpen, setPartnerHowOpen] = useState(false);
  const [paymentOption, setPaymentOption] = useState(() => {
    const opts = data?.paymentOptions || ['5050', 'full'];
    return opts[0];
  });

  // Once signed, replay the choices the client locked in so the (now disabled)
  // controls reflect the signed selection instead of resetting to defaults.
  // Without this, extras the client ticked show as unchecked on the signed
  // view even though they're on the invoice.
  useEffect(() => {
    if (!signed) return;
    if (Array.isArray(signed.selectedExtras)) {
      const map = {};
      const meta = {};
      for (const e of signed.selectedExtras) {
        if (!e?.id) continue;
        map[e.id] = true;
        if (e.variantsEnabled) {
          meta[e.id] = {
            quantity: Math.max(1, Number(e.quantity) || 1),
            languages: e.languages || '',
          };
        }
      }
      setSelectedExtras(map);
      setExtrasMeta(meta);
    }
    if (typeof signed.partnerSelected === 'boolean') setPartnerSelected(signed.partnerSelected);
    if (Number.isFinite(Number(signed.partnerCredits))) setPartnerCredits(Number(signed.partnerCredits));
    if (signed.paymentOption) setPaymentOption(signed.paymentOption);
    if (signed.selectedVideoOption && Array.isArray(data?.videoOptions)) {
      const idx = data.videoOptions.findIndex(v =>
        (v.id && signed.selectedVideoOption.id && v.id === signed.selectedVideoOption.id)
        || (v.label && v.label === signed.selectedVideoOption.label)
      );
      if (idx >= 0) setSelectedVideoOptionIdx(idx);
    }
  }, [signed, data]);

  // The *subscription* Partner Programme unlocks its discount only on full
  // payment (or PO), so opting in bumps the client off 50/50. The one-off
  // Content Credit is a single purchase that can still be split 50/50 — leave
  // its payment choice alone.
  useEffect(() => {
    if (!partnerSelected || signed || paymentOption !== '5050') return;
    if (data?.partnerProgramme?.mode === 'oneoff') return;
    const opts = data?.paymentOptions || ['5050', 'full'];
    const next = opts.find(o => o !== '5050') || 'full';
    setPaymentOption(next);
  }, [partnerSelected, signed, paymentOption, data]);

  // paymentOption is seeded at mount (above), but on a public link the proposal
  // data arrives a beat later — so that seed can be a default ('5050') the
  // proposal doesn't actually offer. Once the offered list is known, snap the
  // selection back into it: otherwise the radios (driven by data.paymentOptions)
  // and both the breakdown line AND the signed submission (driven by this state)
  // silently disagree — the client sees only "Pay in full" yet gets billed a
  // 50/50 deposit. Skips signed views, where the locked-in choice is replayed.
  useEffect(() => {
    if (signed) return;
    const opts = data?.paymentOptions;
    if (!opts || !opts.length || opts.includes(paymentOption)) return;
    setPaymentOption(opts[0]);
  }, [data, signed, paymentOption]);
  const [sigName, setSigName] = useState('');
  const [sigEmail, setSigEmail] = useState('');
  const [sigAccepted, setSigAccepted] = useState(false);
  // Drawn or uploaded signature image (PNG data URL) — required alongside the
  // typed name, DocuSign-style.
  const [sigImage, setSigImage] = useState(null);
  const [paymentChoice, setPaymentChoice] = useState(null);
  const isMobile = useIsMobile();
  const signRef = useRef(null);
  // Notable-examples lightbox: the example currently playing in a modal, plus a
  // fallback thumbnail cache for any example missing a stored poster (e.g. added
  // before we captured thumbnails — fetched from Vimeo's public oEmbed).
  const [activeExample, setActiveExample] = useState(null);
  const [exampleThumbs, setExampleThumbs] = useState({});

  const scrollToSign = () => {
    if (!signRef.current) return;
    const reduceMotion = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
    signRef.current.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  };

  // Backfill posters for any notable example that has no stored thumbnail
  // (via our /api/vimeo-oembed proxy). Examples added via the builder already
  // carry a thumbnail; this covers older ones and non-Vimeo links gracefully.
  const examplesKey = (data?.notableExamples || []).map(e => e?.url || '').join('|');
  useEffect(() => {
    const list = (data?.notableExamples || []).filter(e => e?.url?.trim() && !e.thumbnail);
    let cancelled = false;
    list.forEach((ex) => {
      const url = ex.url.trim();
      if (!/vimeo\.com\/\d+/.test(url) || exampleThumbs[ex.url]) return;
      // Same-origin proxy — the app CSP (connect-src 'self') blocks vimeo.com.
      fetch('/api/vimeo-oembed?url=' + encodeURIComponent(url))
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (!cancelled && j && j.thumbnail) setExampleThumbs(prev => ({ ...prev, [ex.url]: j.thumbnail })); })
        .catch(() => {});
    });
    return () => { cancelled = true; };
  }, [examplesKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const videoOptions = Array.isArray(data.videoOptions) && data.videoOptions.length > 0
    ? data.videoOptions : null;
  const effectiveBasePrice = videoOptions
    ? (videoOptions[selectedVideoOptionIdx]?.price ?? data.basePrice)
    : data.basePrice;

  // How many minutes of content this proposal covers. Drives per-minute extra
  // pricing on standard proposals as well as credit-only ones — an extra like
  // the voiceover costs more on 8 minutes of content than on 1.
  const contentMinutes = videoOptions
    ? Number(videoOptions[selectedVideoOptionIdx]?.minutes) || 0
    : Number(data.partnerProgramme?.quotedMinutes) || 0;

  // A signed proposal bills the unit price agreed at signing, so later changes to
  // the proposal's extras (or to the pricing catalogue) can't move a signed total.
  const signedExtraPrice = new Map();
  for (const e of (signed?.selectedExtras || [])) {
    if (e?.id && Number.isFinite(Number(e.price))) signedExtraPrice.set(e.id, Number(e.price));
  }
  const unitPriceFor = (e) => (
    signedExtraPrice.has(e.id) ? signedExtraPrice.get(e.id) : extraUnitPrice(e, contentMinutes)
  );

  const extrasTotal = data.optionalExtras.reduce((s, e) => {
    if (!selectedExtras[e.id]) return s;
    const qty = extraHasQuantity(e) ? Math.max(1, Number(getMeta(e.id).quantity) || 1) : 1;
    return s + unitPriceFor(e) * qty;
  }, 0);
  // Simple manual discount on the base price — standard flow only. When the
  // client opts into the Partner Programme its own discount takes over and this
  // is ignored. Once signed, the agreed amount is locked in signed.discountApplied.
  // Is the project already free before any Partner Programme? Either the base
  // price is £0 or a 100% manual discount wipes it out. When so, opting into the
  // Partner Programme must NOT reintroduce the full price and shave its own % off
  // — the project stays free and the programme only adds its monthly subscription.
  // (Otherwise a free project would paradoxically start costing money on opt-in.)
  const manualDiscountAmount = computeBaseDiscount(effectiveBasePrice, data.discount);
  const projectFullyDiscounted = effectiveBasePrice <= 0 || manualDiscountAmount >= effectiveBasePrice - 0.005;
  const manualDiscount = (partnerSelected && !projectFullyDiscounted)
    ? 0
    : (signed?.discountApplied?.amount ?? manualDiscountAmount);
  const netBasePrice = effectiveBasePrice - manualDiscount;
  const discountLabel = (signed?.discountApplied?.label || data.discount?.label || '').trim() || 'Discount';
  const subtotal = netBasePrice + extrasTotal;
  const vat = subtotal * data.vatRate;
  const total = subtotal + vat;
  // One-off Content Credit variant: a single upfront purchase of content credit
  // (same tier ladder, but paid once for future use) rather than a recurring
  // monthly subscription. Flips wording and payment rules throughout.
  const isOneoff = data.partnerProgramme?.mode === 'oneoff';
  // Credit-only: the main section quotes an amount of minutes at the standard
  // rate, and the tier discount rewards ONLY the extra minutes added here — the
  // quoted minutes are never discounted. Purely a budget-maximiser: add more
  // credit now, get a better rate on what you add.
  const isCreditOnly = isOneoff && !!data.partnerProgramme?.creditOnly;
  const quotedMinutes = contentMinutes;
  // Adding credit IS the opt-in on a credit-only proposal — there's no separate
  // "add to proposal" button, so selection tracks the stepper.
  const setAddedCredits = (n) => {
    if (signed) return;
    const v = Math.max(0, n);
    setPartnerCredits(v);
    setPartnerSelected(v > 0);
  };
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
  // No further partner discount on a project that's already free. In credit-only
  // mode the quoted work is never discounted at all — the tier rate applies only
  // to the extra minutes bought here (already baked into partnerRatePerMin).
  const partnerDiscount = (projectFullyDiscounted || isCreditOnly) ? 0 : subtotal * effectiveDiscount;
  const discountedSubtotal = subtotal - partnerDiscount;
  // Savings split: what comes off the quoted work, and what's saved on the extra
  // minutes bought here. In credit-only mode the first is always zero.
  const savingPerMin = Math.max(0, standardRatePerMin - partnerRatePerMin);
  const bankedSaving = savingPerMin * partnerCredits;
  const combinedSaving = partnerDiscount + bankedSaving;
  const fmtMins = (n) => {
    const v = Number(n) || 0;
    return `${v % 1 === 0 ? v.toFixed(0) : String(v)} ${v === 1 ? 'minute' : 'minutes'}`;
  };
  // Only show the partner project-discount lines when there's an actual saving.
  const showPartnerProjectDiscount = partnerSelected && partnerDiscount > 0;
  const discountedVat = discountedSubtotal * data.vatRate;
  const discountedTotal = discountedSubtotal + discountedVat;
  // Combined "due today" when client opts into the Partner Programme:
  // discounted project + first month of the partner subscription.
  const dueNowTotal = partnerSelected ? (discountedTotal + partnerTotal) : total;
  const incVat = (n) => formatGBP(n * (1 + (data.vatRate || 0)));
  // When VAT is 0%, drop every "+ VAT" / "inc. VAT" reference from the proposal.
  const showVat = (Number(data.vatRate) || 0) > 0;

  const handleSign = async () => {
    if (!sigName.trim() || !sigEmail.trim() || !sigAccepted) {
      showMsg('Please complete name, email and tick the acceptance box.');
      return;
    }
    if (!sigImage) {
      showMsg('Please draw or upload your signature.');
      return;
    }
    const sig = {
      name: sigName,
      email: sigEmail,
      signatureImage: sigImage,
      signedAt: new Date().toISOString(),
      // `price` is stored as the AGREED unit price (already scaled for the
      // proposal's minutes), because Xero and the invoice builders bill straight
      // off these lines. listPrice keeps the unscaled figure for reference.
      selectedExtras: data.optionalExtras
        .filter((e) => selectedExtras[e.id])
        .map((e) => {
          const unit = extraUnitPrice(e, contentMinutes);
          const base = { ...e, price: unit, listPrice: Number(e.price) || 0, contentMinutes };
          return extraHasQuantity(e)
            ? {
                ...base,
                ...(extraHasVariants(e) ? { variantsEnabled: true, languages: getMeta(e.id).languages || '' } : {}),
                quantity: Math.max(1, Number(getMeta(e.id).quantity) || 1),
              }
            : base;
        }),
      ...(videoOptions ? { selectedVideoOption: videoOptions[selectedVideoOptionIdx] } : {}),
      partnerSelected,
      partnerCredits,
      paymentOption,
      // Captured so the post-sign payment prompt only promises the incentive
      // (free subtitled version) when it was actually offered.
      payInFullIncentive: data.payInFullIncentive !== false,
      total: dueNowTotal,
      partnerTotal: partnerSelected ? partnerTotal : 0,
      amountBreakdown: partnerSelected ? {
        projectExVat: discountedSubtotal,
        projectTotal: discountedTotal,
        partnerExVat: partnerSubtotal,
        partnerTotal,
        partnerCredits,
        // discountRate is what downstream (Xero lineItemsForDiscountedProject)
        // shaves off the PROJECT lines. In credit-only mode the quoted work is
        // never discounted, so this must be 0 — the tier rate lives on the added
        // credit minutes only and is recorded separately as creditDiscountRate.
        discountRate: isCreditOnly ? 0 : effectiveDiscount,
        creditDiscountRate: effectiveDiscount,
        creditOnly: isCreditOnly,
        // Minutes quoted in the main section. In credit-only mode these are also
        // content credit, so the ledger banks them alongside partnerCredits.
        baseCreditMinutes: isCreditOnly ? quotedMinutes : 0,
        vatRate: data.vatRate,
        // One-off Content Credit vs recurring subscription — SignedBlock and the
        // post-sign payment prompt use this to drop the "/month, cancel any time"
        // language for a single upfront credit purchase.
        oneoff: isOneoff,
      } : null,
      // Lock the agreed manual discount so later edits to data.discount don't
      // change a signed/invoiced proposal (mirrors amountBreakdown for Partner).
      ...(!partnerSelected && manualDiscount > 0 ? {
        discountApplied: {
          type: data.discount?.type || 'percent',
          value: Number(data.discount?.value) || 0,
          label: (data.discount?.label || '').trim(),
          amount: manualDiscount,
          basePrice: effectiveBasePrice,
        },
      } : {}),
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
        // paddingTop carries the iOS safe-area inset so the bar (and its Back
        // button) clears the notch/Dynamic Island instead of sitting under the
        // status bar where taps don't land. On mobile the action buttons drop
        // their labels to icons so everything fits one tidy row.
        <div style={{ position: 'sticky', top: 0, background: 'white', borderBottom: '1px solid ' + BRAND.border, padding: isMobile ? '8px 12px' : '12px 24px', paddingTop: `calc(${isMobile ? 8 : 12}px + env(safe-area-inset-top))`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, zIndex: 100 }}>
          {onBack ? <button onClick={onBack} className="btn-ghost" style={{ flexShrink: 0 }}><ChevronLeft size={16} /> Back</button> : <div />}
          {!isMobile && (
            <div style={{ fontSize: 12, color: '#92400E', fontWeight: 700, letterSpacing: 0.5 }}>
              PREVIEW MODE
            </div>
          )}
          <div style={{ display: 'flex', gap: isMobile ? 4 : 8, flexShrink: 0 }}>
            {onEdit && !storeSigned && (
              <button onClick={onEdit} className="btn-ghost" style={{ fontSize: 13 }} title="Edit this proposal in the builder" aria-label="Edit">
                <PenLine size={14} /> {!isMobile && 'Edit'}
              </button>
            )}
            <button
              onClick={() => {
                const url = 'https://app.squideo.com/?proposal=' + id;
                navigator.clipboard.writeText(url)
                  .then(() => showMsg('Link copied to clipboard'))
                  .catch(() => showMsg('Copy failed — link: ' + url));
              }}
              className="btn-ghost"
              style={{ fontSize: 13 }}
              title="Copy link"
              aria-label="Copy link"
            >
              <Link2 size={14} /> {!isMobile && 'Copy link'}
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
              title={signed ? 'Download signed copy' : 'Download PDF'}
              aria-label={signed ? 'Download signed copy' : 'Download PDF'}
            >
              <FileDown size={14} /> {!isMobile && (signed ? 'Download signed copy' : 'Download PDF')}
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

        {data.showIntro !== false && (
          <>
            <PageTitle>{data.introHeading?.trim() ? data.introHeading : (data.contactBusinessName ? `${data.contactBusinessName}, thank you for considering Squideo as your creative partner` : 'Thank you for considering Squideo as your creative partner')}</PageTitle>
            {(data.intro || '').split('\n\n').map((p, i) => (
              <p key={i} style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 12 }}>{p}</p>
            ))}
          </>
        )}

        {data.showDeliveryTeam !== false && (
        <>
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
        </>
        )}

        {/* "Your Requirement" now renders just above Your Quote (see below) so
            it sits consistently in both single and option mode. */}
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

        {data.showNotableExamples && (data.notableExamples || []).some(ex => ex?.url?.trim()) && (() => {
          const examples = (data.notableExamples || []).filter(ex => ex?.url?.trim());
          return (
            <div style={{ marginBottom: 32 }}>
              <PageTitle>Notable Examples</PageTitle>
              <p style={{ fontSize: 14, color: BRAND.muted, marginBottom: 16, lineHeight: 1.6 }}>A few examples of our recent work — click to play:</p>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${Math.min(examples.length, 3)}, 1fr)`, gap: 16 }}>
                {examples.map((ex, i) => {
                  const poster = ex.thumbnail || exampleThumbs[ex.url] || null;
                  return (
                    <button
                      key={ex.id || i}
                      type="button"
                      onClick={() => setActiveExample(ex)}
                      style={{ display: 'block', textAlign: 'left', padding: 0, border: 'none', background: 'none', cursor: 'pointer', width: '100%' }}
                    >
                      <div style={{ position: 'relative', paddingBottom: '56.25%', borderRadius: 10, overflow: 'hidden', background: poster ? 'transparent' : BRAND.ink }}>
                        {poster && (
                          <img
                            src={poster}
                            alt={ex.title || ('Example ' + (i + 1))}
                            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', borderRadius: 10, display: 'block' }}
                          />
                        )}
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <div style={{ width: 54, height: 54, borderRadius: '50%', background: 'rgba(255,255,255,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(0,0,0,0.3)' }}>
                            <Play size={22} fill={BRAND.ink} color={BRAND.ink} style={{ marginLeft: 3 }} />
                          </div>
                        </div>
                      </div>
                      {ex.title && ex.title.trim() && (
                        <div style={{ fontSize: 14, fontWeight: 600, marginTop: 8, lineHeight: 1.4, textAlign: 'center' }}>{ex.title}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {activeExample && (
          <Modal onClose={() => setActiveExample(null)} maxWidth={900} overflow="hidden" fullScreenOnMobile={false}>
            {activeExample.title && activeExample.title.trim() && (
              <h3 style={{ fontSize: 16, fontWeight: 600, margin: '0 40px 12px 0' }}>{activeExample.title}</h3>
            )}
            <div style={{ position: 'relative', paddingBottom: '56.25%', borderRadius: 8, overflow: 'hidden', background: '#000' }}>
              <iframe
                src={getEmbedUrl(activeExample.url) + (getEmbedUrl(activeExample.url).includes('?') ? '&' : '?') + 'autoplay=1'}
                title={activeExample.title || 'Example video'}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' }}
              />
            </div>
          </Modal>
        )}

        {(() => {
          // Prefer the dedicated free-text brief; fall back to the single-mode
          // requirement so existing proposals still show their requirement.
          const reqText = (data.requirementSummary || '').trim() || (!videoOptions ? (data.requirement || '').trim() : '');
          if (!reqText) return null;
          return (
            <div style={{ marginBottom: 32 }}>
              <PageTitle>Your Requirement</PageTitle>
              <p style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap', fontWeight: 500, margin: 0 }}>{reqText}</p>
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

        {videoOptions && (
          <div style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Choose your option:</h3>
            <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
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
                    <div style={{ fontWeight: 600, fontSize: 14, marginBottom: (opt.description || isCreditOnly) ? 6 : 0 }}>{opt.label || `Option ${i + 1}`}</div>
                    {isCreditOnly && Number(opt.minutes) > 0 && (
                      <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.blue, marginBottom: opt.description ? 6 : 0 }}>
                        {fmtMins(opt.minutes)} of content credit
                      </div>
                    )}
                    {opt.description && <p style={{ fontSize: 14, lineHeight: 1.7, margin: 0, whiteSpace: 'pre-wrap', color: BRAND.text }}>{opt.description}</p>}
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 600, flexShrink: 0, paddingTop: 2 }}>{formatGBP(opt.price)}{showVat && <span style={{ fontWeight: 400, fontSize: 12, color: BRAND.muted }}> + VAT</span>}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* In option mode the selector above already states the chosen option +
            price, so this summary row would just repeat it — only show it for
            the single-price flow, or when a manual discount needs the
            strikethrough/discounted total. */}
        {(!videoOptions || manualDiscount > 0) && !isCreditOnly && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '14px 16px', border: '1px solid ' + BRAND.border, borderRadius: 10, fontSize: 16, fontWeight: 700 }}>
            <span>
              {videoOptions
                ? (videoOptions[selectedVideoOptionIdx]?.label || `Option ${selectedVideoOptionIdx + 1}`)
                : 'Project base price'}
            </span>
            <span>
              {manualDiscount > 0 && (
                <span style={{ fontWeight: 500, fontSize: 14, color: BRAND.muted, textDecoration: 'line-through', marginRight: 8 }}>{formatGBP(effectiveBasePrice)}</span>
              )}
              {formatGBP(netBasePrice)}{showVat && <span style={{ fontWeight: 500, fontSize: 13, color: BRAND.muted }}> + VAT</span>}
            </span>
          </div>
        )}
        {manualDiscount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '8px 16px', fontSize: 13, color: '#15803d', fontWeight: 600 }}>
            <span>{discountLabel}{(signed?.discountApplied?.type ?? data.discount?.type) !== 'amount' && (Number(signed?.discountApplied?.value ?? data.discount?.value) > 0) ? ` (${Number(signed?.discountApplied?.value ?? data.discount?.value)}% off)` : ''}</span>
            <span>−{formatGBP(manualDiscount)}</span>
          </div>
        )}

        {/* Credit-only: the credit total sits here, right under what's included,
            and carries the add-credit control. Extras are totalled separately
            below so this box stays purely about credit. */}
        {isCreditOnly && (
          <div style={{ background: BRAND.ink, color: 'white', padding: 20, borderRadius: 10, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 18, fontWeight: 700, gap: 12, flexWrap: 'wrap' }}>
              <span>{quotedMinutes > 0 ? `${fmtMins(quotedMinutes)} of content credit` : 'Content credit'}</span>
              <span>
                {formatGBP(netBasePrice)} {showVat && <span style={{ fontWeight: 500, fontSize: 14, opacity: 0.7 }}>+ VAT</span>}
              </span>
            </div>
            {/* Applies to the whole balance, not just what they add below. */}
            <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 6, lineHeight: 1.6 }}>
              Spend it however suits you — one longer video, several shorter ones, or hold some back for later.
              Yours to use for 2 years from the day you secure it.
            </div>

            {data.partnerProgramme?.enabled && !signed && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>Add more content credit</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2, lineHeight: 1.5 }}>
                      Maximise your budget — extra minutes are discounted{partnerMaxDiscount > 0 && <>, up to {formatPct(partnerMaxDiscount)}% off</>}.
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                    {(() => {
                      const btn = (disabled) => ({
                        width: isMobile ? 44 : 34, height: isMobile ? 44 : 34, borderRadius: 8,
                        border: '1px solid rgba(255,255,255,0.35)', background: 'rgba(255,255,255,0.1)',
                        color: 'white', cursor: disabled ? 'default' : 'pointer',
                        opacity: disabled ? 0.4 : 1, fontWeight: 700, fontSize: 18, lineHeight: 1,
                      });
                      return (
                        <>
                          <button onClick={() => setAddedCredits(partnerCredits - 1)} disabled={partnerCredits <= 0} style={btn(partnerCredits <= 0)}>−</button>
                          <span style={{ fontWeight: 800, fontSize: 20, minWidth: 30, textAlign: 'center' }}>{partnerCredits}</span>
                          <button onClick={() => setAddedCredits(partnerCredits + 1)} style={btn(false)}>+</button>
                          <span style={{ fontSize: 13, opacity: 0.8 }}>{partnerCredits === 1 ? 'min' : 'mins'}</span>
                        </>
                      );
                    })()}
                  </div>
                </div>
                {partnerCredits > 0 && (
                  <div style={{ fontSize: 12.5, color: '#86EFAC', marginTop: 10, lineHeight: 1.6 }}>
                    <strong>{formatGBP(partnerRatePerMin)}/min</strong> ({formatPct(effectiveDiscount)}% off) — you save <strong>{formatGBP(bankedSaving)}</strong>.
                    {' '}Paid once when you sign.
                  </div>
                )}
              </div>
            )}

            {partnerSelected && partnerCredits > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 600, marginTop: 14 }}>
                  <span>
                    + Extra content credit
                    <span style={{ opacity: 0.7, fontWeight: 500, fontSize: 13, marginLeft: 6 }}>
                      ({partnerCredits} {partnerCredits === 1 ? 'min' : 'mins'})
                    </span>
                  </span>
                  <span>{formatGBP(partnerSubtotal)} {showVat && <span style={{ fontWeight: 500, fontSize: 13, opacity: 0.7 }}>+ VAT</span>}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 17, fontWeight: 700, marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.2)' }}>
                  <span>
                    Total content credit
                    <span style={{ opacity: 0.7, fontWeight: 500, fontSize: 13, marginLeft: 6 }}>
                      ({fmtMins(quotedMinutes + partnerCredits)})
                    </span>
                  </span>
                  <span>{formatGBP(netBasePrice + partnerSubtotal)} {showVat && <span style={{ fontWeight: 500, fontSize: 14, opacity: 0.7 }}>+ VAT</span>}</span>
                </div>
              </>
            )}
          </div>
        )}

        {(() => {
        // Optional extras can be hidden entirely from the client. Still show the
        // section on an already-signed proposal that locked in selected extras,
        // so the signed record stays accurate.
        const hasSignedExtras = Array.isArray(signed?.selectedExtras) && signed.selectedExtras.length > 0;
        if (data.hideOptionalExtras && !hasSignedExtras) return null;
        return (
        <>
        <PageTitle>Optional Extras</PageTitle>
        {isCreditOnly && (
          <p style={{ fontSize: 13, lineHeight: 1.6, color: '#15803D', background: '#F0FDF4', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', margin: '0 0 12px' }}>
            Any unused content credit can be put towards any of the extras below, at any time.
          </p>
        )}
        <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden', marginBottom: 24 }}>
          {data.optionalExtras.map((extra, i) => {
            const isSelected = !!selectedExtras[extra.id];
            const meta = getMeta(extra.id);
            const languagesOn = extraHasVariants(extra);
            const qtyOn = extraHasQuantity(extra);
            const qty = qtyOn ? Math.max(1, Number(meta.quantity) || 1) : 1;
            const showVariants = qtyOn && isSelected;
            // Unit price scales with the minutes of content the proposal covers.
            const unit = unitPriceFor(extra);
            const scaled = resolveExtraPricing(extra)?.priceModel === 'perExtraMinute' && contentMinutes > 1;
            return (
              <div key={extra.id} style={{ borderBottom: i < data.optionalExtras.length - 1 ? '1px solid ' + BRAND.border : 'none', background: isSelected ? '#F0F9FF' : 'white' }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 16px', cursor: signed ? 'default' : 'pointer' }}>
                  <input type="checkbox" checked={isSelected} onChange={(e) => setSelectedExtras({ ...selectedExtras, [extra.id]: e.target.checked })} disabled={!!signed} style={{ marginTop: 3 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{extra.label}</div>
                    {extra.description && <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.5, marginTop: 4 }}>{extra.description}</div>}
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 600, flexShrink: 0, textAlign: 'right' }}>
                    {formatGBP(unit * qty)}
                    {(qtyOn || scaled) && (
                      <div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 500 }}>
                        {qtyOn && isSelected
                          ? <>{formatGBP(unit)} × {qty}</>
                          : (qtyOn ? (languagesOn ? 'per language' : 'each') : null)}
                        {scaled && (
                          <div>for {fmtMins(contentMinutes)}</div>
                        )}
                      </div>
                    )}
                  </span>
                </label>
                {showVariants && (
                  <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: '0 16px 14px 44px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, color: BRAND.muted }}>{languagesOn ? 'How many languages?' : 'How many?'}</span>
                      <button type="button" disabled={!!signed || qty <= 1} onClick={() => setMeta(extra.id, { quantity: qty - 1 })} className="btn-icon" aria-label="Decrease quantity">−</button>
                      <input
                        type="number"
                        min={1}
                        value={qty}
                        disabled={!!signed}
                        onChange={(e) => setMeta(extra.id, { quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                        className="input"
                        style={{ width: 56, textAlign: 'center', padding: '4px 6px' }}
                      />
                      <button type="button" disabled={!!signed} onClick={() => setMeta(extra.id, { quantity: qty + 1 })} className="btn-icon" aria-label="Increase quantity">+</button>
                    </div>
                    {languagesOn && (
                      <input
                        type="text"
                        placeholder="Which languages? (optional, e.g. French, German, Spanish)"
                        value={meta.languages || ''}
                        disabled={!!signed}
                        onChange={(e) => setMeta(extra.id, { languages: e.target.value })}
                        className="input"
                        style={{ flex: '1 1 240px', minWidth: 200, fontSize: 13 }}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </>
        );
        })()}

        {/* Credit-only proposals add credit inline at the total instead — the
            standalone opt-in panel is the Partner Programme shape, not this one. */}
        {data.partnerProgramme.enabled && !isCreditOnly && (
          <div style={{ position: 'relative', marginTop: partnerDiscount > 0 && !isMobile ? 24 : 16, marginBottom: 16, background: '#FFFAEB', border: '1px solid #C9A227', borderRadius: 12, padding: isMobile ? 12 : 16 }}>
            {partnerDiscount > 0 && (
              // Desktop floats the "save" badge over the top-right corner. On a
              // phone that badge wraps to 2-3 lines and covers the logo/heading,
              // so it sits inline as a full-width pill above the header instead.
              <span style={isMobile
                ? { display: 'block', marginBottom: 12, background: 'linear-gradient(135deg, #FFD700 0%, #C9A227 50%, #8B6914 100%)', color: 'white', fontSize: 13, fontWeight: 700, padding: '8px 12px', borderRadius: 8, textShadow: '0 1px 2px rgba(0,0,0,0.35)', letterSpacing: 0.3, textAlign: 'center' }
                : { position: 'absolute', top: -16, right: 16, background: 'linear-gradient(135deg, #FFD700 0%, #C9A227 50%, #8B6914 100%)', color: 'white', fontSize: 14, fontWeight: 700, padding: '6px 14px', borderRadius: 999, boxShadow: '0 2px 8px rgba(146, 64, 14, 0.35), inset 0 1px 0 rgba(255,255,255,0.3)', textShadow: '0 1px 2px rgba(0,0,0,0.35)', letterSpacing: 0.3 }}>
                Secure more content today and save up to {formatPct(partnerMaxDiscount)}%
              </span>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <img
                src="/partner-logo.png"
                alt=""
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                style={{ height: 40, width: 'auto', flexShrink: 0 }}
              />
              <div style={{ fontSize: 16, fontWeight: 700, color: '#92400E' }}>
                {isCreditOnly ? 'Add more discounted content credits now' : (isOneoff ? 'Squideo Content Credit' : 'Squideo Partner Programme')} -{' '}
                <a href="https://www.squideo.com/partner-programme" target="_blank" rel="noreferrer" style={{ color: BRAND.blue }}>Click Here to Learn More</a>
              </div>
            </div>

            {(() => {
              // Two things happen the moment credit is added, and the old layout
              // presented them as two disconnected panels: a per-minute "rate card"
              // (the credit you bank) on the left, and a "% off this project"
              // explainer on the right. Clients never got the one line that sells
              // it — pay now, win twice, and both wins grow the more you add. This
              // rebuild leads with that sentence and shows the two wins as parallel
              // live tiles.
              const pct = formatPct(effectiveDiscount);
              const maxPct = formatPct(partnerMaxDiscount);
              const nextPct = formatPct(Math.min(partnerMaxDiscount, effectiveDiscount + partnerExtraPerCredit));
              const atMax = effectiveDiscount >= partnerMaxDiscount;
              // No project win when the quoted work is already free, or in
              // credit-only mode where only the added minutes are discounted.
              const showProjectWin = partnerDiscount > 0;
              const showSaveTile = combinedSaving > 0;
              const tile = { background: 'white', border: '1px solid #FDE68A', borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 4 };
              const tileHead = { fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#92400E', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 };
              const bigNum = { fontSize: 26, fontWeight: 800, color: '#0F2A3D', lineHeight: 1.1 };
              const goldGrad = 'linear-gradient(135deg, #FFD700 0%, #C9A227 50%, #8B6914 100%)';
              const greenGrad = 'linear-gradient(135deg, #22C55E 0%, #16A34A 45%, #15803D 100%)';
              const saveGreen = '#15803D';
              const goldPill = { display: 'inline-flex', alignItems: 'center', lineHeight: 1, fontSize: 12, fontWeight: 700, background: goldGrad, color: 'white', padding: '5px 10px', borderRadius: 999, textShadow: '0 1px 1px rgba(0,0,0,0.25)' };
              const savePill = { ...goldPill, background: greenGrad, boxShadow: '0 1px 4px rgba(21,128,61,0.35)' };
              // Rounded numbered badge with a soft gradient + inner highlight —
              // reads clearly as a step marker where the bare ①/② glyphs didn't.
              const numBadge = (n, grad) => (
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 999, background: grad, color: 'white', fontSize: 12, fontWeight: 800, lineHeight: 1, boxShadow: '0 1px 3px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.35)', flexShrink: 0 }}>{n}</span>
              );
              const subLine = { fontSize: 13, color: '#78350F', lineHeight: 1.5 };
              const stepBtn = (disabled) => ({ width: isMobile ? 44 : 32, height: isMobile ? 44 : 32, borderRadius: 6, border: '1px solid #FDE68A', background: '#FFFAEB', cursor: disabled ? 'default' : 'pointer', fontWeight: 700, fontSize: 18, lineHeight: 1 });
              return (
                <>
                  {/* The one sentence that sells it: pay now, win twice, both grow */}
                  {effectiveDiscount > 0 && (
                    <div style={{ ...subLine, fontSize: 14, marginBottom: 14 }}>
                      {isCreditOnly ? (
                        <>
                          <strong style={{ color: '#92400E' }}>Add more content credit now and pay less for it.</strong>{' '}
                          Your quoted {quotedMinutes > 0 ? fmtMins(quotedMinutes) : 'minutes'} stay at the standard {formatGBP(standardRatePerMin)}/min —
                          but every extra minute you add here is discounted{partnerExtraPerCredit > 0 && <>, and the more you add the bigger that discount gets</>}.
                          Use it on this content, split it across smaller pieces, or save it for later.
                        </>
                      ) : (
                        <>
                          <strong style={{ color: '#92400E' }}>{isOneoff ? 'Secure additional content now and save twice,' : 'Subscribe now and save twice,'}</strong>{' '}
                          {showProjectWin
                            ? <>we&apos;ll discount <strong>{formatGBP(partnerDiscount)} ({pct}%)</strong> off <em>this</em> project <strong>and</strong> lock every {isOneoff ? 'minute you bank' : 'monthly minute'} at the same discounted rate for future videos.</>
                            : <>we&apos;ll lock every {isOneoff ? 'minute you bank' : 'monthly minute'} at a discounted rate for future videos.</>}
                        </>
                      )}
                      {partnerExtraPerCredit > 0 && !atMax && <> Add more and {showProjectWin ? 'both discounts grow' : 'your discount grows'}, up to <strong>{maxPct}% off</strong>.</>}
                    </div>
                  )}

                  {/* One control drives both wins */}
                  <div style={{ background: 'white', border: '1px solid #FDE68A', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>{isOneoff ? 'How much extra credit?' : 'How much monthly credit?'}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <button onClick={() => !signed && setPartnerCredits(c => Math.max(1, c - 1))} disabled={!!signed || partnerCredits <= 1} style={stepBtn(!!signed || partnerCredits <= 1)}>−</button>
                      <span style={{ fontWeight: 800, fontSize: 20, minWidth: 32, textAlign: 'center' }}>{partnerCredits}</span>
                      <button onClick={() => !signed && setPartnerCredits(c => c + 1)} disabled={!!signed} style={stepBtn(!!signed)}>+</button>
                      <span style={{ fontSize: 13, color: BRAND.muted }}>{partnerCredits === 1 ? 'min' : 'mins'}{isOneoff ? '' : ' / mo'}</span>
                    </div>
                  </div>

                  {/* The two wins, side by side, both updating live with the stepper */}
                  <div style={{ display: isMobile ? 'block' : 'grid', gridTemplateColumns: showSaveTile ? '1fr 1fr' : '1fr', gap: 12, alignItems: 'stretch' }}>
                    {showSaveTile && (
                      <div style={{ ...tile, background: '#F6FEF9', border: '1px solid #A7F3D0', marginBottom: isMobile ? 12 : 0 }}>
                        <div style={{ ...tileHead, color: saveGreen }}>{numBadge(1, greenGrad)} Total you save today</div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                          <span style={{ ...bigNum, color: saveGreen }}>−{formatGBP(combinedSaving)}</span>
                          <span style={savePill}>{pct}% off</span>
                        </div>
                        <div style={subLine}>
                          {showProjectWin
                            ? <>{formatGBP(partnerDiscount)} off this project{bankedSaving > 0 && <> + {formatGBP(bankedSaving)} off {partnerCredits} banked {partnerCredits === 1 ? 'min' : 'mins'}</>}</>
                            : <>{formatGBP(bankedSaving)} off the {partnerCredits} extra {partnerCredits === 1 ? 'minute' : 'minutes'} you&apos;re adding</>}
                        </div>
                        <div style={{ ...subLine, fontSize: 12, color: BRAND.muted }}>Applied the moment you add credit.</div>
                      </div>
                    )}
                    <div style={tile}>
                      <div style={tileHead}>{numBadge(showProjectWin ? 2 : 1, goldGrad)} Your cost per minute</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                        <span style={bigNum}>{formatGBP(partnerRatePerMin)}<span style={{ fontSize: 15, fontWeight: 600, color: '#6B7785' }}>/min</span></span>
                        {effectiveDiscount > 0 && <span style={goldPill}>−{pct}%</span>}
                      </div>
                      {savingPerMin > 0 && <div style={subLine}>vs {formatGBP(standardRatePerMin)}/min standard · <strong style={{ color: saveGreen }}>save {formatGBP(savingPerMin)}/min</strong></div>}
                      <div style={{ ...subLine, fontSize: 12, color: BRAND.muted }}>{isOneoff ? '2 years to use it · on any future video content.' : 'Locked in for as long as you stay subscribed.'}</div>
                    </div>
                  </div>

                  {/* The lever: more credit → bigger discount on both, up to the cap */}
                  {partnerExtraPerCredit > 0 && (
                    <div style={{ background: '#FFFAEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#78350F', lineHeight: 1.5, marginTop: 12 }}>
                      You&apos;re at <strong>{partnerCredits} {partnerCredits === 1 ? 'min' : 'mins'} = {pct}% off</strong>.{' '}
                      {atMax
                        ? <>That&apos;s the maximum — <strong>{maxPct}% off</strong>.</>
                        : <>Add one more to reach <strong>{nextPct}%</strong>{showProjectWin ? ' on both' : ''} — up to <strong>{maxPct}%</strong>.</>}
                    </div>
                  )}

                  {/* What you pay now + terms */}
                  <div style={{ background: 'white', border: '1px solid #FDE68A', borderRadius: 8, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 15, fontWeight: 700, marginTop: 12 }}>
                    <span>{isOneoff ? 'Content credit (one-off)' : 'Monthly subscription'}</span>
                    <span>{formatGBP(partnerSubtotal)} <span style={{ color: BRAND.muted, fontWeight: 500, fontSize: 13 }}>{isOneoff ? (showVat ? '+ VAT' : '') : (showVat ? '+ VAT / month' : '/ month')}</span></span>
                  </div>
                  <div style={{ fontSize: 12, color: '#78350F', lineHeight: 1.5, padding: '6px 2px 0' }}>
                    {isOneoff
                      ? <>💳 <strong>Paid once when you sign</strong> (or via your Purchase Order). You have 2 years to use your credit — draw it down on future videos whenever you&apos;re ready.</>
                      : <>💳 <strong>First month charged when you sign.</strong> Renews monthly - cancel any time, even mid-project.</>}
                  </div>

                  {/* Detail essay collapsed — decision-critical info is already above */}
                  {data.partnerProgramme.description && (
                    <div style={{ marginTop: 14 }}>
                      <button
                        type="button"
                        onClick={() => setPartnerHowOpen(o => !o)}
                        aria-expanded={partnerHowOpen}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, color: BRAND.blue }}
                      >
                        <span style={{ transform: partnerHowOpen ? 'rotate(90deg)' : 'none', transition: 'transform 120ms', display: 'inline-block' }}>▸</span>
                        How it works
                      </button>
                      {partnerHowOpen && (
                        <div style={{ marginTop: 10, background: 'white', border: '1px solid #FDE68A', borderRadius: 10, padding: '14px 18px' }}>
                          {renderDescriptionMarkup((data.partnerProgramme.description || '').replace(/^\s*\d+\s+minute(?:s)?\s+of\s+additional\s+content\s+credit\s+per\s+month\s*[-–—]\s*Cancel\s+any\s+time\s*\n+/i, ''))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              );
            })()}

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
                {(() => {
                  // In credit-only mode the saving lives entirely on the added
                  // minutes, so the CTA quotes combinedSaving rather than the
                  // (always zero) project discount.
                  const ctaLabel = isCreditOnly ? 'Add content credit' : (isOneoff ? 'Add Content Credit' : 'Opt in to Partner Programme');
                  const doneLabel = isOneoff ? 'Added' : 'Joined';
                  const saveText = `${formatGBP(combinedSaving)} (${formatPct(effectiveDiscount)}% off)`;
                  if (partnerSelected) {
                    return combinedSaving > 0
                      ? `✓ ${doneLabel} - saving ${saveText} - click to remove`
                      : `✓ ${doneLabel} - click to remove`;
                  }
                  return combinedSaving > 0 ? `${ctaLabel} - save ${saveText}` : ctaLabel;
                })()}
              </button>
              <div style={{ fontSize: 12, color: '#5D8A00', textAlign: 'center', marginTop: 8 }}>{isOneoff ? '✓ One-off purchase  ·  Credit for future videos' : '✓ Cancel any time  ·  No minimum term'}</div>
            </div>
          </div>
        )}

        {/* Credit-only already showed the credit box above, so the closing total
            is a slim grand total that folds in whatever extras were ticked. */}
        {isCreditOnly ? (
          <div style={{ background: BRAND.ink, color: 'white', padding: 20, borderRadius: 10, marginBottom: 32 }}>
            {extrasTotal > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6, opacity: 0.85 }}>
                  <span>Content credit{partnerSelected && partnerCredits > 0 ? ` (${fmtMins(quotedMinutes + partnerCredits)})` : ''}</span>
                  <span>{formatGBP(netBasePrice + (partnerSelected ? partnerSubtotal : 0))}{showVat && ' + VAT'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 12, opacity: 0.85 }}>
                  <span>Optional extras</span>
                  <span>{formatGBP(extrasTotal)}{showVat && ' + VAT'}</span>
                </div>
              </>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontWeight: 700, paddingTop: extrasTotal > 0 ? 12 : 0, borderTop: extrasTotal > 0 ? '1px solid rgba(255,255,255,0.2)' : 'none' }}>
              <span>Total</span>
              <span>
                {formatGBP(discountedSubtotal + (partnerSelected ? partnerSubtotal : 0))} {showVat && <span style={{ fontWeight: 500, fontSize: 14, opacity: 0.7 }}>+ VAT <span style={{ opacity: 0.55 }}>· {incVat(discountedSubtotal + (partnerSelected ? partnerSubtotal : 0))} inc.</span></span>}
              </span>
            </div>
          </div>
        ) : (
        <div style={{ background: BRAND.ink, color: 'white', padding: 20, borderRadius: 10, marginBottom: 32 }}>
          {showPartnerProjectDiscount && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6, opacity: 0.8 }}>
              <span>Project price (without Partner)</span>
              <span style={{ textDecoration: 'line-through' }}>{formatGBP(subtotal)}{showVat && ' + VAT'}</span>
            </div>
          )}
          {showPartnerProjectDiscount && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 12, color: '#FFD54F' }}>
              <span>Partner discount ({formatPct(effectiveDiscount)}%)</span>
              <span>−{formatGBP(partnerDiscount)}{showVat && ' + VAT'}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: showPartnerProjectDiscount ? 15 : 18, fontWeight: showPartnerProjectDiscount ? 600 : 700, paddingTop: showPartnerProjectDiscount ? 12 : 0, borderTop: showPartnerProjectDiscount ? '1px solid rgba(255,255,255,0.2)' : 'none' }}>
            <span>{showPartnerProjectDiscount ? 'Project (discounted)' : `Project total${extrasTotal > 0 ? ' (including selected extras)' : ''}`}</span>
            <span>
              {formatGBP(showPartnerProjectDiscount ? discountedSubtotal : subtotal)} {showVat && <span style={{ fontWeight: 500, fontSize: 14, opacity: 0.7 }}>+ VAT <span style={{ opacity: 0.55 }}>· {incVat(showPartnerProjectDiscount ? discountedSubtotal : subtotal)} inc.</span></span>}
            </span>
          </div>
          {partnerSelected && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 600, marginTop: 6 }}>
                <span>
                  {isCreditOnly ? '+ Extra content credit' : (isOneoff ? '+ Content credit' : '+ First month Partner Programme')}
                  <span style={{ opacity: 0.7, fontWeight: 500, fontSize: 13, marginLeft: 6 }}>
                    ({partnerCredits} {partnerCredits === 1 ? 'min' : 'mins'}{isOneoff ? '' : '/mo'})
                  </span>
                </span>
                <span>{formatGBP(partnerSubtotal)} {showVat && <span style={{ fontWeight: 500, fontSize: 13, opacity: 0.7 }}>+ VAT</span>}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontWeight: 700, marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.2)' }}>
                <span>{isOneoff ? (paymentOption === 'po' ? 'Order total (to invoice)' : 'Order total') : 'Due today'}</span>
                <span>{formatGBP(discountedSubtotal + partnerSubtotal)} {showVat && <span style={{ fontWeight: 500, fontSize: 14, opacity: 0.7 }}>+ VAT <span style={{ opacity: 0.55 }}>· {incVat(discountedSubtotal + partnerSubtotal)} inc.</span></span>}</span>
              </div>
              {isOneoff ? (
                paymentOption === '5050' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 8, color: '#FFD54F' }}>
                    <span>{formatGBP((discountedSubtotal + partnerSubtotal) / 2)}{showVat && ' + VAT'} due today, the balance on final approval.</span>
                  </div>
                )
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 8, color: '#FFD54F' }}>
                  <span>Then {formatGBP(partnerSubtotal)}{showVat && ' + VAT'} / month for {partnerCredits} {partnerCredits === 1 ? 'min' : 'mins'} of content credit, cancel any time</span>
                  <span></span>
                </div>
              )}
            </>
          )}
        </div>
        )}

        <PageTitle>Payment Options</PageTitle>
        {partnerSelected && !isOneoff && (
          <div style={{ background: '#FFFAEB', border: '1px solid #FDE68A', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#78350F', lineHeight: 1.5, marginBottom: 12 }}>
            <strong>Partner Programme selected.</strong> {showPartnerProjectDiscount ? `To unlock the ${formatPct(effectiveDiscount)}% project discount, payment` : 'Payment'} must be made in full (card/BACS). The 50/50 split is not available with the Partner Programme.
          </div>
        )}
        {partnerSelected && isOneoff && (
          <div style={{ background: '#FFFAEB', border: '1px solid #FDE68A', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#78350F', lineHeight: 1.5, marginBottom: 12 }}>
            <strong>Content Credit selected.</strong> Most organisations raise a <strong>Purchase Order</strong> for this — but you can also pay in full or split 50/50, whichever suits your procurement.
          </div>
        )}
        <div style={{ display: 'grid', gap: 12, marginBottom: 12 }}>
          {(() => {
            const subtitlesPrice = data.optionalExtras.find(e => e.id === 'subtitles')?.price ?? 125;
            const fullIncentive = data.paymentOptionDescs?.full?.trim() || `get a free subtitled version (worth £${subtitlesPrice})`;
            const incentiveOn = data.payInFullIncentive !== false;
            const fullTitle = (partnerSelected || !incentiveOn) ? 'Pay in full' : `Pay in full - ${fullIncentive}`;
            const OPTION_CONFIG = {
              '5050': { title: '50/50 split', desc: '50% deposit to start, balance invoiced when you approve the final video.' },
              'full': { title: fullTitle, desc: 'Pay upfront via card or BACS.' },
              'po': { title: 'Purchase Order', desc: 'Raise a Purchase Order - our team will be in touch to set up supplier details and confirm payment.' },
            };
            return (data.paymentOptions || ['5050', 'full']).map((key) => {
              const cfg = OPTION_CONFIG[key];
              if (!cfg) return null;
              // The one-off Content Credit can still be split 50/50; only the
              // recurring subscription locks it.
              const lockedByPartner = key === '5050' && partnerSelected && !isOneoff;
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
                  recommended={isOneoff && partnerSelected && key === 'po'}
                />
              );
            });
          })()}
        </div>
        {(() => {
          // One-off Content Credit folds the credit block into the order, and the
          // 50/50 split is available on the combined total. The subscription
          // variant keeps its "project now + monthly credit" split.
          const combinedExVat = discountedSubtotal + partnerSubtotal;
          const exVat = (partnerSelected && !isOneoff) ? discountedSubtotal : (partnerSelected ? combinedExVat : subtotal);
          const half = exVat / 2;
          const vatNote = showVat ? <span style={{ color: BRAND.muted, fontWeight: 500 }}>+ VAT</span> : null;
          const dueExVat = partnerSelected ? combinedExVat : exVat;
          let line = null;
          if (paymentOption === '5050') {
            line = (partnerSelected && isOneoff)
              ? <>You pay <strong style={{ color: BRAND.blue }}>{formatGBP(half)}</strong> {vatNote} today ({formatGBP(discountedSubtotal)} project + {formatGBP(partnerSubtotal)} content credit, split 50/50), <strong>{formatGBP(half)}</strong> {vatNote} on final approval.</>
              : <>You pay <strong style={{ color: BRAND.blue }}>{formatGBP(half)}</strong> {vatNote} today, <strong>{formatGBP(half)}</strong> {vatNote} on final approval.</>;
          } else if (paymentOption === 'full') {
            line = partnerSelected
              ? (isOneoff
                  ? <>You pay <strong style={{ color: BRAND.blue }}>{formatGBP(dueExVat)}</strong> {vatNote} today ({formatGBP(discountedSubtotal)} project + {formatGBP(partnerSubtotal)} content credit). Credit is yours to use on future videos.</>
                  : <>You pay <strong style={{ color: BRAND.blue }}>{formatGBP(dueExVat)}</strong> {vatNote} today ({formatGBP(discountedSubtotal)} project + {formatGBP(partnerSubtotal)} first month Partner Programme), then {formatGBP(partnerSubtotal)} {vatNote}/month - cancel any time.</>)
              : <>You pay <strong style={{ color: BRAND.blue }}>{formatGBP(exVat)}</strong> {vatNote} today.</>;
          } else if (paymentOption === 'po') {
            line = partnerSelected
              ? (isOneoff
                  ? <>We&apos;ll invoice <strong style={{ color: BRAND.blue }}>{formatGBP(dueExVat)}</strong> {vatNote} once your Purchase Order is set up ({formatGBP(discountedSubtotal)} project + {formatGBP(partnerSubtotal)} content credit). Credit is yours to use on future videos.</>
                  : <>We&apos;ll invoice <strong style={{ color: BRAND.blue }}>{formatGBP(dueExVat)}</strong> {vatNote} once your Purchase Order is set up ({formatGBP(discountedSubtotal)} project + {formatGBP(partnerSubtotal)} first month Partner Programme), then {formatGBP(partnerSubtotal)} {vatNote}/month.</>)
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
            previewMode={isPreview}
            dealInvoices={dealInvoices}
            paymentChoice={paymentChoice}
            vatRate={data.vatRate}
            onPayNow={handlePayNow}
            onChoosePay={() => setPaymentChoice('pay')}
            onChooseInvoice={() => {
              setPaymentChoice('invoice');
              // Heads-up to the team that this client wants an invoice (they
              // may not finish issuing it). Fire-and-forget; deduped server-side.
              if (!isPreview) {
                fetch('/api/xero/invoice-intent', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ proposalId: id }),
                  keepalive: true,
                }).catch(() => {});
              }
            }}
            onUndoInvoice={() => setPaymentChoice('pay')}
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
            <Field label="Your signature">
              <SignaturePad value={sigImage} onChange={setSigImage} />
            </Field>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 0', cursor: 'pointer', fontSize: 14 }}>
              <input type="checkbox" checked={sigAccepted} onChange={(e) => setSigAccepted(e.target.checked)} style={{ marginTop: 3 }} />
              <span>
                I accept this proposal and authorise Squideo to begin work. By typing my name and signing above, I am providing my electronic signature
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
                    {formatGBP(discountedSubtotal)} project + {formatGBP(partnerSubtotal)} {isOneoff ? 'content credit' : 'first month'} = <strong>{formatGBP(discountedSubtotal + partnerSubtotal)}{showVat && ' + VAT'}</strong>{showVat && <span style={{ opacity: 0.75 }}> · {incVat(discountedSubtotal + partnerSubtotal)} inc.</span>}
                  </>
                ) : (
                  <>
                    <strong>{formatGBP(subtotal)}{showVat && ' + VAT'}</strong>{showVat && <span style={{ opacity: 0.75 }}> · {incVat(subtotal)} inc.</span>}
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
          partnerOneoff={isOneoff}
          showVat={showVat}
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
