import sql from '../db.js';
import { sendMail, APP_URL } from '../email.js';
import { sendNotification, resolveRecipients, persistInApp } from '../notifications.js';
import { registerWatch } from '../gmailTokens.js';
import { syncHistory } from '../gmailSync.js';
import { escapeHtml, makeId } from './shared.js';
import { getFreshAccessToken, performGmailSend } from './gmail.js';
import { getEventAttendees } from '../googleCalendar.js';
import { del } from '@vercel/blob';
import { buildResumeEmail } from '../quoteResumeEmail.js';
import { signTaskActionToken } from '../auth.js';
import { quarterTaxSummary } from './stats.js';
import { cronAdSpendSync } from './googleAds.js';
import { timingSafeEqualStr } from '../middleware.js';

export async function cronHandler(req, res, action) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  // Vercel cron requests carry a Bearer token equal to CRON_SECRET. Reject
  // anything else so the endpoint isn't a public spam trigger.
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.warn('[cron] CRON_SECRET not set — refusing to run');
    return res.status(500).json({ error: 'Cron secret not configured' });
  }
  const auth = req.headers.authorization || '';
  if (!timingSafeEqualStr(auth, 'Bearer ' + expected)) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  switch (action) {
    case 'task-reminders':    return cronTaskReminders(res);
    case 'task-digest':       return cronTaskDigest(res);
    case 'gmail-watch-renew': return cronGmailWatchRenew(res);
    case 'prune-views':       return cronPruneViews(res);
    case 'quote-partials':    return cronQuotePartials(res);
    case 'quote-resume':      return cronQuoteResume(res);
    case 'scheduled-emails':  return cronScheduledEmails(res);
    case 'invoice-reminders': return cronInvoiceReminders(res);
    case 'quarterly-tax-summary': return cronQuarterlyTaxSummary(res);
    case 'director-tax-reminders': return cronDirectorTaxReminders(res);
    case 'intro-call-reminders': return cronIntroCallReminders(req, res);
    case 'ad-spend-sync':     return cronAdSpendSync(res);
    default:                  return res.status(404).json({ error: 'Unknown cron action: ' + action });
  }
}

const PARTIAL_NOTIFY_TO = process.env.QUOTE_REQUEST_NOTIFY_TO || 'adam@squideo.co.uk';

function buildPartialEmail(p) {
  const rows = [
    ['Name', p.name],
    ['Email', p.email],
    ['Phone', p.phone ? `${p.country_code || ''} ${p.phone}`.trim() : null],
    ['Company', p.company],
    ['Timeline', p.timeline],
    ['Budget', p.budget],
    ['Country', p.country_name],
    ['Source', p.source_url],
    ['Reached step', p.last_step ? `${p.last_step} of 4` : null],
  ].filter(([, v]) => v != null && v !== '');

  const rowHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 14px 6px 0;color:#6B7785;font-size:13px;vertical-align:top;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:6px 0;font-size:13px;">${escapeHtml(v)}</td></tr>`
    )
    .join('');

  const details = p.project_details
    ? `<h3 style="margin:18px 0 8px;font-size:14px;font-weight:700;">Project details</h3>
       <div style="white-space:pre-wrap;font-size:13px;line-height:1.55;background:#FAFBFC;border:1px solid #E5E9EE;border-radius:8px;padding:12px 14px;">${escapeHtml(p.project_details)}</div>`
    : '';

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0F2A3D;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFBFC;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border:1px solid #E5E9EE;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:24px 28px;border-bottom:1px solid #E5E9EE;">
          <div style="font-size:18px;font-weight:700;color:#F59E0B;">Partial quote request — visitor stopped before submitting</div>
        </td></tr>
        <tr><td style="padding:24px 28px;font-size:14px;line-height:1.55;color:#0F2A3D;">
          <p style="margin:0 0 14px;font-size:13px;color:#6B7785;">A visitor completed the project details but didn't finish the form. Last activity 20+ minutes ago.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
            ${rowHtml}
          </table>
          ${details}
          <p style="margin:20px 0 0;font-size:12px;color:#6B7785;">Started ${escapeHtml(new Date(p.created_at).toLocaleString('en-GB'))} · Last activity ${escapeHtml(new Date(p.last_activity_at).toLocaleString('en-GB'))}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export async function cronQuoteResume(res) {
  // Pick up reminders whose scheduled_for has passed and that aren't sent yet.
  // Skip any session where the user has unsubscribed or already completed.
  const due = await sql`
    SELECT r.id, r.form_session_id, r.email, r.name, r.resume_url, r.kind, r.unsubscribe_token
    FROM quote_request_resume_emails r
    LEFT JOIN quote_request_partials p ON p.form_session_id = r.form_session_id
    WHERE r.sent_at IS NULL
      AND r.unsubscribed_at IS NULL
      AND r.scheduled_for <= NOW()
      AND p.completed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM quote_requests qr
        WHERE LOWER(qr.email) = LOWER(r.email)
      )
    ORDER BY r.scheduled_for ASC
    LIMIT 50
  `;

  let sent = 0;
  for (const r of due) {
    try {
      const unsubscribeUrl = `${APP_URL.replace(/\/$/, '')}/api/quote-requests?action=unsubscribe&token=${r.unsubscribe_token}`;
      const { subject, html } = buildResumeEmail({
        kind: r.kind,
        name: r.name,
        resumeUrl: r.resume_url,
        unsubscribeUrl,
      });
      await sendMail({ to: r.email, subject, html });
      await sql`
        UPDATE quote_request_resume_emails
        SET sent_at = NOW()
        WHERE id = ${r.id}
      `;
      sent++;
    } catch (err) {
      console.error('[cron quote-resume] send failed', { id: r.id, err: err.message });
    }
  }

  return res.status(200).json({ ok: true, found: due.length, sent });
}

