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

// The Free 6-Min Video Guide welcome.
//
// Two shapes from one template. A brand-new signup is ALREADY signed in by the
// time this lands — the email is a bookmark, not a step, so it must not read
// like an instruction they've failed to follow. A returning user (the address
// already had a portal account) gets a one-shot sign-in link instead, because
// a public form must never hand out a session for an address someone typed.
export function courseCrashCourseHtml({ name, loginUrl = null, returning = false, logoUrl = null }) {
  const url = loginUrl || `${PORTAL_URL}#/course`;
  const inner = returning ? `
    <h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">You already have an account${name ? ', ' + escapeHtml(name) : ''}</h2>
    <p style="margin:0 0 14px;">Good news — that means the video guide is already waiting for you. All eight videos, unlocked.</p>
    <p style="margin:0 0 18px;">${ctaButton(url, 'Sign in and watch')}</p>
    <p style="margin:0 0 6px;font-size:12px;color:#6B7785;">This link works once and expires in 15 minutes.</p>
  ` : `
    <h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">You're in${name ? ', ' + escapeHtml(name) : ''} 🎬</h2>
    <p style="margin:0 0 14px;">All eight videos of the <strong>Free 6-Min Video Guide</strong> are unlocked — about six minutes end to end, so you could be done before your coffee is.</p>
    <p style="margin:0 0 14px;">You're already signed in on the device you signed up on. This email is just so you can find your way back.</p>
    <p style="margin:0 0 18px;">${ctaButton(url, 'Watch the course')}</p>
    <p style="margin:0 0 14px;">While you're in there, have a proper look round — it's the same portal our clients use to review storyboards, leave timestamped feedback on drafts and download finished videos.</p>
    <p style="margin:0;font-size:12px;color:#6B7785;">No password needed. If you ever get signed out, ask for a sign-in link on the portal page.</p>
  `;
  return shell(inner, logoUrl);
}

