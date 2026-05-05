import { SQUIDEO_LOGO } from '../defaults.js';
import { CONFIG, DEFAULT_PHOTOS } from '../theme.js';
import { formatGBP } from '../utils.js';

// Resolve relative public paths to absolute so they load inside the popup window.
const abs = (src) => src && src.startsWith('/') ? window.location.origin + src : src;

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Mirror of renderDescriptionMarkup in ClientView — same parser, HTML output
// for the printed PDF. Paragraphs, sub-headings (lines ending with `:`), and
// dash-bullet lists rendered as proper <p>/<h4>/<ul><li>.
function renderDescriptionHTML(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const parts = [];
  let buffer = [];
  let listItems = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const joined = buffer.join(' ').trim();
    if (!joined) { buffer = []; return; }
    if (buffer.length === 1 && /:\s*$/.test(buffer[0].trim())) {
      parts.push(`<h4 style="font-size:14px;font-weight:700;color:#0F2A3D;margin:14px 0 6px;">${esc(joined)}</h4>`);
    } else {
      parts.push(`<p style="margin:0 0 10px;font-size:13px;color:#0F2A3D;line-height:1.7;">${esc(joined)}</p>`);
    }
    buffer = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems.map(it => `<li style="margin-bottom:2px;">${esc(it)}</li>`).join('');
    parts.push(`<ul style="margin:0 0 10px;padding-left:22px;color:#6B7785;font-size:13px;line-height:1.7;">${items}</ul>`);
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

  return parts.join('');
}

const PAYMENT_OPTION_LABEL = {
  '5050': '50/50 split (50% deposit, balance on approval)',
  'full': 'Pay in full upfront',
  'po': 'Purchase Order',
};

export function printOptionsForSigned(signed, payment) {
  if (!signed) return { signable: true };
  const selectedExtras = (signed.selectedExtras || []).reduce((acc, e) => {
    if (e && e.id) acc[e.id] = true;
    return acc;
  }, {});
  return {
    signable: false,
    signed,
    payment: payment || null,
    selectedExtras,
    partnerSelected: !!signed.partnerSelected,
    paymentOption: signed.paymentOption || '5050',
  };
}

