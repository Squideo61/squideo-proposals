import { Resend } from 'resend';
import sql from './db.js';

const FROM = process.env.MAIL_FROM || 'Squideo CRM <noreply@squideo.co.uk>';
export const APP_URL = process.env.APP_URL || 'https://app.squideo.com';

// Admin recipients for payment-received notifications, minus the proposal
// owner (who gets their own copy of the same email).
export async function adminEmailsExcluding(excludeEmail) {
  const rows = await sql`SELECT email FROM users WHERE role = 'admin'`;
  const drop = (excludeEmail || '').toLowerCase();
  return rows
    .map(r => r.email)
    .filter(Boolean)
    .filter(e => e.toLowerCase() !== drop);
}

let client = null;
function getClient() {
  if (client) return client;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  client = new Resend(key);
  return client;
}

// Sends a transactional email. Failures are caught and logged so the calling
// API route doesn't 500 on a transient SMTP issue. Callers that need to know
// whether the send succeeded (e.g. the 2FA code flow) should pass
// `{ throwOnError: true }` and handle the rejection.
export async function sendMail({ to, subject, html, text, throwOnError = false }) {
  const c = getClient();
  const recipients = (Array.isArray(to) ? to : [to])
    .map(r => (typeof r === 'string' ? r.trim() : r))
    .filter(Boolean);
  if (!recipients.length) return;
  if (!c) {
    console.warn('[email] RESEND_API_KEY missing — skipping send', { subject, to: recipients });
    if (throwOnError) throw new Error('Email transport not configured');
    return;
  }
  try {
    await c.emails.send({ from: FROM, to: recipients, subject, html, text });
  } catch (err) {
    console.error('[email] send failed', { subject, to: recipients, err: err.message });
    if (throwOnError) throw err;
  }
}

const formatGBP = (n) =>
  '£' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

function shell(innerHtml) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0F2A3D;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFBFC;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E9EE;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:24px 28px;border-bottom:1px solid #E5E9EE;">
          <div style="font-size:18px;font-weight:700;color:#0F2A3D;">Squideo CRM</div>
        </td></tr>
        <tr><td style="padding:24px 28px;font-size:14px;line-height:1.55;color:#0F2A3D;">
          ${innerHtml}
        </td></tr>
        <tr><td style="padding:16px 28px;background:#FAFBFC;border-top:1px solid #E5E9EE;font-size:12px;color:#6B7785;">
          You're receiving this because you're part of the Squideo workspace.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Mirrors the NEXT_STEPS constant in src/defaults.js. Update both together.
const CLIENT_NEXT_STEPS = [
  'Accept this quote to guarantee a production slot in our creative schedule.',
  "We'll invoice your initial payment or arrange supplier setup with you for Purchase Orders.",
  'Your Production Manager will reach out to arrange an introduction meeting with our Delivery Team.',
];

function nextStepsList() {
  return `<ol style="margin:0 0 20px;padding:0 0 0 20px;color:#0F2A3D;">
    ${CLIENT_NEXT_STEPS.map(s => `<li style="margin:0 0 8px;font-size:14px;line-height:1.55;">${escapeHtml(s)}</li>`).join('')}
  </ol>`;
}

function ctaButton(href, label, color = '#2BB8E6') {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;margin:0 8px 8px 0;">${escapeHtml(label)}</a>`;
}

export function clientSignedThanksHtml({ proposal, clientName, signedProposalLink, payNowLink }) {
  const title = proposal.proposalTitle || proposal.clientName || 'your proposal';
  const inner = `
    <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">Thanks${clientName ? ', ' + escapeHtml(clientName) : ''} - we've got your signed proposal</h2>
    <p style="margin:0 0 16px;">We've received your acceptance for <strong>${escapeHtml(title)}</strong>. A copy is below for your records, along with the next steps.</p>
    <p style="margin:0 0 18px;">
      ${ctaButton(signedProposalLink, 'Download signed proposal', '#16A34A')}
      ${payNowLink ? ctaButton(payNowLink, 'Pay now by card', '#2BB8E6') : ''}
    </p>
    ${payNowLink ? `<p style="margin:0 0 18px;font-size:13px;color:#6B7785;">Paying by card now starts production immediately.</p>` : ''}
    <h3 style="margin:18px 0 10px;font-size:15px;font-weight:700;">What happens next</h3>
    ${nextStepsList()}
    <p style="margin:0;font-size:13px;color:#6B7785;">Any questions? Just reply to this email.</p>
  `;
  return shell(inner);
}