// Someone came in through the brief builder rather than the video guide. The
// email has one job: get them back to a half-finished brief. That is the whole
// reason the builder exists instead of a downloadable template — an abandoned
// document is invisible, an abandoned brief is a warm lead we can nudge.
export function briefBuilderHtml({ name, loginUrl = null, returning = false, logoUrl = null }) {
  const url = loginUrl || `${PORTAL_URL}#/brief`;
  const inner = returning ? `
    <h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">You already have an account${name ? ', ' + escapeHtml(name) : ''}</h2>
    <p style="margin:0 0 14px;">Which means the brief builder is already there waiting for you — along with anything you'd started before.</p>
    <p style="margin:0 0 18px;">${ctaButton(url, 'Sign in and pick up where you left off')}</p>
    <p style="margin:0 0 6px;font-size:12px;color:#6B7785;">This link works once and expires in 15 minutes.</p>
  ` : `
    <h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">Your brief is ready when you are${name ? ', ' + escapeHtml(name) : ''}</h2>
    <p style="margin:0 0 14px;">Answer what you can — we can work from as little as a list of key points, and it saves as you type, so you can stop halfway and come back.</p>
    <p style="margin:0 0 14px;">You're already signed in on the device you started on. This email is just so you can find your way back.</p>
    <p style="margin:0 0 18px;">${ctaButton(url, 'Open my brief')}</p>
    <p style="margin:0 0 14px;">There's also a short video guide in there if you'd rather think it through first — about six minutes end to end.</p>
    <p style="margin:0;font-size:12px;color:#6B7785;">No password needed. If you ever get signed out, ask for a sign-in link on the portal page.</p>
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

// `heading` and `message` let the sender confirm (and adjust) the wording in the
// CRM before it goes out; both fall back to the standard copy. `message` is
// plain text typed into a textarea — escaped, with blank lines becoming
// paragraphs — so nothing typed there can inject markup into the email.
export function portalTeamInviteHtml({ inviterName, companyName, inviteUrl, logoUrl = null, heading = null, message = null, toName = null, ccNames = [] }) {
  const headingText = (heading || '').trim()
    || `${inviterName || 'A colleague'} invited you to ${companyName || 'your team'}'s Squideo portal`;
  const messageText = (message || '').trim()
    || "Track your team's video projects, review drafts, share files and download finished videos — all in one place.";
  const paragraphs = messageText
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 18px;">${escapeHtml(para.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');
  // When colleagues are copied in, the email has to say whose link this is.
  // An invite is bound to ONE address: a CC who clicks the button would set up
  // an account under the addressee's email, not their own. Rather than leave
  // that as a trap, name it and tell them how to get their own.
  const copied = (ccNames || []).filter(Boolean);
  const ccNote = copied.length ? `
    <p style="margin:0 0 18px;padding:12px 14px;background:#F4F7F9;border-radius:8px;font-size:13px;color:#4B5A66;">
      Also copied: ${escapeHtml(copied.join(', '))}. This link sets up
      ${escapeHtml(toName || 'the addressee')}'s account — if you'd like your own login,
      just reply and we'll send one over.
    </p>` : '';
  const inner = `
    <h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">${escapeHtml(headingText)}</h2>
    ${paragraphs}
    <p style="margin:0 0 18px;">${ctaButton(inviteUrl, 'Join the portal')}</p>
    ${ccNote}
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

// The receipt for a finished brief.
//
// It exists first because somebody who has just spent twenty minutes answering
// twenty-six questions and pressed send should get something back that isn't a
// toast they can't scroll to later. It says what we have and what happens next.
//
// `setupUrl` is the second job, and only for an account that has no password —
// a self-serve signup who came in on a name and an email. Clicking it sets one
// AND proves the address is theirs, which is the thing that actually hardens
// the account. Deliberately not a demand: the paragraph above it already
// promises we'll be in touch, so ignoring this costs them nothing.
export function portalBriefReceivedHtml({ clientName, projectTitle, briefUrl, setupUrl = null, logoUrl = null }) {
  const who = clientName ? `${escapeHtml(clientName)}, thanks` : 'Thanks';
  const inner = `
    <h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">We've got your brief</h2>
    <p style="margin:0 0 14px;">${who} — your brief${projectTitle ? ` for <strong>${escapeHtml(projectTitle)}</strong>` : ''} is with our team.</p>
    <p style="margin:0 0 18px;">We'll read it properly and come back to you shortly. Nothing else is needed
      from you right now; if anything in it needs to change, just reply and we'll reopen it.</p>
    <p style="margin:0 0 18px;">${ctaButton(briefUrl, 'View your brief')}</p>
    ${setupUrl ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;border-top:1px solid #E5E9EE;">
        <tr><td style="padding:18px 0 0;">
          <p style="margin:0 0 6px;font-weight:600;">Getting back in</p>
          <p style="margin:0 0 14px;font-size:13px;color:#6B7785;">
            Right now we email you a link every time you want to sign in. Set a password and you won't
            have to wait for one — it also confirms this address is yours.
          </p>
          <p style="margin:0;">${ctaButton(setupUrl, 'Set a password', '#16A34A')}</p>
        </td></tr>
      </table>` : ''}
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

// Confirmation after a client picks a voiceover artist for a video (or all).
export function portalVoiceoverConfirmHtml({ clientName, projectTitle, artistName, videoLabel, appliedToAll, logoUrl = null }) {
  const scope = appliedToAll ? 'all videos in this project' : escapeHtml(videoLabel || 'your video');
  const inner = `
    <h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">Voiceover locked in 🎙️</h2>
    <p style="margin:0 0 14px;">Thanks${clientName ? ', ' + escapeHtml(clientName) : ''} — you've chosen <strong>${escapeHtml(artistName || 'a voiceover artist')}</strong> for ${scope}${projectTitle ? ` on <strong>${escapeHtml(projectTitle)}</strong>` : ''}.</p>
    <p style="margin:0 0 18px;">Our team will use them for the recording. If you need to change this, just reply and we'll sort it.</p>
    <p style="margin:0;">${ctaButton(PORTAL_URL, 'Open my portal')}</p>
  `;
  return shell(inner, logoUrl);
}

// The production manager's "your project has started — a couple of things to
// choose" email. The wording is admin-editable (settings.project_tasks_email);
// bodyHtml is that stored body, and we append the live portal sign-up/login
// button. bodyHtml is trusted admin content (not client input) so it isn't
// escaped — it's rendered as authored.
export function portalProjectTasksHtml({ bodyHtml, inviteUrl, logoUrl = null }) {
  const inner = `
    ${bodyHtml || '<p style="margin:0 0 14px;">Your project is underway! Head to your portal to choose a voiceover artist for each video and book your kick-off call.</p>'}
    <p style="margin:18px 0 6px;">${ctaButton(inviteUrl, 'Sign in / set up your portal')}</p>
    <p style="margin:0;font-size:12px;color:#6B7785;word-break:break-all;">Or paste this into your browser: ${escapeHtml(inviteUrl)}</p>
  `;
  return shell(inner, logoUrl);
}

// Automatic reminder that a client still has outstanding project tasks. The
// intro copy (bodyHtml) is admin-editable (settings.task_reminders.bodyHtml) and
// trusted, so it isn't escaped; the task list is rendered from the live derived
// tasks (title/detail are our own strings, escaped defensively).
export function portalTaskReminderHtml({ bodyHtml, projectTitle, tasks = [], portalUrl = PORTAL_URL, logoUrl = null }) {
  const items = tasks.map((t) => `
    <li style="margin:0 0 10px;">
      <strong>${escapeHtml(t.title || '')}</strong>${t.detail ? `<br/><span style="color:#6B7785;">${escapeHtml(t.detail)}</span>` : ''}
    </li>`).join('');
  const inner = `
    ${bodyHtml || `<h2 style="margin:0 0 12px;font-size:19px;font-weight:700;">A few things still need you 👋</h2>
    <p style="margin:0 0 14px;">Your project${projectTitle ? ` <strong>${escapeHtml(projectTitle)}</strong>` : ''} is ready to move forward — there ${tasks.length === 1 ? 'is 1 thing' : `are ${tasks.length} things`} waiting on you:</p>`}
    <ul style="margin:0 0 18px;padding:0 0 0 20px;line-height:1.5;">${items}</ul>
    <p style="margin:0 0 18px;">${ctaButton(portalUrl, 'Complete my tasks')}</p>
    <p style="margin:0;font-size:12px;color:#6B7785;">Already sorted? You can ignore this — it'll stop once everything's done.</p>
  `;
  return shell(inner, logoUrl);
}

// The "what changed on your brief" digest (api/_lib/brief/digest.js). The body
// is assembled there so the wording can be unit-tested without a mail client;
// this only puts the Squideo shell around it. `inner` is our own markup, with
// everything a client typed already escaped by the digest builder.
export function briefDigestHtml({ inner, logoUrl = null }) {
  return shell(inner, logoUrl);
}
