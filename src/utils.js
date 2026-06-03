import { useState, useEffect } from 'react';

export const makeId = () => 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

export function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth <= 640);
  useEffect(() => {
    const fn = () => setMobile(window.innerWidth <= 640);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return mobile;
}

export const formatGBP = (n) => '£' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// £ value of the simple manual discount on a base price; 0 when none.
// Percentage clamps to 0–100; fixed amount clamps to the base price so the
// project line can never go negative. Legacy proposals (no discount) → 0.
export function computeBaseDiscount(basePrice, discount) {
  const v = Number(discount?.value) || 0;
  if (v <= 0) return 0;
  const base = Number(basePrice) || 0;
  if (discount.type === 'amount') return Math.min(v, base);
  return base * Math.min(v, 100) / 100;
}

// Ex-VAT value of a proposal that best reflects the actual deal value.
// Mirrors computeProposalTotalExVat in api/_lib/crm/deals.js so the dashboard
// and CRM agree. Signed: prefer signature.amountBreakdown.projectExVat
// (excludes the recurring partner-programme subscription), falling back to
// signature.total/(1+vatRate) for the simple non-partner case. Unsigned:
// fall back to basePrice.
export function proposalSignedTotalExVat(proposal, signed) {
  if (signed?.amountBreakdown?.projectExVat != null) {
    const v = Number(signed.amountBreakdown.projectExVat);
    if (Number.isFinite(v)) return v;
  }
  if (signed?.total != null) {
    const t = Number(signed.total);
    if (Number.isFinite(t)) {
      const vatRate = Number(proposal?.vatRate) || 0;
      return t / (1 + vatRate);
    }
  }
  return proposal?.basePrice ?? null;
}

const CURRENCY_SYMBOLS = { GBP: '£', EUR: '€', USD: '$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', JPY: '¥' };

export const formatCurrency = (n, code = 'GBP') => {
  const symbol = CURRENCY_SYMBOLS[code] || (code ? code + ' ' : '£');
  return symbol + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

// "€10,000.00 (£8,600.00)" when both supplied and they differ; otherwise just
// the primary amount. Used for invoice amounts that may be in any currency.
export const formatAmountWithGbp = (amount, currency = 'GBP', gbpAmount = null) => {
  const primary = formatCurrency(amount, currency);
  if (!gbpAmount || (currency || 'GBP') === 'GBP') return primary;
  return primary + ' (' + formatCurrency(gbpAmount, 'GBP') + ')';
};

export const formatProposalNumber = (n) =>
  n && n.year && n.seq ? n.year + '-' + String(n.seq).padStart(3, '0') : '';

export const formatRelativeTime = (iso) => {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const s = Math.round(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  if (d < 30) return d + 'd ago';
  return new Date(iso).toLocaleDateString('en-GB');
};

// Gmail-style timestamp for mail lists: today → time (09:25); this year →
// day + month (21 May); earlier years → DD/MM/YYYY (18/10/2023).
export const formatMailDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

export const formatDuration = (s) => {
  s = Math.max(0, Math.round(Number(s) || 0));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? m + 'm ' + r + 's' : m + 'm';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? h + 'h ' + mm + 'm' : h + 'h';
};

export function resizeImage(file, maxW, maxH, keepPng) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const isPng = keepPng && file.type === 'image/png';
        resolve(canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.88));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// The address shown/edited for a company: its own stored address, falling back
// field-by-field to the linked Xero contact's address (two-way prefill).
export function effectiveAddress(company) {
  const a = company?.address || {};
  const x = company?.xeroAddress || {};
  return {
    line1: a.line1 || x.line1 || '',
    line2: a.line2 || x.line2 || '',
    city: a.city || x.city || '',
    postcode: a.postcode || x.postcode || '',
    country: a.country || x.country || '',
  };
}

// Prefill an address form from a company. Country defaults to United Kingdom
// only when an address actually exists, so opening the form on an address-less
// company doesn't silently write a country-only address on save.
export function deriveAddress(company) {
  const a = effectiveAddress(company);
  const hasAny = a.line1 || a.line2 || a.city || a.postcode || a.country;
  return { ...a, country: a.country || (hasAny ? 'United Kingdom' : '') };
}

export function formatAddressLines(addr) {
  return [
    addr.line1,
    addr.line2,
    [addr.city, addr.postcode].filter(Boolean).join(' '),
    addr.country,
  ].filter(Boolean);
}

export async function sendNotification(trigger, proposal, signature, payment, recipients) {
  if (!recipients || recipients.length === 0) return 0;
  const subject = trigger === 'signed'
    ? 'Proposal signed: ' + (proposal.contactBusinessName || proposal.clientName || 'Untitled')
    : 'Payment received: ' + (proposal.contactBusinessName || proposal.clientName);
  const body = trigger === 'signed'
    ? signature.name + ' just accepted the proposal for ' + formatGBP(signature.total)
    : 'Payment of ' + formatGBP(payment.amount) + ' received from ' + signature.name;
  console.log('[EMAIL STUB]', { to: recipients, subject, body });
  return recipients.length;
}