// Dispatch composer-scheduled emails whose time has come. Runs as the user who
// queued each one (refresh token persists server-side, like gmail-watch-renew),
// calls the shared performGmailSend, then cleans up the attachment blobs.
export async function cronScheduledEmails(res) {
  const due = await sql`
    SELECT id, user_email, payload
    FROM scheduled_emails
    WHERE status = 'pending' AND scheduled_for <= NOW()
    ORDER BY scheduled_for ASC
    LIMIT 50
  `;

  let sent = 0;
  for (const row of due) {
    try {
      const nameRow = (await sql`SELECT name FROM users WHERE email = ${row.user_email}`)[0];
      const user = { email: row.user_email, name: nameRow?.name || null };
      await performGmailSend(user, row.payload);
      await sql`UPDATE scheduled_emails SET status = 'sent', sent_at = NOW() WHERE id = ${row.id}`;
      // Best-effort blob cleanup — orphans are harmless.
      for (const a of row.payload?.attachments || []) {
        const target = a.blobUrl || a.blobPathname;
        if (target) { try { await del(target); } catch (_) { /* ignore */ } }
      }
      sent++;
    } catch (err) {
      console.error('[cron scheduled-emails] send failed', { id: row.id, err: err.message });
      // Mark failed so we don't retry forever; the user can re-send manually.
      await sql`UPDATE scheduled_emails SET status = 'failed', error = ${String(err.message || err).slice(0, 500)} WHERE id = ${row.id}`;
    }
  }

  return res.status(200).json({ ok: true, found: due.length, sent });
}

export async function cronQuotePartials(res) {
  const rows = await sql`
    SELECT p.form_session_id, p.name, p.email, p.phone, p.country_code, p.country_name,
           p.company, p.project_details, p.timeline, p.budget, p.source_url, p.last_step,
           p.last_activity_at, p.created_at
    FROM quote_request_partials p
    WHERE p.completed_at IS NULL
      AND p.notified_at IS NULL
      AND p.project_details IS NOT NULL
      AND p.last_activity_at < NOW() - INTERVAL '20 minutes'
      AND (
        p.email IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM quote_requests qr WHERE LOWER(qr.email) = LOWER(p.email)
        )
      )
    ORDER BY p.last_activity_at ASC
    LIMIT 25
  `;

  let sent = 0;
  for (const p of rows) {
    try {
      const subjectName = p.name || p.email || 'Anonymous visitor';
      // Subscribed users get it via the prefs system. The PARTIAL_NOTIFY_TO
      // env var is kept as a safety net so a fresh deploy with nobody opted
      // in still gets the alert — added as extraRecipients (deduped).
      await sendNotification('quote_request.partial', {
        subject: `Partial quote request from ${subjectName}`,
        html: buildPartialEmail(p),
        extraRecipients: PARTIAL_NOTIFY_TO ? [PARTIAL_NOTIFY_TO] : [],
      });
      await sql`
        UPDATE quote_request_partials
        SET notified_at = NOW()
        WHERE form_session_id = ${p.form_session_id}
      `;
      sent++;
    } catch (err) {
      console.error('[cron quote-partials] send failed', { sessionId: p.form_session_id, err: err.message });
    }
  }

  return res.status(200).json({ ok: true, found: rows.length, sent });
}

// GDPR retention: proposal_views collects IP + UA per open, which is personal
// data under UK/EU rules. Keep 12 months max; clients aren't told their IP is
// being captured so a long retention window is hard to justify.
export async function cronPruneViews(res) {
  const result = await sql`
    DELETE FROM proposal_views WHERE opened_at < NOW() - INTERVAL '12 months'
  `;
  console.log('[cron prune-views] deleted', { count: result.count || result.rowCount || 0 });
  return res.status(200).json({ ok: true, deleted: result.count || result.rowCount || 0 });
}

// Hourly nudge: a proposal signed >1h ago with no invoice raised and nothing
// paid → email + in-app the deal owner ("creator"), once. Self-heals the
// tracking column and the role-default seed so it works pre-migration.
export async function cronInvoiceReminders(res) {
  await sql`ALTER TABLE signatures ADD COLUMN IF NOT EXISTS invoice_reminder_sent_at TIMESTAMPTZ`;
  await sql`UPDATE roles SET notification_defaults = jsonb_set(notification_defaults, '{invoice.needs_generating}', 'true', true) WHERE NOT (notification_defaults ? 'invoice.needs_generating')`;

  const due = await sql`
    SELECT s.proposal_id, s.signed_at, p.deal_id, d.owner_email,
           d.company_id, d.title AS deal_title, co.name AS company_name
      FROM signatures s
      JOIN proposals p ON p.id = s.proposal_id
      JOIN deals d ON d.id = p.deal_id
      LEFT JOIN companies co ON co.id = d.company_id
     WHERE s.invoice_reminder_sent_at IS NULL
       AND s.signed_at < NOW() - INTERVAL '1 hour'
       AND NOT EXISTS (SELECT 1 FROM manual_invoices mi WHERE mi.proposal_id = s.proposal_id OR mi.deal_id = p.deal_id)
       AND NOT EXISTS (SELECT 1 FROM proposal_billing pb WHERE pb.proposal_id = s.proposal_id AND pb.xero_invoice_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM payments pay WHERE pay.proposal_id = s.proposal_id)
       AND NOT EXISTS (SELECT 1 FROM partner_invoices pi WHERE pi.proposal_id = s.proposal_id)
       AND NOT EXISTS (SELECT 1 FROM manual_payments mp WHERE mp.proposal_id = s.proposal_id)
     ORDER BY s.signed_at ASC
     LIMIT 100
  `;

  let sent = 0;
  for (const r of due) {
    if (!r.owner_email) continue; // no owner to nudge — leave it for next sweep
    const name = r.company_name || r.deal_title || 'a client';
    const root = APP_URL.replace(/\/$/, '');
    const link = r.company_id ? `${root}/#/company/${r.company_id}` : root;
    const subject = `Invoice needs generating — ${name}`;
    const html = `
      <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">Invoice needs generating</h2>
      <p style="margin:0 0 12px;"><strong>${escapeHtml(name)}</strong> signed a proposal over an hour ago and no invoice has been raised yet.</p>
      ${r.deal_title ? `<p style="margin:0 0 16px;color:#6B7785;">Deal: ${escapeHtml(r.deal_title)}</p>` : ''}
      <p style="margin:16px 0 0;"><a href="${link}" style="display:inline-block;background:#DC2626;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Create the invoice</a></p>
    `;
    const text = `Invoice needs generating: ${name} signed a proposal over an hour ago with no invoice raised. ${link}`;
    try {
      await sendNotification('invoice.needs_generating', {
        ownerEmail: r.owner_email,
        subject, html, text,
        inApp: {
          title: `Invoice needs generating — ${name}`,
          body: 'Signed proposal with no invoice raised yet.',
          link: r.company_id ? `#/company/${r.company_id}` : null,
        },
      });
      await sql`UPDATE signatures SET invoice_reminder_sent_at = NOW() WHERE proposal_id = ${r.proposal_id}`;
      sent++;
    } catch (err) {
      console.error('[cron invoice-reminders] failed', { proposalId: r.proposal_id, err: err.message });
    }
  }
  return res.status(200).json({ ok: true, found: due.length, sent });
}