export function clientPaidThanksHtml({ proposal, clientName, signedProposalLink, receiptUrl }) {
  const title = proposal.proposalTitle || proposal.clientName || 'your proposal';
  const inner = `
    <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">Payment received - thanks${clientName ? ', ' + escapeHtml(clientName) : ''}!</h2>
    <p style="margin:0 0 16px;">We've received your payment for <strong>${escapeHtml(title)}</strong>. Production will be scheduled shortly.</p>
    <p style="margin:0 0 18px;">
      ${ctaButton(signedProposalLink, 'Download signed proposal', '#16A34A')}
      ${receiptUrl ? ctaButton(receiptUrl, 'Download receipt', '#2BB8E6') : ''}
    </p>
    <h3 style="margin:18px 0 10px;font-size:15px;font-weight:700;">What happens next</h3>
    ${nextStepsList()}
    <p style="margin:0;font-size:13px;color:#6B7785;">Any questions? Just reply to this email.</p>
  `;
  return shell(inner);
}

export function twoFactorCodeHtml({ code, minutes = 10, purpose = 'login' }) {
  const headline = purpose === 'enrol'
    ? 'Confirm your email for two-step verification'
    : 'Your sign-in verification code';
  const intro = purpose === 'enrol'
    ? 'Use the code below to confirm this email address while setting up two-step verification.'
    : 'Use the code below to finish signing in to Squideo CRM.';
  const inner = `
    <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">${headline}</h2>
    <p style="margin:0 0 16px;">${intro}</p>
    <div style="font-family:'Courier New',monospace;font-size:28px;font-weight:700;letter-spacing:6px;background:#F1F4F7;border:1px solid #E5E9EE;border-radius:8px;padding:16px 20px;text-align:center;margin:0 0 16px;">${escapeHtml(code)}</div>
    <p style="margin:0 0 8px;font-size:13px;color:#6B7785;">This code expires in ${minutes} minutes.</p>
    <p style="margin:0;font-size:13px;color:#6B7785;">If you didn't try to sign in, ignore this email and consider changing your password.</p>
  `;
  return shell(inner);
}

export function inviteHtml({ inviterName, link, expiresInDays = 7 }) {
  const inner = `
    <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">You've been invited to Squideo CRM</h2>
    <p style="margin:0 0 12px;">${escapeHtml(inviterName || 'A teammate')} has invited you to join the Squideo CRM workspace.</p>
    <p style="margin:0 0 20px;">Click the button below to set up your account. This invite expires in ${expiresInDays} days.</p>
    <p style="margin:0 0 20px;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Accept invite</a></p>
    <p style="margin:0;color:#6B7785;font-size:12px;">If the button doesn't work, paste this link into your browser:<br/><span style="word-break:break-all;">${escapeHtml(link)}</span></p>
  `;
  return shell(inner);
}

