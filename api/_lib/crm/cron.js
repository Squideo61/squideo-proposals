import sql from '../db.js';
import { sendMail, APP_URL } from '../email.js';
import { sendNotification, resolveRecipients } from '../notifications.js';
import { registerWatch } from '../gmailTokens.js';
import { syncHistory } from '../gmailSync.js';
import { escapeHtml } from './shared.js';
import { getFreshAccessToken } from './gmail.js';
import { buildResumeEmail } from '../quoteResumeEmail.js';
import { signTaskActionToken } from '../auth.js';

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
  if (auth !== 'Bearer ' + expected) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  switch (action) {
    case 'task-reminders':    return cronTaskReminders(res);
    case 'gmail-watch-renew': return cronGmailWatchRenew(res);
    case 'prune-views':       return cronPruneViews(res);
    case 'quote-partials':    return cronQuotePartials(res);
    case 'quote-resume':      return cronQuoteResume(res);
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

export async function cronTaskReminders(res) {
  // Daily 9am UTC sweep — pick up everything due in the next 24 hours that
  // hasn't been reminded yet. Granularity is intentionally coarse to fit
  // Vercel Hobby's 1-cron-per-day limit; on Pro this can move to */15.
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
      AND t.due_at <= NOW() + INTERVAL '24 hours'
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
      // Stamp once per task — we don't track per-assignee delivery state on
      // purpose; if one address bounces, the team coordinates in-app.
      await sql`UPDATE tasks SET reminded_at = NOW() WHERE id = ${t.id}`;
      sent++;
    }
  }

  return res.status(200).json({ ok: true, found: due.length, sent });
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