const QUARTER_TAX_NOTIFY_TO = process.env.QUARTER_TAX_NOTIFY_TO || 'adam@squideo.co.uk';

// End-of-quarter summary: once a calendar quarter has fully ended, email + in-app
// the owner the VAT and Corporation Tax they should have set aside for it. Runs
// daily; a guard table makes it fire exactly once per quarter. On the very first
// run it backfills the guard WITHOUT sending, so deploying mid-quarter doesn't
// trigger a surprise summary for an old quarter — it only sends going forward.
export async function cronQuarterlyTaxSummary(res) {
  await sql`CREATE TABLE IF NOT EXISTS finance_quarter_summaries (quarter TEXT PRIMARY KEY, sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  // Self-heal the role default so the owner target actually resolves a recipient.
  await sql`UPDATE roles SET notification_defaults = jsonb_set(notification_defaults, '{finance.quarter_summary}', 'true', true) WHERE NOT (notification_defaults ? 'finance.quarter_summary')`;

  // The most recently ENDED calendar quarter, relative to now.
  const now = new Date();
  let y = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3) - 1; // previous quarter (0-3)
  if (q < 0) { q = 3; y -= 1; }
  const qNum = q + 1;
  const quarterKey = `${y}-Q${qNum}`;

  const [existing] = await sql`SELECT 1 FROM finance_quarter_summaries WHERE quarter = ${quarterKey}`;
  if (existing) return res.status(200).json({ ok: true, quarter: quarterKey, status: 'already-sent' });

  // First-ever run: seed the guard for this quarter without sending.
  const [{ cnt }] = await sql`SELECT COUNT(*)::int AS cnt FROM finance_quarter_summaries`;
  if (cnt === 0) {
    await sql`INSERT INTO finance_quarter_summaries (quarter) VALUES (${quarterKey}) ON CONFLICT DO NOTHING`;
    return res.status(200).json({ ok: true, quarter: quarterKey, status: 'seeded-no-send' });
  }

  const s = await quarterTaxSummary(y, qNum);
  const root = APP_URL.replace(/\/$/, '');
  const link = `${root}/#/finance`;
  const gbp = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const total = gbp((Number(s.vat) || 0) + (Number(s.corpTax) || 0));
  const subject = `${s.label}: set aside ${gbp(s.vat)} VAT + ${gbp(s.corpTax)} Corp Tax`;
  const html = `
    <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">${escapeHtml(s.label)} — money to set aside</h2>
    <p style="margin:0 0 16px;color:#6B7785;">Based on cash banked in ${escapeHtml(s.label)} (ex-VAT) and your current cost base. Estimates — confirm with your accountant.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:420px;">
      <tr><td style="padding:8px 0;font-size:14px;">VAT to set aside</td><td style="padding:8px 0;font-size:16px;font-weight:700;text-align:right;color:#F59E0B;">${gbp(s.vat)}</td></tr>
      <tr><td style="padding:8px 0;font-size:14px;border-top:1px solid #E5E9EE;">Corporation Tax to set aside</td><td style="padding:8px 0;font-size:16px;font-weight:700;text-align:right;color:#0E7490;border-top:1px solid #E5E9EE;">${gbp(s.corpTax)}</td></tr>
      <tr><td style="padding:8px 0;font-size:14px;font-weight:700;border-top:2px solid #E5E9EE;">Total to set aside</td><td style="padding:8px 0;font-size:16px;font-weight:800;text-align:right;border-top:2px solid #E5E9EE;">${total}</td></tr>
    </table>
    <p style="margin:20px 0 0;"><a href="${link}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Open Finance → VAT &amp; Corp tax</a></p>
  `;
  const text = `${s.label}: set aside ${gbp(s.vat)} VAT + ${gbp(s.corpTax)} Corporation Tax (total ${total}). ${link}`;

  try {
    await sendNotification('finance.quarter_summary', {
      ownerEmail: QUARTER_TAX_NOTIFY_TO,
      subject, html, text,
      extraRecipients: [QUARTER_TAX_NOTIFY_TO],
      inApp: { title: subject, body: `Set aside ${gbp(s.vat)} VAT + ${gbp(s.corpTax)} Corp Tax for ${s.label}.`, link: '#/finance' },
    });
    await sql`INSERT INTO finance_quarter_summaries (quarter) VALUES (${quarterKey}) ON CONFLICT DO NOTHING`;
    return res.status(200).json({ ok: true, quarter: quarterKey, status: 'sent', vat: s.vat, corpTax: s.corpTax });
  } catch (err) {
    console.error('[cron quarterly-tax-summary] failed', { quarter: quarterKey, err: err.message });
    return res.status(500).json({ ok: false, quarter: quarterKey, error: err.message });
  }
}