export function inviteAcceptedHtml({ name, email, roleName, invitedByEmail, link }) {
  const who = name ? `${escapeHtml(name)}${email ? ` (${escapeHtml(email)})` : ''}` : escapeHtml(email || 'A new teammate');
  const inner = `
    <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">👋 New teammate joined</h2>
    <p style="margin:0 0 16px;"><strong>${who}</strong> has accepted ${invitedByEmail ? `${escapeHtml(invitedByEmail)}'s ` : 'their '}invite and set up their account${roleName ? ` as <strong>${escapeHtml(roleName)}</strong>` : ''}.</p>
    ${link ? `<p style="margin:0;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Manage users</a></p>` : ''}
  `;
  return shell(inner);
}

// Client has finished a video/storyboard review and sent their comments to the
// team. `kind` is 'video' or 'storyboard'; `itemTitle` is the specific
// video/storyboard within the project.
export function revisionFeedbackHtml({ kind = 'video', projectTitle, itemTitle, clientName, commentCount, link }) {
  const label = kind === 'storyboard' ? 'storyboard' : 'video';
  const count = Number(commentCount) || 0;
  const countText = count === 1 ? '1 comment' : `${count} comments`;
  const inner = `
    <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">${escapeHtml(clientName || 'A client')} sent ${label} feedback</h2>
    <p style="margin:0 0 12px;">They've finished reviewing <strong>${escapeHtml(itemTitle || projectTitle || 'the ' + label)}</strong>${projectTitle && itemTitle && projectTitle !== itemTitle ? ` in <strong>${escapeHtml(projectTitle)}</strong>` : ''} and left <strong>${escapeHtml(countText)}</strong>.</p>
    <p style="margin:0;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Review feedback</a></p>
  `;
  return shell(inner);
}

// How the client chose to pay, as stored on the signature (ClientView).
const PAYMENT_OPTION_LABELS = {
  '5050': '50/50 split — 50% deposit, balance on approval',
  'full': 'Pay in full (card / BACS)',
  'po': 'Purchase Order',
};

// A quick-reference order breakdown built from what the client actually
// selected on the signature: the chosen video option (or project base) plus any
// optional extras. Prices are the ex-VAT list prices stored on the proposal.
function orderBreakdownHtml({ proposal, signature }) {
  const showVat = (Number(proposal.vatRate) || 0) > 0;
  const rows = [];

  const vo = signature?.selectedVideoOption;
  const baseLabel = vo?.label || 'Project base price';
  const basePrice = Number.isFinite(Number(vo?.price)) ? Number(vo.price)
    : (Number.isFinite(Number(proposal.basePrice)) ? Number(proposal.basePrice) : null);
  if (basePrice != null) rows.push([baseLabel, basePrice]);

  const extras = Array.isArray(signature?.selectedExtras) ? signature.selectedExtras : [];
  for (const e of extras) {
    const qty = e?.variantsEnabled ? Math.max(1, Number(e.quantity) || 1) : 1;
    const price = Number.isFinite(Number(e?.price)) ? Number(e.price) * qty : null;
    const label = (e?.label || 'Extra') + (qty > 1 ? ` ×${qty}` : '');
    rows.push([label, price]);
  }

  if (!rows.length) return '';

  const rowHtml = rows.map(([label, price]) => `
    <tr>
      <td style="padding:5px 12px 5px 0;font-size:13px;color:#0F2A3D;">${escapeHtml(label)}</td>
      <td style="padding:5px 0;font-size:13px;text-align:right;white-space:nowrap;color:#0F2A3D;">${price != null ? formatGBP(price) : '—'}</td>
    </tr>`).join('');

  const partnerNote = signature?.partnerSelected
    ? `<tr><td colspan="2" style="padding:6px 0 0;font-size:12px;color:#6B7785;">+ Partner Programme${signature.partnerCredits ? ` — ${signature.partnerCredits} credit${Number(signature.partnerCredits) === 1 ? '' : 's'}/month` : ''}</td></tr>`
    : '';

  const noteBits = [];
  if (showVat) noteBits.push('exclude VAT');
  if (signature?.partnerSelected) noteBits.push('shown before Partner Programme discount');
  const note = noteBits.length
    ? `<div style="font-size:11px;color:#9AA5B1;margin:8px 0 0;">Prices ${noteBits.join('; ')}.</div>`
    : '';

  return `
    <div style="border:1px solid #E5E9EE;border-radius:8px;padding:12px 14px;margin:0 0 20px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#6B7785;margin:0 0 8px;">Order breakdown</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
        ${rowHtml}
        ${partnerNote}
      </table>
      ${note}
    </div>`;
}

export function signedHtml({ proposal, signature, signerName, signerEmail, signedAt, link }) {
  const title = proposal.proposalTitle || proposal.clientName || 'Proposal';
  const vatRate = proposal.vatRate || 0;
  // Prefer the signed total (reflects discounts, partner selections, extras) over the proposal's base price.
  const totalIncVat = Number.isFinite(signature?.total)
    ? signature.total
    : (proposal.basePrice ? proposal.basePrice * (1 + vatRate) : null);
  const totalExVat = totalIncVat != null ? totalIncVat / (1 + vatRate) : null;
  const dateStr = signedAt ? new Date(signedAt).toLocaleString('en-GB') : '';
  const paymentLabel = signature?.paymentOption
    ? (PAYMENT_OPTION_LABELS[signature.paymentOption] || signature.paymentOption)
    : '';
  const inner = `
    <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">🎉 Proposal signed</h2>
    <p style="margin:0 0 16px;"><strong>${escapeHtml(signerName || 'Someone')}</strong>${signerEmail ? ` (${escapeHtml(signerEmail)})` : ''} just signed <strong>${escapeHtml(title)}</strong>${proposal.clientName && proposal.clientName !== title ? ` for ${escapeHtml(proposal.clientName)}` : ''}.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px;">
      ${proposal.contactBusinessName ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7785;font-size:13px;">Business</td><td style="padding:4px 0;font-size:13px;">${escapeHtml(proposal.contactBusinessName)}</td></tr>` : ''}
      ${totalExVat != null ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7785;font-size:13px;">Sale value</td><td style="padding:4px 0;font-size:13px;font-weight:600;">${formatGBP(totalExVat)}${vatRate ? ' + VAT' : ''}</td></tr>` : ''}
      ${totalIncVat != null && vatRate ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7785;font-size:13px;">Total inc VAT</td><td style="padding:4px 0;font-size:13px;">${formatGBP(totalIncVat)}</td></tr>` : ''}
      ${paymentLabel ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7785;font-size:13px;">Payment choice</td><td style="padding:4px 0;font-size:13px;font-weight:600;">${escapeHtml(paymentLabel)}</td></tr>` : ''}
      ${dateStr ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7785;font-size:13px;">Signed at</td><td style="padding:4px 0;font-size:13px;">${escapeHtml(dateStr)}</td></tr>` : ''}
      ${proposal.preparedBy ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7785;font-size:13px;">Prepared by</td><td style="padding:4px 0;font-size:13px;">${escapeHtml(proposal.preparedBy)}</td></tr>` : ''}
    </table>
    ${orderBreakdownHtml({ proposal, signature })}
    ${link ? `<p style="margin:0;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Open proposal</a></p>` : ''}
  `;
  return shell(inner);
}

export function paidHtml({ proposal, signerName, signerEmail, amount, paymentType, paidAt, receiptUrl, link }) {
  const title = proposal.proposalTitle || proposal.clientName || 'Proposal';
  const dateStr = paidAt ? new Date(paidAt).toLocaleString('en-GB') : '';
  const amountLabel = paymentType === 'deposit' ? '50% deposit' : 'full payment';
  const inner = `
    <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">💰 Payment received</h2>
    <p style="margin:0 0 16px;">${escapeHtml(signerName || 'A client')}${signerEmail ? ` (${escapeHtml(signerEmail)})` : ''} just paid <strong>${formatGBP(amount)}</strong> (${escapeHtml(amountLabel)}) for <strong>${escapeHtml(title)}</strong>${proposal.clientName && proposal.clientName !== title ? ` - ${escapeHtml(proposal.clientName)}` : ''}.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 22px;">
      ${proposal.contactBusinessName ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7785;font-size:13px;">Business</td><td style="padding:4px 0;font-size:13px;">${escapeHtml(proposal.contactBusinessName)}</td></tr>` : ''}
      <tr><td style="padding:4px 12px 4px 0;color:#6B7785;font-size:13px;">Amount</td><td style="padding:4px 0;font-size:13px;font-weight:600;">${formatGBP(amount)}</td></tr>
      ${dateStr ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7785;font-size:13px;">Paid at</td><td style="padding:4px 0;font-size:13px;">${escapeHtml(dateStr)}</td></tr>` : ''}
    </table>
    ${receiptUrl ? `<p style="margin:0 0 12px;"><a href="${escapeHtml(receiptUrl)}" style="display:inline-block;background:#16A34A;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">View receipt</a></p>` : ''}
    ${link ? `<p style="margin:0;font-size:13px;"><a href="${escapeHtml(link)}" style="color:#2BB8E6;text-decoration:none;">Open the proposal</a></p>` : ''}
  `;
  return shell(inner);
}

export function invoicePaidHtml({ title, amount, paymentMethod, paidAt, invoiceNumber, link }) {
  const dateStr = paidAt ? new Date(paidAt).toLocaleString('en-GB') : '';
  const methodLabel = (paymentMethod || 'manual').toUpperCase();
  const inner = `
    <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">💰 Invoice marked paid</h2>
    <p style="margin:0 0 16px;">Invoice${invoiceNumber ? ` <strong>${escapeHtml(invoiceNumber)}</strong>` : ''} for <strong>${escapeHtml(title || 'a deal')}</strong> has been marked paid.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px;">
      ${amount != null ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7785;font-size:13px;">Amount</td><td style="padding:4px 0;font-size:13px;font-weight:600;">${formatGBP(amount)}</td></tr>` : ''}
      <tr><td style="padding:4px 12px 4px 0;color:#6B7785;font-size:13px;">Method</td><td style="padding:4px 0;font-size:13px;">${escapeHtml(methodLabel)}</td></tr>
      ${dateStr ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7785;font-size:13px;">Paid at</td><td style="padding:4px 0;font-size:13px;">${escapeHtml(dateStr)}</td></tr>` : ''}
    </table>
    ${link ? `<p style="margin:0;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Open deal</a></p>` : ''}
  `;
  return shell(inner);
}
