// The crash-course nudge sequence: schedule, copy, and the gates that decide
// at SEND time whether each one still makes sense.
//
// Every gate is re-evaluated when the cron runs, never when the row is written.
// Someone who finishes the course on day one must not get "you stopped after
// video 2" on day three, and someone who has already asked for a quote must not
// be sold to. Scheduling is cheap; sending the wrong thing is expensive.

import sql from '../db.js';
import { makeId } from '../crm/shared.js';
import { APP_URL } from '../email.js';
import { unsubscribeUrlFor } from '../emailSuppression.js';

const PORTAL_COURSE_URL = `${APP_URL.replace(/\/$/, '')}/portal#/course`;

// kind, offset in days, and whether the marketing tick is required.
//
// The first four teach — they help someone finish the thing they asked for, so
// they run on legitimate interest. The last two sell, so they need consent.
export const SEQUENCE = [
  { kind: 'nudge_1', days: 2,  needsConsent: false },
  { kind: 'nudge_2', days: 5,  needsConsent: false },
  { kind: 'nudge_3', days: 9,  needsConsent: false },
  { kind: 'offer_1', days: 14, needsConsent: true },
  { kind: 'offer_2', days: 25, needsConsent: true },
];

let ensured = null;
export function ensureCourseEmails() {
  if (ensured) return ensured;
  ensured = (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS course_emails (
          id               TEXT        PRIMARY KEY,
          course_signup_id TEXT        NOT NULL REFERENCES course_signups(id) ON DELETE CASCADE,
          email            TEXT        NOT NULL,
          kind             TEXT        NOT NULL,
          scheduled_for    TIMESTAMPTZ NOT NULL,
          sent_at          TIMESTAMPTZ,
          cancelled_at     TIMESTAMPTZ,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE INDEX IF NOT EXISTS course_emails_due_idx ON course_emails (scheduled_for)
                  WHERE sent_at IS NULL AND cancelled_at IS NULL`;
      await sql`CREATE INDEX IF NOT EXISTS course_emails_signup_idx ON course_emails (course_signup_id)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS course_emails_step_idx
                  ON course_emails (course_signup_id, kind)`;
    } catch (err) {
      console.warn('[courseEmails] ensure failed', err.message);
    }
  })();
  return ensured;
}

// Write the whole series at signup. ON CONFLICT DO NOTHING means a repeat
// signup can't queue a second set.
export async function scheduleCourseEmails(signupId, email) {
  if (!signupId || !email) return;
  await ensureCourseEmails();
  try {
    for (const step of SEQUENCE) {
      await sql`
        INSERT INTO course_emails (id, course_signup_id, email, kind, scheduled_for)
        VALUES (${makeId('cem')}, ${signupId}, ${email}, ${step.kind},
                NOW() + (${step.days} * INTERVAL '1 day'))
        ON CONFLICT (course_signup_id, kind) DO NOTHING
      `;
    }
  } catch (err) {
    console.warn('[courseEmails] schedule failed', err.message);
  }
}

// Stop the rest of the series. Called when someone finishes the course or makes
// contact — at that point every remaining nudge is either redundant or rude.
export async function cancelCourseEmails(signupId, kinds = null) {
  if (!signupId) return;
  try {
    if (kinds) {
      await sql`UPDATE course_emails SET cancelled_at = NOW()
                 WHERE course_signup_id = ${signupId} AND sent_at IS NULL
                   AND cancelled_at IS NULL AND kind = ANY(${kinds})`;
    } else {
      await sql`UPDATE course_emails SET cancelled_at = NOW()
                 WHERE course_signup_id = ${signupId} AND sent_at IS NULL AND cancelled_at IS NULL`;
    }
  } catch (err) {
    console.warn('[courseEmails] cancel failed', err.message);
  }
}

// ── Copy ─────────────────────────────────────────────────────────────────────
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const firstName = (name) => (name ? String(name).trim().split(/\s+/)[0] : '');

function shell(inner, unsubscribeUrl) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0F2A3D;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFBFC;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E9EE;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:24px 28px;border-bottom:1px solid #E5E9EE;">
          <div style="font-size:18px;font-weight:800;color:#0F2A3D;">Squideo <span style="color:#2BB8E6;">Crash Course</span></div>
        </td></tr>
        <tr><td style="padding:24px 28px;font-size:14px;line-height:1.6;color:#0F2A3D;">${inner}</td></tr>
        <tr><td style="padding:16px 28px;background:#FAFBFC;border-top:1px solid #E5E9EE;font-size:12px;color:#6B7785;line-height:1.6;">
          Squideo Ltd · 01482 738 656 · squideo.com<br />
          <a href="${esc(unsubscribeUrl)}" style="color:#6B7785;">Unsubscribe</a> — one click, no questions.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const cta = (href, label) =>
  `<a href="${esc(href)}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">${esc(label)}</a>`;

// `ctx` carries what the gates already looked up, so the copy can be specific
// without a second round of queries: { name, videosDone, totalVideos, nextTitle }
const TEMPLATES = {
  nudge_1: (ctx) => ({
    subject: ctx.videosDone > 0
      ? `You stopped after video ${ctx.videosDone}`
      : 'Your crash course is still waiting',
    inner: `
      <p style="margin:0 0 14px;">Hi${ctx.name ? ' ' + esc(ctx.name) : ''},</p>
      <p style="margin:0 0 14px;">${ctx.videosDone > 0
        ? `You got ${ctx.videosDone} video${ctx.videosDone === 1 ? '' : 's'} in, which is further than most people manage.`
        : 'You signed up for the crash course but haven\'t started it yet.'}</p>
      <p style="margin:0 0 18px;">${ctx.nextTitle
        ? `Next up is <strong>${esc(ctx.nextTitle)}</strong> — it's about 45 seconds.`
        : 'The whole thing is under six minutes.'}</p>
      <p style="margin:0 0 18px;">${cta(PORTAL_COURSE_URL, 'Pick up where you left off')}</p>`,
  }),

  nudge_2: (ctx) => ({
    subject: 'The bit everyone gets wrong',
    inner: `
      <p style="margin:0 0 14px;">Hi${ctx.name ? ' ' + esc(ctx.name) : ''},</p>
      <p style="margin:0 0 14px;">If you only watch one more, make it the storyboard video. Almost every
        expensive re-edit we've ever seen traces back to signing off a script without seeing
        what it looks like — and it's the cheapest mistake in the world to avoid.</p>
      <p style="margin:0 0 18px;">${cta(PORTAL_COURSE_URL, 'Watch it')}</p>
      <p style="margin:0;font-size:13px;color:#6B7785;">${ctx.videosDone}/${ctx.totalVideos} done so far.</p>`,
  }),

  nudge_3: (ctx) => ({
    subject: 'Nobody plans distribution. Video 5 does.',
    inner: `
      <p style="margin:0 0 14px;">Hi${ctx.name ? ' ' + esc(ctx.name) : ''},</p>
      <p style="margin:0 0 14px;">Most video projects decide where the video will live <em>after</em> it's
        made. That's backwards, and it's why so many good videos get watched by nobody.</p>
      <p style="margin:0 0 18px;">Video 5 takes 43 seconds and will change how you brief your next one.</p>
      <p style="margin:0 0 18px;">${cta(PORTAL_COURSE_URL, 'Finish the course')}</p>`,
  }),

  offer_1: (ctx) => ({
    subject: 'Want us to sanity-check your brief?',
    inner: `
      <p style="margin:0 0 14px;">Hi${ctx.name ? ' ' + esc(ctx.name) : ''},</p>
      <p style="margin:0 0 14px;">You've been through the crash course, so you already know what a good
        brief looks like. If you've got one in progress, we're happy to read it and tell you
        what we'd push back on — fifteen minutes, no pitch.</p>
      <p style="margin:0 0 14px;">We do this because a well-briefed project is easier for everyone,
        including us. There's no obligation and we won't chase you afterwards.</p>
      <p style="margin:0 0 18px;">${cta(`${APP_URL.replace(/\/$/, '')}/portal#/request`, 'Tell us about your video')}</p>`,
  }),

  offer_2: (ctx) => ({
    subject: 'Ready for a number?',
    inner: `
      <p style="margin:0 0 14px;">Hi${ctx.name ? ' ' + esc(ctx.name) : ''},</p>
      <p style="margin:0 0 14px;">Last one from us. If a video is on your list for this year, tell us
        roughly what you're after and we'll come back with a real price — not a range, and not a
        meeting invitation first.</p>
      <p style="margin:0 0 18px;">${cta(`${APP_URL.replace(/\/$/, '')}/portal#/request`, 'Get a price')}</p>
      <p style="margin:0;font-size:13px;color:#6B7785;">If the timing's wrong, no problem — this is
        the last email in the series either way.</p>`,
  }),
};

export function buildCourseEmail(kind, ctx) {
  const t = TEMPLATES[kind];
  if (!t) return null;
  const { subject, inner } = t(ctx);
  const unsubscribeUrl = unsubscribeUrlFor(ctx.email, 'course');
  return {
    subject,
    html: shell(inner, unsubscribeUrl),
    text: `${subject}\n\nWatch the course: ${PORTAL_COURSE_URL}\n\nUnsubscribe: ${unsubscribeUrl}`,
    unsubscribeUrl,
  };
}

export { PORTAL_COURSE_URL, firstName };