// Both company directors get every tax-payment reminder (email + finance bell).
const DIRECTOR_TAX_RECIPIENTS = ['adam@squideo.co.uk', 'ben@squideo.co.uk'];

// Upcoming tax payments (Directors tab) drive a two-step transfer reminder that
// mirrors how the money actually moves: funds clear out of the Shawbrook savings
// account first, then transfer from the current account to HMRC once landed.
//   • 7 days before due → transfer 1 (Shawbrook → current account, so it clears)
//   • 6 days before due → transfer 2 (current account → HMRC, quoting the reference)
// No on-the-day reminder — by then it's already been paid. Runs daily; two guard
// columns make each step fire exactly once. Editing a payment's date/amount nulls
// the guards (see directorTaxRoute) so the reminders re-arm.
export async function cronDirectorTaxReminders(res) {
  // Self-heal the table in case the migration hasn't been applied yet.
  await sql`
    CREATE TABLE IF NOT EXISTS director_tax_payments (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT, due_date DATE NOT NULL,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0, reference TEXT, note TEXT,
      reminded_transfer1_at TIMESTAMPTZ, reminded_transfer2_at TIMESTAMPTZ, sort_order INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;

  // Both directors always get the reminder (email + finance bell + push), sent
  // directly rather than via the preference resolver — these are not optional.
  const notifyBoth = async (subject, html, text, inApp) => {
    await sendMail({ to: DIRECTOR_TAX_RECIPIENTS, subject, html, text });
    await persistInApp('finance.tax_payment_due', DIRECTOR_TAX_RECIPIENTS, { subject, text, inApp });
  };

  // Anything within the 7-day window that still has a reminder pending.
  const due = await sql`
    SELECT id, title, kind, due_date, amount, reference, note, reminded_transfer1_at, reminded_transfer2_at
      FROM director_tax_payments
     WHERE due_date >= CURRENT_DATE
       AND due_date <= CURRENT_DATE + INTERVAL '7 days'
       AND (reminded_transfer1_at IS NULL OR reminded_transfer2_at IS NULL)
     ORDER BY due_date ASC`;

  const root = APP_URL.replace(/\/$/, '');
  const link = `${root}/#/finance`;
  const gbp = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // A DATE column arrives as 'YYYY-MM-DD' (string) or a Date — normalise to the key.
  const ymd = (d) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
  const dueLabel = (d) => new Date(ymd(d) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysUntil = (d) => Math.round((new Date(ymd(d) + 'T00:00:00Z').getTime() - todayUTC) / 86400000);

  let sent = 0;
  for (const p of due) {
    const amt = gbp(p.amount);
    const when = dueLabel(p.due_date);
    const left = daysUntil(p.due_date); // whole days from today to the due date

    // Transfer 1 — fire once we're within 7 days and it hasn't gone yet.
    if (!p.reminded_transfer1_at && left <= 7) {
      const subject = `Move ${amt} for ${p.title} out of Shawbrook (${left}d to ${when})`;
      const html = `
        <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">Step 1 — move the money so it clears</h2>
        <p style="margin:0 0 16px;color:#6B7785;">${escapeHtml(p.title)} is due <strong>${escapeHtml(when)}</strong> (${left} day${left === 1 ? '' : 's'} away). Transfer it out of the Shawbrook savings account into the current account now so the funds clear in time.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:420px;">
          <tr><td style="padding:8px 0;font-size:14px;">Amount to move</td><td style="padding:8px 0;font-size:16px;font-weight:700;text-align:right;">${amt}</td></tr>
          <tr><td style="padding:8px 0;font-size:14px;border-top:1px solid #E5E9EE;">Due date</td><td style="padding:8px 0;font-size:14px;text-align:right;border-top:1px solid #E5E9EE;">${escapeHtml(when)}</td></tr>
        </table>
        <p style="margin:20px 0 0;"><a href="${link}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Open Finance → Directors</a></p>`;
      const text = `Step 1: move ${amt} for ${p.title} out of Shawbrook into the current account so it clears. Due ${when}. ${link}`;
      try {
        await notifyBoth(subject, html, text, { title: subject, body: `Move ${amt} out of Shawbrook for ${p.title}, due ${when}.`, link: '#/finance' });
        await sql`UPDATE director_tax_payments SET reminded_transfer1_at = NOW(), updated_at = NOW() WHERE id = ${p.id}`;
        sent++;
      } catch (err) {
        console.error('[cron director-tax-reminders] transfer1 failed', { id: p.id, err: err.message });
      }
    }

    // Transfer 2 — the next day (6 days before due), once the money has landed.
    if (!p.reminded_transfer2_at && left <= 6) {
      const ref = p.reference ? `, reference ${p.reference}` : '';
      const subject = `Pay HMRC ${amt} for ${p.title} (due ${when})`;
      const html = `
        <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">Step 2 — pay HMRC now it's cleared</h2>
        <p style="margin:0 0 16px;color:#6B7785;">The funds for ${escapeHtml(p.title)} should have landed in the current account. Transfer ${amt} to HMRC${p.reference ? ' quoting the reference below' : ''}. Due <strong>${escapeHtml(when)}</strong>.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:420px;">
          <tr><td style="padding:8px 0;font-size:14px;">Amount to pay</td><td style="padding:8px 0;font-size:16px;font-weight:700;text-align:right;">${amt}</td></tr>
          ${p.reference ? `<tr><td style="padding:8px 0;font-size:14px;border-top:1px solid #E5E9EE;">Reference</td><td style="padding:8px 0;font-size:14px;font-weight:700;text-align:right;border-top:1px solid #E5E9EE;">${escapeHtml(p.reference)}</td></tr>` : ''}
          <tr><td style="padding:8px 0;font-size:14px;border-top:1px solid #E5E9EE;">Due date</td><td style="padding:8px 0;font-size:14px;text-align:right;border-top:1px solid #E5E9EE;">${escapeHtml(when)}</td></tr>
        </table>
        <p style="margin:20px 0 0;"><a href="${link}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Open Finance → Directors</a></p>`;
      const text = `Step 2: pay HMRC ${amt} for ${p.title}${ref}. Due ${when}. ${link}`;
      try {
        await notifyBoth(subject, html, text, { title: subject, body: `Pay HMRC ${amt} for ${p.title}${ref}, due ${when}.`, link: '#/finance' });
        await sql`UPDATE director_tax_payments SET reminded_transfer2_at = NOW(), updated_at = NOW() WHERE id = ${p.id}`;
        sent++;
      } catch (err) {
        console.error('[cron director-tax-reminders] transfer2 failed', { id: p.id, err: err.message });
      }
    }
  }
  return res.status(200).json({ ok: true, found: due.length, sent });
}

export async function cronTaskReminders(res) {
  // Runs every 15 minutes (vercel.json). Fire a reminder once a task is at /
  // near its due time — the 15-minute lookahead matches the cron cadence so a
  // reminder lands at most ~15 min early and never late. Already-overdue tasks
  // that were never reminded (e.g. created past due) are swept too, since
  // there's no lower bound. reminded_at keeps it to once per task.
  const due = await sql`
    SELECT t.id, t.title, t.due_at, t.assignee_email, t.deal_id, t.notes,
           d.title AS deal_title,
           (SELECT COALESCE(ARRAY_AGG(ta.user_email), '{}')
            FROM task_assignees ta WHERE ta.task_id = t.id) AS assignees
    FROM tasks t
    LEFT JOIN deals d ON d.id = t.deal_id
    WHERE t.done_at IS NULL
      AND t.reminded_at IS NULL
      AND t.due_at IS NOT NULL
      AND t.due_at <= NOW() + INTERVAL '15 minutes'
    ORDER BY t.due_at ASC
    LIMIT 200
  `;

  let sent = 0;
  for (const t of due) {
    // Prefer the join table; fall back to legacy single column for any task
    // that pre-dates the multi-assignee migration and hasn't been re-saved.
    const joined = Array.isArray(t.assignees) ? t.assignees.filter(Boolean) : [];
    const recipients = joined.length ? joined : (t.assignee_email ? [t.assignee_email] : []);
    if (!recipients.length) continue;
    const dueLabel = new Date(t.due_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    const dealLink = t.deal_id ? `${APP_URL}/?deal=${encodeURIComponent(t.deal_id)}` : APP_URL;
    const subject = `Reminder: ${t.title}`;
    // Per-recipient signed token so each click is attributable in the audit log.
    const baseRoot = APP_URL.replace(/\/$/, '');
    const buildHtml = (doneUrl) => `
      <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">Task due ${dueLabel}</h2>
      <p style="margin:0 0 12px;"><strong>${escapeHtml(t.title)}</strong>${t.deal_title ? ` — on deal <em>${escapeHtml(t.deal_title)}</em>` : ''}</p>
      ${t.notes ? `<p style="margin:0 0 16px;color:#6B7785;">${escapeHtml(t.notes)}</p>` : ''}
      <p style="margin:16px 0 0;">
        <a href="${doneUrl}" style="display:inline-block;background:#16A34A;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;margin-right:8px;">Mark as done</a>
        <a href="${dealLink}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Open in Squideo</a>
      </p>
    `;
    // Filter by per-user pref via resolveRecipients (audience: assignee).
    const subscribed = await resolveRecipients('task.reminder', { assigneeEmails: recipients });
    if (!subscribed.length) continue;

    // Fan out in parallel — Resend rate limits are well above our team size.
    const results = await Promise.allSettled(
      subscribed.map(async (to) => {
        const token = await signTaskActionToken({ taskId: t.id, email: to, action: 'done' });
        const doneUrl = `${baseRoot}/api/crm/tasks/${encodeURIComponent(t.id)}/done-link?token=${encodeURIComponent(token)}`;
        const text = `Reminder: ${t.title} — due ${dueLabel}${t.deal_title ? ' (deal: ' + t.deal_title + ')' : ''}.\nMark done: ${doneUrl}\nOpen: ${dealLink}`;
        return sendMail({ to, subject, html: buildHtml(doneUrl), text });
      })
    );
    const anySent = results.some(r => r.status === 'fulfilled');
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error('[cron task-reminders] send failed', { taskId: t.id, to: subscribed[i], err: r.reason });
      }
    });
    if (anySent) {
      // Mirror the email into the bell + a background desktop push (Tier 2),
      // so a reminder still lands if the assignee isn't reading email. Tagged
      // task-<id> to collapse with the in-tab popup the app fires at due time.
      const inAppLink = t.deal_id ? `#/deal/${t.deal_id}` : '#/tasks';
      await persistInApp('task.reminder', subscribed, {
        subject,
        inApp: {
          title: `Task due: ${t.title}`,
          body: t.deal_title || t.notes || null,
          link: inAppLink,
          tag: `task-${t.id}`,
        },
      });
      // Stamp once per task — we don't track per-assignee delivery state on
      // purpose; if one address bounces, the team coordinates in-app.
      await sql`UPDATE tasks SET reminded_at = NOW() WHERE id = ${t.id}`;
      sent++;
    }
  }

  return res.status(200).json({ ok: true, found: due.length, sent });
}