function buildPrintHTML(data, { signable = false, selectedExtras = {}, paymentOption = '5050', partnerSelected = false, signed = null, payment = null } = {}) {
  const extrasTotal = data.optionalExtras.reduce((s, e) => selectedExtras[e.id] ? s + e.price : s, 0);
  const subtotal = data.basePrice + extrasTotal;
  const vat = subtotal * data.vatRate;
  const total = subtotal + vat;
  // Pick the rate to render the discount line at:
  // - When the proposal is already signed, use the locked-in rate from the signature.
  // - Otherwise compute from the partner-programme tier ladder (default to base, since
  //   unsigned PDFs don't carry the client's selected credit count).
  const baseDiscount = data.partnerProgramme.discountRate ?? 0.10;
  const extraPerCredit = data.partnerProgramme.extraDiscountPerCredit ?? 0;
  const maxDiscount = data.partnerProgramme.maxDiscount ?? baseDiscount;
  const printedCredits = signed?.partnerCredits || 1;
  const computedDiscount = Math.min(
    baseDiscount + Math.max(0, printedCredits - 1) * extraPerCredit,
    maxDiscount
  );
  const lockedDiscount = signed?.amountBreakdown?.discountRate;
  const discountRate = partnerSelected
    ? (typeof lockedDiscount === 'number' ? lockedDiscount : computedDiscount)
    : 0;
  const partnerDiscount = subtotal * discountRate;
  const discountedSubtotal = subtotal - partnerDiscount;
  const discountedVat = discountedSubtotal * data.vatRate;
  const discountedTotal = discountedSubtotal + discountedVat;

  const teamCards = data.team.map(m => {
    const photoSrc = abs(m.photo || DEFAULT_PHOTOS[m.name] || '');
    const photoEl = photoSrc
      ? `<img src="${esc(photoSrc)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid #2BB8E6;flex-shrink:0;" />`
      : `<div style="width:56px;height:56px;border-radius:50%;background:#2BB8E6;color:white;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;flex-shrink:0;">${esc(m.name[0])}</div>`;
    return `
      <div style="border:1px solid #E5E9EE;border-radius:10px;padding:16px;break-inside:avoid;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
          ${photoEl}
          <div>
            <div style="font-weight:600;font-size:15px;">${esc(m.name)}</div>
            <div style="font-size:12px;color:#6B7785;">${esc(m.role)}</div>
          </div>
        </div>
        <p style="font-size:13px;color:#6B7785;line-height:1.5;margin:0;">${esc(m.bio)}</p>
      </div>`;
  }).join('');

  const inclusionRows = data.baseInclusions.map(inc => `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid #E5E9EE;font-size:13px;">
      <span style="color:#2BB8E6;flex-shrink:0;font-size:16px;line-height:1;">✓</span>
      <div>
        <div style="font-weight:500;">${esc(inc.title)}</div>
        ${inc.description ? `<div style="font-size:12px;color:#6B7785;margin-top:2px;">${esc(inc.description)}</div>` : ''}
      </div>
    </div>`).join('');

  const extrasRows = data.optionalExtras.map(e => {
    const checked = !!selectedExtras[e.id];
    const box = signable
      ? `<input type="checkbox" ${checked ? 'checked' : ''} style="margin-top:2px;flex-shrink:0;" />`
      : `<div style="width:14px;height:14px;border:2px solid #C7CFD8;border-radius:3px;flex-shrink:0;background:${checked ? '#2BB8E6' : 'white'};"></div>`;
    return `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid #E5E9EE;font-size:13px;">
        ${box}
        <div style="flex:1;">
          <div style="font-weight:500;">${esc(e.label)}</div>
          ${e.description ? `<div style="font-size:12px;color:#6B7785;margin-top:2px;">${esc(e.description)}</div>` : ''}
        </div>
        <div style="font-weight:600;white-space:nowrap;">${formatGBP(e.price)}</div>
      </div>`;
  }).join('');

  const clientLogoBlock = data.clientLogo ? `
    <div style="text-align:center;padding:24px;border:1px solid #E5E9EE;border-radius:12px;margin-bottom:28px;">
      <div style="font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Prepared for</div>
      <img src="${esc(data.clientLogo)}" style="max-width:200px;max-height:100px;object-fit:contain;" />
      ${data.contactBusinessName ? `<div style="font-size:14px;color:#6B7785;margin-top:8px;">${esc(data.contactBusinessName)}</div>` : ''}
    </div>` : '';

  const partnerBlock = data.partnerProgramme.enabled ? (() => {
    const box = signable
      ? `<input type="checkbox" ${partnerSelected ? 'checked' : ''} style="margin-top:2px;flex-shrink:0;" />`
      : `<div style="width:14px;height:14px;border:2px solid #C7CFD8;border-radius:3px;flex-shrink:0;background:${partnerSelected ? '#2BB8E6' : 'white'};"></div>`;

    // Future-rate panel mirrors the same tier ladder as the project discount.
    // For a signed proposal we display the locked-in rate; for unsigned we use
    // the base discount (which is what a 1-credit subscription would yield).
    const standardRate = Number(data.basePrice) || 0;
    const printPct = (typeof discountRate === 'number' && discountRate > 0)
      ? discountRate
      : (data.partnerProgramme.discountRate ?? 0.10);
    const futureRate = standardRate * (1 - printPct);
    const savingPerMin = standardRate - futureRate;
    const futurePct = Math.round(printPct * 100);
    const futureRatePanel = (standardRate > 0 && futureRate > 0 && futurePct > 0) ? `
      <div style="background:white;border:1px solid #FDE68A;border-radius:8px;padding:14px 16px;margin-bottom:14px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#92400E;margin-bottom:8px;">Your future video rate</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px;">
          <div style="background:#F8FAFC;border:1px solid #E5E9EE;border-radius:8px;padding:8px 10px;text-align:center;">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#6B7785;margin-bottom:4px;">Standard</div>
            <div style="font-size:14px;font-weight:700;color:#6B7785;text-decoration:line-through;">${formatGBP(standardRate)}/min</div>
          </div>
          <div style="background:#FFFAEB;border:1px solid #FDE68A;border-radius:8px;padding:8px 10px;text-align:center;">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#6B7785;margin-bottom:4px;">Partner rate</div>
            <div style="font-size:14px;font-weight:700;color:#92400E;">${formatGBP(futureRate)}/min</div>
          </div>
          <div style="background:#FFFAEB;border:1px solid #FDE68A;border-radius:8px;padding:8px 10px;text-align:center;">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#6B7785;margin-bottom:4px;">You save</div>
            <div style="font-size:14px;font-weight:700;color:#92400E;">${futurePct}% &middot; ${formatGBP(savingPerMin)}</div>
          </div>
        </div>
        <div style="font-size:12px;color:#78350F;line-height:1.5;">
          Lock in <strong>${futurePct}% off</strong> every future minute of content for as long as you stay subscribed.
        </div>
      </div>
    ` : '';

    return `
    <div style="border:1px solid #E5E9EE;border-radius:10px;padding:20px;margin:20px 0;">
      <div style="font-size:16px;font-weight:700;margin:0 0 10px;">
        Squideo Partner Programme &mdash;
        <a href="https://www.squideo.com/partner-programme" style="color:#2BB8E6;text-decoration:none;">Click Here to Learn More</a>
      </div>
      ${futureRatePanel}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
        ${box}
        <span style="font-size:14px;font-weight:600;">Check to subscribe (Monthly - ${formatGBP(data.partnerProgramme.price * (1 + data.vatRate))}/mo)</span>
      </div>
      <div style="border:1px solid #E5E9EE;border-radius:8px;padding:14px 16px;line-height:1.7;color:#0F2A3D;">
        ${renderDescriptionHTML(data.partnerProgramme.description)}
      </div>
    </div>`;
  })() : '';

  const blankSigBlock = `
    <div style="border:2px solid #2BB8E6;border-radius:12px;padding:28px;margin-top:32px;break-inside:avoid;">
      <h2 style="font-size:18px;font-weight:700;margin:0 0 20px;">Acceptance & Signature</h2>
      <p style="font-size:13px;color:#6B7785;margin:0 0 24px;line-height:1.6;">
        By signing below, I confirm that I have read and accept this proposal and authorise Squideo Ltd to commence work as described.
      </p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-bottom:24px;">
        <div>
          <div style="font-size:12px;color:#6B7785;margin-bottom:6px;">Full name</div>
          <div style="border-bottom:1px solid #0F2A3D;height:28px;"></div>
        </div>
        <div>
          <div style="font-size:12px;color:#6B7785;margin-bottom:6px;">Job title / position</div>
          <div style="border-bottom:1px solid #0F2A3D;height:28px;"></div>
        </div>
        <div>
          <div style="font-size:12px;color:#6B7785;margin-bottom:6px;">Signature</div>
          <div style="border-bottom:1px solid #0F2A3D;height:40px;"></div>
        </div>
        <div>
          <div style="font-size:12px;color:#6B7785;margin-bottom:6px;">Date</div>
          <div style="border-bottom:1px solid #0F2A3D;height:28px;"></div>
        </div>
      </div>
      <div>
        <div style="font-size:12px;color:#6B7785;margin-bottom:6px;">Company name</div>
        <div style="border-bottom:1px solid #0F2A3D;height:28px;"></div>
      </div>
      <p style="font-size:11px;color:#6B7785;margin:20px 0 0;line-height:1.5;">
        Please return the signed copy to <strong>hello@squideo.com</strong> or post to Squideo Ltd, Hull, HU1.
        This proposal is valid for ${data.validityDays || 28} days from the date above.
      </p>
    </div>`;

  const acceptedSigBlock = signed ? (() => {
    const signedDate = signed.signedAt ? new Date(signed.signedAt).toLocaleString('en-GB') : '';
    const totalCommitted = typeof signed.total === 'number' ? signed.total : null;
    const optLabel = PAYMENT_OPTION_LABEL[signed.paymentOption] || signed.paymentOption || '';
    const paidLine = payment ? `
      <div style="margin-top:18px;padding-top:18px;border-top:1px solid #BBF7D0;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <div style="background:#2BB8E6;color:white;padding:5px 14px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:0.5px;">PAID</div>
        <div style="font-size:14px;color:#0F2A3D;">
          <strong>${formatGBP(payment.amount || 0)}</strong>
          ${payment.paymentType === 'deposit' ? ' (50% deposit)' : payment.paymentType === 'full' ? ' (full payment)' : ''}
          ${payment.paidAt ? ' · ' + esc(new Date(payment.paidAt).toLocaleString('en-GB')) : ''}
        </div>
      </div>` : '';
    return `
    <div style="border:2px solid #16A34A;background:#F0FDF4;border-radius:12px;padding:28px;margin-top:32px;break-inside:avoid;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;">
        <div style="width:32px;height:32px;border-radius:50%;background:#16A34A;color:white;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;">✓</div>
        <h2 style="font-size:20px;font-weight:700;margin:0;color:#15803D;">Proposal Accepted</h2>
      </div>
      <div style="font-size:14px;line-height:1.9;color:#166534;">
        <div><strong>Signed by:</strong> ${esc(signed.name || '')}${signed.email ? ' (' + esc(signed.email) + ')' : ''}</div>
        ${signedDate ? `<div><strong>Date:</strong> ${esc(signedDate)}</div>` : ''}
        ${optLabel ? `<div><strong>Payment option:</strong> ${esc(optLabel)}</div>` : ''}
        ${signed.partnerSelected && signed.amountBreakdown ? `
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid #BBF7D0;">
            <div style="display:flex;justify-content:space-between;"><span>Project (discounted)</span><span><strong>${formatGBP(signed.amountBreakdown.projectExVat)}</strong> + VAT</span></div>
            <div style="display:flex;justify-content:space-between;"><span>First month Partner Programme</span><span><strong>${formatGBP(signed.amountBreakdown.partnerExVat)}</strong> + VAT</span></div>
            <div style="display:flex;justify-content:space-between;margin-top:6px;padding-top:6px;border-top:1px solid #BBF7D0;font-weight:700;"><span>Total committed today</span><span>${formatGBP(signed.amountBreakdown.projectExVat + signed.amountBreakdown.partnerExVat)} + VAT</span></div>
            <div style="font-size:12px;color:#15803D;margin-top:6px;">Then ${formatGBP(signed.amountBreakdown.partnerExVat)} + VAT / month - cancel any time.</div>
          </div>
        ` : (totalCommitted !== null ? `<div><strong>Total committed:</strong> ${formatGBP(totalCommitted)}</div>` : '')}
      </div>
      ${paidLine}
      <p style="margin:20px 0 0;font-size:11px;color:#166534;line-height:1.5;font-style:italic;">
        This document confirms electronic acceptance of the proposal via the Squideo Proposals portal. By typing their name on the acceptance form, the signatory provided their electronic signature.
      </p>
    </div>`;
  })() : '';

  const sigBlock = signed ? acceptedSigBlock : blankSigBlock;
  const headerStatusBadge = signed
    ? `<span style="display:inline-block;background:#16A34A;color:white;font-size:11px;font-weight:700;letter-spacing:0.5px;padding:4px 10px;border-radius:999px;margin-left:10px;vertical-align:middle;">ACCEPTED</span>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Squideo Proposal - ${esc(data.contactBusinessName || data.clientName || 'Untitled')}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, system-ui, sans-serif; color: #0F2A3D; background: white; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
    }
    @media screen {
      body { max-width: 820px; margin: 0 auto; padding: 32px 24px; }
    }
    .page-title { font-size: 18px; font-weight: 700; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #2BB8E6; }
    .muted { color: #6B7785; }
  </style>
</head>
<body>
  <div class="no-print" style="background:#FFF8E1;border:1px solid #FFE082;padding:12px 20px;text-align:center;font-size:13px;color:#8A6D00;margin-bottom:24px;border-radius:6px;">
    Use your browser's <strong>File → Print</strong> (or Ctrl+P / ⌘P) to save as PDF or print.
    <button onclick="window.print()" style="margin-left:16px;padding:6px 14px;background:#2BB8E6;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;">Print / Save as PDF</button>
  </div>

  <!-- Header -->
  <div style="background:#2BB8E6;color:white;padding:32px;border-radius:12px;margin-bottom:28px;">
    <img src="${SQUIDEO_LOGO}" alt="Squideo" style="height:44px;width:auto;display:block;margin-bottom:20px;" />
    <h1 style="font-size:26px;font-weight:700;margin:0 0 14px;line-height:1.2;">Explainer Video Proposal${headerStatusBadge}</h1>
    <div style="font-size:15px;line-height:1.6;opacity:0.95;">
      <div>Prepared for <strong>${esc(data.clientName || '[Client Name]')}</strong></div>
      <div>${esc(data.contactBusinessName || '')}</div>
      <div style="margin-top:6px;font-size:13px;opacity:0.85;">${esc(data.date)}</div>
    </div>
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.25);display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;font-size:13px;">
      <div style="display:flex;align-items:center;gap:10px;">
        ${DEFAULT_PHOTOS[data.preparedBy] ? `<img src="${abs(DEFAULT_PHOTOS[data.preparedBy])}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,0.4);flex-shrink:0;" />` : ''}
        <div>
          <div>By <strong>${esc(data.preparedBy)}</strong></div>
          ${data.preparedByTitle ? `<div style="font-size:11px;opacity:0.8;">${esc(data.preparedByTitle)}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:16px;opacity:0.9;">
        <span>${esc(CONFIG.company.website)}</span>
        <span>${esc(CONFIG.company.phone)}</span>
      </div>
    </div>
  </div>

  ${clientLogoBlock}

  <!-- Intro -->
  <h2 class="page-title">Thank You for Considering Squideo</h2>
  ${data.intro.split('\n\n').map(p => `<p style="font-size:13px;line-height:1.7;margin:0 0 10px;">${esc(p)}</p>`).join('')}

  <!-- Team -->
  <h2 class="page-title">Your Delivery Team</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-bottom:14px;">
    ${teamCards}
  </div>
  <div style="border:1px solid #E5E9EE;border-radius:10px;padding:20px;margin-bottom:28px;display:flex;gap:24px;align-items:center;flex-wrap:wrap;break-inside:avoid;">
    <img src="${abs('/team-photos/producers.png')}" style="width:220px;border-radius:10px;object-fit:cover;flex-shrink:0;" />
    <div style="flex:1;min-width:200px;">
      <div style="font-weight:600;font-size:15px;margin-bottom:8px;">Our Producers</div>
      <p style="font-size:13px;color:#6B7785;line-height:1.5;margin:0;">Our experienced producers will be involved throughout the production process, each contributing their expertise to ensure the highest standard of work. You'll have the opportunity to communicate with them directly at key stages of the project, from initial planning through to final delivery. Every member of our production team takes pride in delivering exceptional results that reflect Squideo's commitment to quality and creativity.</p>
    </div>
  </div>

  <!-- Requirement -->
  <h2 class="page-title">Your Requirement</h2>
  <p style="font-size:13px;font-weight:500;line-height:1.7;white-space:pre-wrap;">${esc(data.requirement)}</p>
  ${data.projectVision ? `<h3 style="font-size:15px;font-weight:600;margin:18px 0 6px;">Project Vision</h3><p style="font-size:13px;line-height:1.7;white-space:pre-wrap;">${esc(data.projectVision)}</p>` : ''}

  <!-- Quote -->
  <h2 class="page-title">Your Quote</h2>
  <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;">What's included:</h3>
  <div style="border:1px solid #E5E9EE;border-radius:10px;padding:12px 16px;margin-bottom:16px;">
    ${inclusionRows}
  </div>

  <!-- Base pricing -->
  <div style="border:1px solid #E5E9EE;border-radius:8px;overflow:hidden;margin-bottom:20px;">
    <div style="display:flex;justify-content:space-between;padding:10px 16px;font-size:13px;border-bottom:1px solid #E5E9EE;">
      <span class="muted">Subtotal</span><span>${formatGBP(data.basePrice)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:10px 16px;font-size:13px;border-bottom:1px solid #E5E9EE;">
      <span class="muted">VAT (${(data.vatRate * 100).toFixed(0)}%)</span><span>${formatGBP(data.basePrice * data.vatRate)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:12px 16px;font-size:16px;font-weight:700;background:#F8FAFC;">
      <span>Base total</span><span>${formatGBP(data.basePrice * (1 + data.vatRate))}</span>
    </div>
  </div>

  ${partnerBlock}

  <!-- Optional extras -->
  <h2 class="page-title">Optional Extras</h2>
  <div style="border:1px solid #E5E9EE;border-radius:10px;padding:4px 16px;margin-bottom:16px;">
    ${extrasRows}
  </div>

  <!-- Total summary (when extras selected or partner discount applies) -->
  ${(extrasTotal > 0 || partnerSelected) ? `
  <div style="background:#0F2A3D;color:white;padding:16px 20px;border-radius:10px;margin-bottom:28px;">
    <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;opacity:0.8;"><span>Subtotal${extrasTotal > 0 ? ' (with selected extras)' : ''}</span><span>${formatGBP(partnerSelected ? discountedSubtotal : subtotal)}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:${partnerSelected ? '4px' : '10px'};opacity:0.8;"><span>VAT</span><span>${formatGBP(partnerSelected ? discountedVat : vat)}</span></div>
    ${partnerSelected ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:10px;color:#FFD54F;"><span>${Math.round(discountRate * 100)}% partner discount</span><span>−${formatGBP(partnerDiscount)}</span></div>` : ''}
    <div style="display:flex;justify-content:space-between;font-size:17px;font-weight:700;padding-top:10px;border-top:1px solid rgba(255,255,255,0.2);">
      <span>Project total</span>
      <span>${partnerSelected ? `<span style="font-weight:400;font-size:13px;opacity:0.5;text-decoration:line-through;margin-right:8px;">${formatGBP(total)}</span>` : ''}${formatGBP(partnerSelected ? discountedTotal : total)}</span>
    </div>
  </div>` : ''}

  <!-- Payment options -->
  <h2 class="page-title">Payment Options</h2>
  <div style="display:grid;gap:10px;margin-bottom:28px;">
    <div style="border:2px solid ${paymentOption === '5050' ? '#2BB8E6' : '#E5E9EE'};border-radius:10px;padding:14px 16px;background:${paymentOption === '5050' ? '#F0F9FF' : 'white'};">
      <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${paymentOption === '5050' ? '✓ ' : ''}50/50 split</div>
      <div style="font-size:13px;color:#6B7785;">50% deposit to start, balance invoiced when you approve the final video.</div>
    </div>
    <div style="border:2px solid ${paymentOption === 'full' ? '#2BB8E6' : '#E5E9EE'};border-radius:10px;padding:14px 16px;background:${paymentOption === 'full' ? '#F0F9FF' : 'white'};">
      <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${paymentOption === 'full' ? '✓ ' : ''}${partnerSelected ? 'Pay in full' : 'Pay in full - get a free subtitled version (worth £125)'}</div>
      <div style="font-size:13px;color:#6B7785;">Pay upfront via card or BACS.</div>
    </div>
  </div>

  ${sigBlock}

  <!-- Footer -->
  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #E5E9EE;font-size:11px;color:#6B7785;text-align:center;">
    ${esc(CONFIG.company.name)} · ${esc(CONFIG.company.website)} · ${esc(CONFIG.company.phone)}
  </div>
</body>
</html>`;
}

export function openPrintWindow(data, opts = {}) {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(buildPrintHTML(data, opts));
  w.document.close();
  return true;
}

function buildReceiptHTML(data, signed, payment) {
  const vatRate = Number(data.vatRate) || 0;
  const paidAt = payment.paidAt ? new Date(payment.paidAt) : new Date();
  const paidAtStr = paidAt.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // Compose line items from what was actually charged.
  const lineItems = [];
  if (signed.partnerSelected && signed.amountBreakdown) {
    const { projectExVat, partnerExVat, partnerCredits } = signed.amountBreakdown;
    lineItems.push({
      label: 'Video production - discounted project',
      sub: data.proposalTitle || data.clientName || '',
      ex: projectExVat,
    });
    lineItems.push({
      label: 'Squideo Partner Programme - first month' + (partnerCredits ? ` (${partnerCredits} min credit)` : ''),
      sub: '',
      ex: partnerExVat,
    });
  } else {
    const isDeposit = payment.paymentType === 'deposit';
    const exVat = vatRate > 0 ? payment.amount / (1 + vatRate) : payment.amount;
    lineItems.push({
      label: isDeposit ? 'Video production - 50% deposit' : 'Video production - full payment',
      sub: data.proposalTitle || data.clientName || '',
      ex: exVat,
    });
  }

  const subtotalEx = lineItems.reduce((s, li) => s + li.ex, 0);
  const vat = subtotalEx * vatRate;
  const total = subtotalEx + vat;

  const number = data._number && data._number.year && data._number.seq
    ? data._number.year + '-' + String(data._number.seq).padStart(3, '0')
    : null;

  const lineRows = lineItems.map(li => `
    <tr>
      <td style="padding:12px 14px;border-top:1px solid #E5E9EE;font-size:13px;">
        <div style="font-weight:600;color:#0F2A3D;">${esc(li.label)}</div>
        ${li.sub ? `<div style="font-size:12px;color:#6B7785;margin-top:2px;">${esc(li.sub)}</div>` : ''}
      </td>
      <td style="padding:12px 14px;border-top:1px solid #E5E9EE;text-align:right;font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap;">
        ${formatGBP(li.ex)}
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Receipt - ${esc(data.contactBusinessName || data.clientName || 'Squideo')}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, system-ui, sans-serif; color: #0F2A3D; background: white; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
    }
    @media screen {
      body { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
    }
  </style>
</head>
<body>
  <div class="no-print" style="background:#FFF8E1;border:1px solid #FFE082;padding:12px 20px;text-align:center;font-size:13px;color:#8A6D00;margin-bottom:24px;border-radius:6px;">
    Use your browser's <strong>File → Print</strong> (or Ctrl+P / ⌘P) to save as PDF or print.
    <button onclick="window.print()" style="margin-left:16px;padding:6px 14px;background:#2BB8E6;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;">Print / Save as PDF</button>
  </div>

  <!-- Header -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:28px;flex-wrap:wrap;">
    <div>
      <img src="${SQUIDEO_LOGO}" alt="Squideo" style="height:44px;width:auto;display:block;margin-bottom:14px;" />
      <div style="font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">Payment Receipt</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px;">Receipt</div>
    </div>
    <div style="text-align:right;font-size:13px;color:#6B7785;line-height:1.7;">
      <div><strong style="color:#0F2A3D;">Date</strong>: ${esc(paidAtStr)}</div>
      ${number ? `<div><strong style="color:#0F2A3D;">Proposal</strong>: ${esc(number)}</div>` : ''}
      ${payment.stripeSessionId ? `<div><strong style="color:#0F2A3D;">Reference</strong>: <span style="font-family:ui-monospace, SFMono-Regular, Menlo, monospace;font-size:11px;">${esc(payment.stripeSessionId)}</span></div>` : ''}
    </div>
  </div>

  <!-- Paid-by + Project blocks -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;">
    <div style="border:1px solid #E5E9EE;border-radius:10px;padding:16px;">
      <div style="font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:8px;">Paid by</div>
      <div style="font-size:14px;font-weight:600;">${esc(signed.name || '')}</div>
      ${signed.email ? `<div style="font-size:13px;color:#6B7785;margin-top:2px;">${esc(signed.email)}</div>` : ''}
      ${data.contactBusinessName ? `<div style="font-size:13px;color:#6B7785;margin-top:2px;">${esc(data.contactBusinessName)}</div>` : ''}
    </div>
    <div style="border:1px solid #E5E9EE;border-radius:10px;padding:16px;">
      <div style="font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:8px;">For</div>
      <div style="font-size:14px;font-weight:600;">${esc(data.proposalTitle || 'Explainer Video Project')}</div>
      ${data.clientName ? `<div style="font-size:13px;color:#6B7785;margin-top:2px;">Client: ${esc(data.clientName)}</div>` : ''}
    </div>
  </div>

  <!-- Line items -->
  <table style="width:100%;border-collapse:collapse;border:1px solid #E5E9EE;border-radius:10px;overflow:hidden;margin-bottom:18px;">
    <thead>
      <tr style="background:#F8FAFC;">
        <th style="padding:10px 14px;text-align:left;font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:0.6px;font-weight:700;">Description</th>
        <th style="padding:10px 14px;text-align:right;font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:0.6px;font-weight:700;">Amount (ex VAT)</th>
      </tr>
    </thead>
    <tbody>
      ${lineRows}
    </tbody>
  </table>

  <!-- Totals -->
  <div style="display:flex;justify-content:flex-end;margin-bottom:24px;">
    <table style="border-collapse:collapse;font-size:13px;min-width:280px;">
      <tr><td style="padding:6px 14px 6px 0;color:#6B7785;">Subtotal</td><td style="padding:6px 0;text-align:right;font-variant-numeric:tabular-nums;">${formatGBP(subtotalEx)}</td></tr>
      <tr><td style="padding:6px 14px 6px 0;color:#6B7785;">VAT (${(vatRate * 100).toFixed(0)}%)</td><td style="padding:6px 0;text-align:right;font-variant-numeric:tabular-nums;">${formatGBP(vat)}</td></tr>
      <tr><td style="padding:10px 14px 10px 0;border-top:2px solid #0F2A3D;font-weight:700;font-size:15px;">Total paid</td><td style="padding:10px 0;border-top:2px solid #0F2A3D;text-align:right;font-weight:700;font-size:15px;font-variant-numeric:tabular-nums;">${formatGBP(total)}</td></tr>
    </table>
  </div>

  <!-- Paid stamp -->
  <div style="background:#F0FDF4;border:2px solid #16A34A;border-radius:12px;padding:18px 20px;display:flex;align-items:center;gap:14px;margin-bottom:24px;">
    <div style="background:#16A34A;color:white;font-weight:700;letter-spacing:1px;padding:8px 16px;border-radius:999px;font-size:13px;">PAID</div>
    <div style="font-size:14px;color:#166534;line-height:1.5;">
      <div><strong>${formatGBP(payment.amount)}</strong> received on ${esc(paidAtStr)}</div>
      <div style="font-size:12px;margin-top:2px;">Paid by card${payment.customerEmail ? ' · ' + esc(payment.customerEmail) : ''}</div>
    </div>
  </div>

  <!-- Footer -->
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #E5E9EE;font-size:11px;color:#6B7785;text-align:center;line-height:1.6;">
    ${esc(CONFIG.company.name)} · ${esc(CONFIG.company.website)} · ${esc(CONFIG.company.phone)}<br />
    Thank you for your payment. Please retain this receipt for your records.
  </div>
</body>
</html>`;
}

export function openReceiptWindow(data, signed, payment) {
  if (!signed || !payment) return false;
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(buildReceiptHTML(data, signed, payment));
  w.document.close();
  return true;
}
