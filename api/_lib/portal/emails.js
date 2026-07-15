// Client-facing portal emails. These go to CUSTOMERS (not staff), so the
// shell is branded "Squideo" — not "Squideo CRM" like api/_lib/email.js — and
// the copy never references internal tooling. All sends go through sendMail.

import { APP_URL } from '../email.js';

export const PORTAL_URL = `${APP_URL.replace(/\/$/, '')}/portal`;

const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

// logoUrl is the CLIENT's logo (api/_lib/portal/logo.js) — an absolute URL, not
// a data: URI, because email clients won't render those. It's co-branding: our
// wordmark stays on the left, theirs sits opposite.
function shell(innerHtml, logoUrl = null) {
  const wordmark = '<div style="font-size:18px;font-weight:800;color:#0F2A3D;">Squideo <span style="color:#2BB8E6;">Client Portal</span></div>';
  const header = logoUrl
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td align="left">${wordmark}</td>
            <td align="right"><img src="${escapeHtml(logoUrl)}" alt="" height="30" style="display:block;height:30px;max-width:150px;border:0;" /></td>
          </tr></table>`
    : wordmark;
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0F2A3D;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFBFC;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E9EE;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:24px 28px;border-bottom:1px solid #E5E9EE;">
          ${header}
        </td></tr>
        <tr><td style="padding:24px 28px;font-size:14px;line-height:1.55;color:#0F2A3D;">
          ${innerHtml}
        </td></tr>
        <tr><td style="padding:16px 28px;background:#FAFBFC;border-top:1px solid #E5E9EE;font-size:12px;color:#6B7785;">
          Squideo · 01482 738 656 · squideo.com — questions? Just reply to this email.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function ctaButton(href, label, color = '#2BB8E6') {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">${escapeHtml(label)}</a>`;
}

// The post-signing welcome: their portal account is ready, details prefilled.
export function portalWelcomeHtml({ clientName, projectTitle, inviteUrl, logoUrl = null }) {
  const inner = `
    <h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">Welcome aboard${clientName ? ', ' + escapeHtml(clientName) : ''} 🎬</h2>
    <p style="margin:0 0 14px;">Your Squideo Client Portal is ready${projectTitle ? ` for <strong>${escapeHtml(projectTitle)}</strong>` : ''}. From one place you can:</p>
    <ul style="margin:0 0 16px;padding:0 0 0 20px;line-height:1.7;">
      <li>See exactly where your video is up to — and whether anything's waiting on you</li>
      <li>Watch drafts and send revision feedback</li>
      <li>Share brand guidelines and documents with our team</li>
      <li>Download your finished videos, any time</li>
      <li>Invite your teammates so everyone stays in the loop</li>
    </ul>
    <p style="margin:0 0 18px;">We've prefilled your details — just set a password to get started.</p>
    <p style="margin:0 0 18px;">${ctaButton(inviteUrl, 'Set up my portal account')}</p>
    <p style="margin:0 0 6px;font-size:12px;color:#6B7785;">This link expires in 14 days. If the button doesn't work, paste this into your browser:</p>
    <p style="margin:0;font-size:12px;color:#6B7785;word-break:break-all;">${escapeHtml(inviteUrl)}</p>
  `;
  return shell(inner, logoUrl);
}

// An existing portal user just had another project/org added to their account.
export function portalProjectAddedHtml({ clientName, projectTitle, companyName, logoUrl = null }) {
  const inner = `
    <h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">A new project is in your portal${clientName ? ', ' + escapeHtml(clientName) : ''}</h2>
    <p style="margin:0 0 18px;"><strong>${escapeHtml(projectTitle || 'Your new project')}</strong>${companyName ? ` for <strong>${escapeHtml(companyName)}</strong>` : ''} is now live in your Squideo Client Portal — track progress, send feedback and share files there.</p>
    <p style="margin:0;">${ctaButton(PORTAL_URL, 'Open my portal')}</p>
  `;
  return shell(inner, logoUrl);
}

export function portalTeamInviteHtml({ inviterName, companyName, inviteUrl, logoUrl = null }) {
  const inner = `
    <h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">${escapeHtml(inviterName || 'A colleague')} invited you to ${escapeHtml(companyName || 'your team')}'s Squideo portal</h2>
    <p style="margin:0 0 18px;">Track your team's video projects, review drafts, share files and download finished videos — all in one place.</p>
    <p style="margin:0 0 18px;">${ctaButton(inviteUrl, 'Join the portal')}</p>
    <p style="margin:0 0 6px;font-size:12px;color:#6B7785;">This invite expires in 14 days. If the button doesn't work, paste this into your browser:</p>
    <p style="margin:0;font-size:12px;color:#6B7785;word-break:break-all;">${escapeHtml(inviteUrl)}</p>
  `;
  return shell(inner, logoUrl);
}

export function portalMagicLinkHtml({ loginUrl, logoUrl = null }) {
  const inner = `
    <h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">Your sign-in link</h2>
    <p style="margin:0 0 18px;">Click below to sign in to your Squideo Client Portal. The link works once and expires in 15 minutes.</p>
    <p style="margin:0 0 18px;">${ctaButton(loginUrl, 'Sign in to my portal')}</p>
    <p style="margin:0;font-size:12px;color:#6B7785;">Didn't request this? You can safely ignore it — nobody can sign in without this email.</p>
  `;
  return shell(inner, logoUrl);
}

export function portalResetHtml({ resetUrl, logoUrl = null }) {
  const inner = `
    <h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">Reset your portal password</h2>
    <p style="margin:0 0 18px;">Click below to choose a new password. The link works once and expires in 60 minutes.</p>
    <p style="margin:0 0 18px;">${ctaButton(resetUrl, 'Choose a new password')}</p>
    <p style="margin:0;font-size:12px;color:#6B7785;">Didn't request this? You can safely ignore it — your password hasn't changed.</p>
  `;
  return shell(inner, logoUrl);
}

const formatGBP = (n) =>
  '£' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// Confirmation after a client adds an extra from the portal.
export function portalExtraConfirmHtml({ clientName, projectTitle, title, amount, originalAmount, logoUrl = null }) {
  const saved = originalAmount != null && Number(originalAmount) > Number(amount);
  const inner = `
    <h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">Added to your project ✅</h2>
    <p style="margin:0 0 14px;">Thanks${clientName ? ', ' + escapeHtml(clientName) : ''} — we've added <strong>${escapeHtml(title)}</strong> to <strong>${escapeHtml(projectTitle || 'your project')}</strong>.</p>
    <div style="background:#F1F4F7;border:1px solid #E5E9EE;border-radius:8px;padding:14px 16px;margin:0 0 16px;font-size:14px;">
      ${escapeHtml(title)} — <strong>${formatGBP(amount)}</strong> ex VAT
      ${saved ? ` <span style="color:#16A34A;font-weight:600;">(portal price — was ${formatGBP(originalAmount)})</span>` : ''}
    </div>
    <p style="margin:0 0 18px;">It'll appear on your final invoice — nothing to pay right now. Our team has been notified and will fold it into production.</p>
    <p style="margin:0;">${ctaButton(PORTAL_URL, 'Open my portal')}</p>
  `;
  return shell(inner, logoUrl);
}