// Morning digest — runs once a day (vercel.json) as the heads-up counterpart to
// the at-due task.reminder ping. Emails each assignee a summary of the tasks
// they have due today (or already overdue and not yet digested), and mirrors it
// to the bell + a desktop push. digest_sent_at gates it to once per task, so a
// task appears in exactly one morning digest — the morning of its due date.
// Self-heals the column and seeds the role default (copying each role's
// task.reminder setting) so it works pre-migration.
export async function cronTaskDigest(res) {
  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS digest_sent_at TIMESTAMPTZ`;
  await sql`
    UPDATE roles
       SET notification_defaults = jsonb_set(
         notification_defaults, '{task.digest}',
         COALESCE(notification_defaults->'task.reminder', 'false'::jsonb), true)
     WHERE NOT (notification_defaults ? 'task.digest')`;

  const rows = await sql`
    SELECT t.id, t.title, t.due_at, t.deal_id, t.notes, t.assignee_email,
           d.title AS deal_title,
           (SELECT COALESCE(ARRAY_AGG(ta.user_email), '{}')
            FROM task_assignees ta WHERE ta.task_id = t.id) AS assignees
    FROM tasks t
    LEFT JOIN deals d ON d.id = t.deal_id
    WHERE t.done_at IS NULL
      AND t.digest_sent_at IS NULL
      AND t.due_at IS NOT NULL
      AND t.due_at < date_trunc('day', NOW()) + INTERVAL '1 day'
    ORDER BY t.due_at ASC
    LIMIT 500
  `;

  if (!rows.length) return res.status(200).json({ ok: true, found: 0, sent: 0 });

  // Fan tasks out per assignee so each person gets their own list.
  const byUser = new Map();
  for (const t of rows) {
    const joined = Array.isArray(t.assignees) ? t.assignees.filter(Boolean) : [];
    const recipients = joined.length ? joined : (t.assignee_email ? [t.assignee_email] : []);
    for (const e of recipients) {
      const key = e.toLowerCase();
      if (!byUser.has(key)) byUser.set(key, []);
      byUser.get(key).push(t);
    }
  }

  const baseRoot = APP_URL.replace(/\/$/, '');
  const tasksUrl = `${baseRoot}/#/tasks`;
  let sent = 0;
  for (const [email, tasks] of byUser) {
    const subject = tasks.length === 1
      ? `Task due today: ${tasks[0].title}`
      : `${tasks.length} tasks due today`;
    const summary = tasks.slice(0, 3).map(t => t.title).join(', ')
      + (tasks.length > 3 ? ` +${tasks.length - 3} more` : '');
    try {
      // sendNotification filters by the recipient's task.digest pref, then emails
      // + persists in-app + pushes in one call.
      const r = await sendNotification('task.digest', {
        assigneeEmails: [email],
        subject,
        html: buildDigestEmail(tasks, tasksUrl),
        text: `Due today:\n${tasks.map(t => `• ${t.title} — ${new Date(t.due_at).toLocaleString('en-GB', { timeStyle: 'short' })}${t.deal_title ? ' (' + t.deal_title + ')' : ''}`).join('\n')}\n\n${tasksUrl}`,
        inApp: {
          title: subject,
          body: summary,
          link: '#/tasks',
          tag: `task-digest-${new Date().toISOString().slice(0, 10)}`,
        },
      });
      if (r.sent) sent++;
    } catch (err) {
      console.error('[cron task-digest] send failed', { email, err: err.message });
    }
  }

  // Stamp every picked task so it's never digested twice, regardless of whether
  // an individual assignee had the digest pref on.
  const ids = rows.map(r => r.id);
  await sql`UPDATE tasks SET digest_sent_at = NOW() WHERE id = ANY(${ids})`;

  return res.status(200).json({ ok: true, found: rows.length, recipients: byUser.size, sent });
}

function buildDigestEmail(tasks, tasksUrl) {
  const items = tasks.map((t) => {
    const due = new Date(t.due_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    const deal = t.deal_title ? ` <span style="color:#6B7785;">· ${escapeHtml(t.deal_title)}</span>` : '';
    return `<li style="margin:0 0 10px;font-size:14px;line-height:1.5;">
      <strong>${escapeHtml(t.title)}</strong>${deal}<br/>
      <span style="font-size:12px;color:#6B7785;">Due ${escapeHtml(due)}</span>
    </li>`;
  }).join('');
  return `
    <h2 style="margin:0 0 4px;font-size:18px;font-weight:700;">Your tasks due today</h2>
    <p style="margin:0 0 16px;color:#6B7785;font-size:13px;">${tasks.length} task${tasks.length === 1 ? '' : 's'} on your plate.</p>
    <ul style="margin:0 0 20px;padding-left:18px;">${items}</ul>
    <p style="margin:16px 0 0;"><a href="${tasksUrl}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Open your tasks</a></p>
  `;
}

// Daily Gmail housekeeping: (1) renew watches within 24h of expiring (Gmail
// watches die at ~7 days), and (2) run a poll-fallback sync for any account
// whose Pub/Sub push has gone quiet for >2h. Both jobs share an iteration of
// `gmail_accounts` so we don't pay for two separate crons (Hobby cap = 1/day
// per cron, and we'd rather not consume two slots).
//
// Best-effort per account — one user's failure doesn't block the rest.
export async function cronGmailWatchRenew(res) {
  const accounts = await sql`
    SELECT user_email, pubsub_topic, history_id, watch_expires_at, last_pushed_at
    FROM gmail_accounts
    WHERE disconnected_at IS NULL
  `;

  let renewed = 0;
  let renewFailed = 0;
  let polled = 0;
  let pollFailed = 0;
  let pollIngested = 0;

  for (const row of accounts) {
    const watchDue = !row.watch_expires_at || new Date(row.watch_expires_at).getTime() < Date.now() + 24 * 60 * 60 * 1000;
    const pushStale = !row.last_pushed_at || (Date.now() - new Date(row.last_pushed_at).getTime()) > 2 * 60 * 60 * 1000;

    if (!watchDue && !pushStale) continue;

    let accessToken;
    try {
      accessToken = await getFreshAccessToken(row.user_email);
    } catch (err) {
      console.error('[cron gmail housekeeping] cannot acquire access token', { user: row.user_email, err: err.message });
      renewFailed++;
      continue;
    }

    // ---- 1. Watch renewal ----
    if (watchDue) {
      const topic = row.pubsub_topic || process.env.GMAIL_PUBSUB_TOPIC;
      if (!topic) {
        console.warn('[cron watch-renew] no topic configured for', row.user_email);
      } else {
        try {
          const watch = await registerWatch(accessToken, topic);
          await sql`
            UPDATE gmail_accounts
               SET watch_expires_at = ${watch.expiration ? new Date(watch.expiration).toISOString() : null},
                   history_id = COALESCE(history_id, ${watch.historyId}),
                   pubsub_topic = ${topic},
                   updated_at = NOW()
             WHERE user_email = ${row.user_email}
          `;
          renewed++;
        } catch (err) {
          console.error('[cron watch-renew] failed for', row.user_email, err.message);
          renewFailed++;
        }
      }
    }

    // ---- 2. Poll-fallback (only if Pub/Sub looks dead and we have a watermark) ----
    if (pushStale && row.history_id) {
      try {
        const result = await syncHistory({
          userEmail: row.user_email,
          accessToken,
          fromHistoryId: row.history_id,
        });
        // Advance the watermark so the next sync doesn't reprocess.
        if (result.latestHistoryId && result.latestHistoryId !== row.history_id) {
          await sql`
            UPDATE gmail_accounts
               SET history_id = ${result.latestHistoryId},
                   last_pushed_at = NOW(),
                   updated_at = NOW()
             WHERE user_email = ${row.user_email}
          `;
        }
        polled++;
        pollIngested += result.ingested || 0;
      } catch (err) {
        if (err.code === 'HISTORY_GONE') {
          // Watermark expired (Gmail keeps ~7 days of history). The watch
          // renew above will have just set a fresh historyId, but if we
          // skipped renewal for some reason, force a fresh registration so
          // the next push has a valid starting point.
          console.warn('[cron poll-fallback] history gone — resetting watermark for', row.user_email);
          try {
            const topic = row.pubsub_topic || process.env.GMAIL_PUBSUB_TOPIC;
            if (topic) {
              const watch = await registerWatch(accessToken, topic);
              await sql`
                UPDATE gmail_accounts
                   SET history_id = ${watch.historyId},
                       watch_expires_at = ${watch.expiration ? new Date(watch.expiration).toISOString() : null},
                       updated_at = NOW()
                 WHERE user_email = ${row.user_email}
              `;
            }
          } catch (innerErr) {
            console.error('[cron poll-fallback] watch reset failed', innerErr.message);
            pollFailed++;
          }
        } else {
          console.error('[cron poll-fallback] failed for', row.user_email, err.message);
          pollFailed++;
        }
      }
    }
  }

  return res.status(200).json({
    ok: true,
    considered: accounts.length,
    watchRenewed: renewed,
    watchFailed: renewFailed,
    polled,
    pollIngested,
    pollFailed,
  });
}

// ── Intro-call day-of reminders ───────────────────────────────────────────────
// Runs hourly. Two independent, separately-flagged jobs per confirmed booking
// still to come today:
//   • Client reminder email — at 09:00 in the CLIENT's own timezone, on the
//     meeting's client-local day.
//   • Team task — at 09:00 Europe/London on the meeting's London day, assigned to
//     the team members CURRENTLY invited at our side (re-read live from the
//     Google event; falls back to the booking snapshot).
// Local hour + Y-M-D for an instant in a given IANA timezone (Intl-based, so a
// stored tz that passed validation here is always safe).
function tzParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  });
  const p = {};
  for (const x of dtf.formatToParts(date)) p[x.type] = x.value;
  return { hour: p.hour === '24' ? 0 : parseInt(p.hour, 10), date: `${p.year}-${p.month}-${p.day}` };
}
function safeTz(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch { return 'Europe/London'; }
}
// True when `now` is 9am on the meeting's local day, in the given timezone.
function isNineAmOnMeetingDay(now, start, timeZone) {
  const np = tzParts(now, timeZone);
  const mp = tzParts(start, timeZone);
  return np.hour === 9 && np.date === mp.date;
}

function introCallReminderHtml({ clientName, projectName, whenLabel, meetUrl }) {
  const inner = `
    <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">Your call with Squideo is today</h2>
    <p style="margin:0 0 8px;">Hi${clientName ? ' ' + escapeHtml(clientName.split(' ')[0]) : ''}, this is a reminder of your call about <strong>${escapeHtml(projectName)}</strong>.</p>
    <p style="margin:0 0 16px;font-size:15px;"><strong>${escapeHtml(whenLabel)}</strong></p>
    ${meetUrl ? `<p style="margin:0 0 16px;"><a href="${escapeHtml(meetUrl)}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Join Google Meet</a></p>` : ''}
    <p style="margin:0;font-size:13px;color:#6B7785;">The joining link is also in your calendar invite. See you soon!</p>`;
  return `<!doctype html><html><body style="margin:0;background:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0F2A3D;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E9EE;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:24px 28px;font-size:14px;line-height:1.55;">${inner}</td></tr>
      </table>
    </td></tr></table></body></html>`;
}

async function cronIntroCallReminders(req, res) {
  // Self-heal the columns so this works before the migration is applied.
  try {
    await sql`ALTER TABLE intro_call_bookings ADD COLUMN IF NOT EXISTS client_timezone TEXT`;
    await sql`ALTER TABLE intro_call_bookings ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ`;
    await sql`ALTER TABLE intro_call_bookings ADD COLUMN IF NOT EXISTS team_task_created_at TIMESTAMPTZ`;
  } catch (err) { console.warn('[cron intro-call-reminders] ensure columns failed', err.message); }

  const force = String(req.query?.force || '') === '1';
  const now = new Date();

  // Candidates: confirmed, still upcoming, within ~36h (covers "today" in any
  // timezone), with at least one of the two day-of jobs outstanding.
  const bookings = await sql`
    SELECT b.id, b.deal_id, b.client_name, b.client_email, b.starts_at, b.meet_url,
           b.organizer_email, b.google_event_id, b.attendee_emails, b.client_timezone,
           b.reminder_sent_at, b.team_task_created_at,
           COALESCE(c.name, d.title, l.client_name, 'your project') AS project_name
      FROM intro_call_bookings b
      LEFT JOIN deals d ON d.id = b.deal_id
      LEFT JOIN companies c ON c.id = d.company_id
      LEFT JOIN intro_call_links l ON l.token = b.link_token
     WHERE b.status = 'confirmed'
       AND b.starts_at > NOW()
       AND b.starts_at < NOW() + INTERVAL '36 hours'
       AND (b.reminder_sent_at IS NULL OR b.team_task_created_at IS NULL)
  `;

  let emailed = 0;
  let tasksCreated = 0;
  for (const b of bookings) {
    const start = new Date(b.starts_at);
    const clientTz = safeTz(b.client_timezone || 'Europe/London');

    // 1) Client reminder — 9am in the client's own timezone, meeting that day.
    if (!b.reminder_sent_at && (force || isNineAmOnMeetingDay(now, start, clientTz))) {
      const whenLabel = start.toLocaleString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
        timeZone: clientTz, timeZoneName: 'short',
      });
      try {
        await sendMail({
          to: b.client_email,
          subject: `Reminder: your call with Squideo today — ${b.project_name}`,
          html: introCallReminderHtml({ clientName: b.client_name, projectName: b.project_name, whenLabel, meetUrl: b.meet_url }),
          text: `Reminder of your call about ${b.project_name} today: ${whenLabel}.${b.meet_url ? ' Join: ' + b.meet_url : ''}`,
        });
        emailed++;
      } catch (err) {
        console.error('[cron intro-call-reminders] email failed', b.id, err.message);
      }
      await sql`UPDATE intro_call_bookings SET reminder_sent_at = NOW() WHERE id = ${b.id}`;
    }

    // 2) Team task — 9am Europe/London on the meeting's London day. Re-read the
    // CURRENT team invited at our side from the live Google event (it may have
    // changed since booking); fall back to the snapshot. Keep only CRM users.
    if (!b.team_task_created_at && (force || isNineAmOnMeetingDay(now, start, 'Europe/London'))) {
      let candidates = Array.isArray(b.attendee_emails) ? b.attendee_emails.map((e) => String(e).toLowerCase()) : [];
      if (b.organizer_email) candidates.push(String(b.organizer_email).toLowerCase());
      try {
        const tok = await getFreshAccessToken(b.organizer_email);
        const live = await getEventAttendees(tok, b.google_event_id);
        if (live) {
          candidates = [...live.attendees];
          if (live.organizerEmail) candidates.push(live.organizerEmail);
        }
      } catch (err) {
        console.warn('[cron intro-call-reminders] live attendees failed, using snapshot', b.id, err.message);
      }
      candidates = Array.from(new Set(candidates.filter(Boolean)));
      let internal = [];
      if (candidates.length) {
        const rows = await sql`SELECT email FROM users WHERE LOWER(email) = ANY(${candidates})`;
        internal = rows.map((r) => String(r.email).toLowerCase());
      }
      if (internal.length) {
        try {
          const taskId = makeId('task');
          const title = `Intro call with ${b.client_name} at ${start.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}`;
          await sql`
            INSERT INTO tasks (id, deal_id, title, due_at, assignee_email, created_by)
            VALUES (${taskId}, ${b.deal_id}, ${title}, ${start.toISOString()}, ${internal[0]}, NULL)
          `;
          await sql`
            INSERT INTO task_assignees (task_id, user_email)
            SELECT ${taskId}, unnest(${internal}::text[]) ON CONFLICT DO NOTHING
          `;
          if (b.deal_id) {
            await sql`
              INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
              VALUES (${b.deal_id}, 'task_created', ${JSON.stringify({ taskId, title, source: 'intro_call_reminder' })}, NULL)
            `;
          }
          tasksCreated++;
        } catch (err) {
          console.error('[cron intro-call-reminders] task create failed', b.id, err.message);
        }
      }
      await sql`UPDATE intro_call_bookings SET team_task_created_at = NOW() WHERE id = ${b.id}`;
    }
  }

  return res.status(200).json({ ok: true, candidates: bookings.length, emailed, tasksCreated });
}
