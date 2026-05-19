import crypto from 'node:crypto';
import { put } from '@vercel/blob';
import sql from './_lib/db.js';
import { sendMail, APP_URL } from './_lib/email.js';
import { resolveRecipients } from './_lib/notifications.js';
import { buildResumeEmail } from './_lib/quoteResumeEmail.js';
import { signQuoteRequestActionToken, verifyQuoteRequestActionToken } from './_lib/auth.js';
import { qualifyQuoteRequest, disqualifyQuoteRequest } from './_lib/quoteRequestActions.js';
import { getRoleForUser } from './_lib/userRoles.js';
import { hasPermission } from './_lib/permissions.js';

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const NOTIFY_TO = process.env.QUOTE_REQUEST_NOTIFY_TO || 'adam@squideo.co.uk';

export const config = {
  api: { bodyParser: false },
};

async function readRawBody(req) {
  if (Buffer.isBuffer(req.body) && req.body.length > 0) return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const buf = await readRawBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { return {}; }
}

const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

function renderActionPage({ title, body, broadcast = null }) {
  const safeTitle = escapeHtml(title);
  // When the action succeeded, broadcast to any open Squideo tab in the same
  // browser so the CRM updates instantly without waiting for the next 60s
  // poll. BroadcastChannel reaches every tab on the same origin (this page is
  // served from APP_URL, same as the SPA). Storage events are a fallback for
  // older browsers — they fire in tabs OTHER than this one, which is exactly
  // what we need. JSON.stringify is safe to inline because the only dynamic
  // fields are server-controlled enum values (id, action).
  const broadcastScript = broadcast
    ? `<script>(function(){try{
        var m=${JSON.stringify({ type: 'squideo:quote-request-actioned', ...broadcast })};
        if(typeof BroadcastChannel!=='undefined'){var bc=new BroadcastChannel('squideo');bc.postMessage(m);bc.close();}
        try{localStorage.setItem('squideo:event',JSON.stringify({...m,ts:Date.now()}));}catch(e){}
      }catch(e){}})();</script>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${safeTitle} · Squideo</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:48px 16px;background:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0F2A3D;}
.card{max-width:480px;margin:0 auto;background:#fff;border:1px solid #E5E9EE;border-radius:12px;padding:32px;text-align:center;}
h1{margin:0 0 12px;font-size:22px;}p{margin:0 0 20px;color:#3B4A57;line-height:1.5;}
a.btn{display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;}</style>
</head><body><div class="card">
<h1>${safeTitle}</h1>
<p>${body}</p>
<p><a class="btn" href="${escapeHtml(APP_URL)}">Open Squideo</a></p>
</div>${broadcastScript}</body></html>`;
}

const trimOrNull = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

function buildNotificationEmail(qr, files, { qualifyUrl, disqualifyUrl, crmUrl } = {}) {
  const rows = [
    ['Name', qr.name],
    ['Email', qr.email],
    ['Phone', qr.phone ? `${qr.country_code || ''} ${qr.phone}`.trim() : null],
    ['Company', qr.company],
    ['Timeline', qr.timeline],
    ['Budget', qr.budget],
    ['Country', qr.country_name],
    ['Opted in to marketing', qr.opt_in ? 'Yes' : 'No'],
    ['Source', qr.source_url],
  ].filter(([, v]) => v != null && v !== '');

  const rowHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 14px 6px 0;color:#6B7785;font-size:13px;vertical-align:top;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:6px 0;font-size:13px;">${escapeHtml(v)}</td></tr>`
    )
    .join('');

  const details = qr.project_details
    ? `<h3 style="margin:18px 0 8px;font-size:14px;font-weight:700;">Project details</h3>
       <div style="white-space:pre-wrap;font-size:13px;line-height:1.55;background:#FAFBFC;border:1px solid #E5E9EE;border-radius:8px;padding:12px 14px;">${escapeHtml(qr.project_details)}</div>`
    : '';

  const filesHtml = files.length
    ? `<h3 style="margin:18px 0 8px;font-size:14px;font-weight:700;">Attachments (${files.length})</h3>
       <ul style="margin:0;padding:0 0 0 18px;font-size:13px;line-height:1.6;">
         ${files
           .map(
             (f) =>
               `<li><a href="${escapeHtml(f.blob_url)}" style="color:#2BB8E6;">${escapeHtml(f.filename)}</a> <span style="color:#6B7785;">(${Math.round((f.size_bytes || 0) / 1024)} KB)</span></li>`
           )
           .join('')}
       </ul>`
    : '';

  const buttons = [];
  if (qualifyUrl) {
    buttons.push(`<a href="${escapeHtml(qualifyUrl)}" style="display:inline-block;background:#16A34A;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;margin:0 8px 8px 0;">Qualify — create deal</a>`);
  }
  if (disqualifyUrl) {
    buttons.push(`<a href="${escapeHtml(disqualifyUrl)}" style="display:inline-block;background:#DC2626;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;margin:0 8px 8px 0;">Disqualify — delete</a>`);
  }
  if (crmUrl) {
    buttons.push(`<a href="${escapeHtml(crmUrl)}" style="display:inline-block;background:#F1F4F7;color:#0F2A3D;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;margin:0 8px 8px 0;border:1px solid #E5E9EE;">Open in CRM</a>`);
  }
  const footnote = disqualifyUrl
    ? 'One-click links expire in 14 days. Disqualifying deletes the request and any attachments.'
    : 'One-click links expire in 14 days.';
  const ctaHtml = buttons.length
    ? `<div style="margin:22px 0 4px;">${buttons.join('')}</div>
       <p style="margin:6px 0 0;font-size:12px;color:#6B7785;">${footnote}</p>`
    : '';

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0F2A3D;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFBFC;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border:1px solid #E5E9EE;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:24px 28px;border-bottom:1px solid #E5E9EE;">
          <div style="font-size:18px;font-weight:700;color:#0F2A3D;">New quote request</div>
        </td></tr>
        <tr><td style="padding:24px 28px;font-size:14px;line-height:1.55;color:#0F2A3D;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
            ${rowHtml}
          </table>
          ${details}
          ${filesHtml}
          ${ctaHtml}
          <p style="margin:20px 0 0;font-size:12px;color:#6B7785;">Submitted ${escapeHtml(new Date(qr.created_at).toLocaleString('en-GB'))}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return html;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');
      return res.status(204).end();
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const action = url.searchParams.get('action');

    if (action === 'action-link' && req.method === 'GET') {
      const token = url.searchParams.get('token');
      const qrId = url.searchParams.get('id');
      const act = url.searchParams.get('act');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (!token || !qrId || !act) {
        return res.status(400).send(renderActionPage({ title: 'Bad request', body: 'Missing parameters.' }));
      }
      let payload;
      try {
        payload = await verifyQuoteRequestActionToken(token);
      } catch {
        return res.status(401).send(renderActionPage({
          title: 'Link expired',
          body: 'This one-click link is no longer valid. Open the CRM to action this request.',
        }));
      }
      if (payload.qrId !== qrId || payload.act !== act) {
        return res.status(400).send(renderActionPage({ title: 'Bad request', body: 'Token does not match this request.' }));
      }

      const actorEmail = (payload.email || '').toLowerCase() || null;

      if (act === 'qualify') {
        const result = await qualifyQuoteRequest(qrId, { actorEmail: actorEmail || NOTIFY_TO || null });
        if (result.status === 'not_found') {
          return res.status(404).send(renderActionPage({ title: 'Not found', body: 'This quote request no longer exists — it may have been deleted.' }));
        }
        if (result.status === 'already_qualified') {
          return res.status(200).send(renderActionPage({ title: 'Already qualified', body: 'A deal was already created for this request. Open the CRM to find it.' }));
        }
        return res.status(200).send(renderActionPage({
          title: 'Qualified',
          body: 'A new deal has been created in the <strong>Lead</strong> stage. Open the CRM to assign an owner and continue.',
          broadcast: { id: qrId, action: 'qualify', dealId: result.dealId || null },
        }));
      }

      if (act === 'disqualify') {
        // Re-check admin at click time — a stale token from a now-non-admin
        // (or a link forwarded to a non-admin) must not delete the request.
        const role = actorEmail ? await getRoleForUser(actorEmail) : null;
        if (!hasPermission(role, 'users.manage')) {
          return res.status(403).send(renderActionPage({
            title: 'Not allowed',
            body: 'Only workspace admins can disqualify quote requests. Open the CRM and ask an admin to action it.',
          }));
        }
        const result = await disqualifyQuoteRequest(qrId);
        if (result.status === 'not_found') {
          return res.status(200).send(renderActionPage({ title: 'Already gone', body: 'This quote request was already removed.' }));
        }
        if (result.status === 'already_qualified') {
          return res.status(409).send(renderActionPage({ title: 'Already qualified', body: 'A deal has already been created from this request — disqualifying would lose work. Open the CRM to manage the deal.' }));
        }
        return res.status(200).send(renderActionPage({
          title: 'Disqualified',
          body: 'The quote request and any attachments have been deleted.',
          broadcast: { id: qrId, action: 'disqualify' },
        }));
      }

      return res.status(400).send(renderActionPage({ title: 'Bad request', body: 'Unknown action.' }));
    }

    if (action === 'unsubscribe' && req.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!token) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(400).send('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;max-width:560px;margin:0 auto;"><h2>Invalid link</h2><p>This unsubscribe link is missing a token.</p></body>');
      }
      const rows = await sql`
        SELECT form_session_id FROM quote_request_resume_emails
        WHERE unsubscribe_token = ${token}
        LIMIT 1
      `;
      if (rows.length) {
        await sql`
          UPDATE quote_request_resume_emails
          SET unsubscribed_at = NOW()
          WHERE form_session_id = ${rows[0].form_session_id} AND unsubscribed_at IS NULL
        `;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;max-width:560px;margin:0 auto;line-height:1.5;"><h2>You\'re unsubscribed</h2><p>We won\'t send any more reminders about your unfinished quote request. You can still come back to finish it any time using the link from your previous email.</p><p style="color:#6B7785;font-size:13px;">— Squideo</p></body>');
    }

    // Remaining actions (and the default form submit) are POST-only.
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'save-and-email') {
      const body = await readJsonBody(req);
      const formSessionId = trimOrNull(body.formSessionId);
      const email = trimOrNull(body.email);
      const name = trimOrNull(body.name);
      if (!formSessionId || !email) {
        console.warn('[save-and-email] missing fields', { hasSession: !!formSessionId, hasEmail: !!email, bodyKeys: Object.keys(body || {}) });
        return res.status(400).json({ error: 'Form session and email required' });
      }
      // basic email shape check
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        console.warn('[save-and-email] invalid email shape', { email });
        return res.status(400).json({ error: 'Invalid email' });
      }

      const resumeOrigin = trimOrNull(body.origin) || APP_URL;
      const resumeUrl = `${resumeOrigin.replace(/\/$/, '')}/quote?resume=${encodeURIComponent(formSessionId)}`;
      const unsubscribeToken = crypto.randomBytes(24).toString('hex');
      const unsubscribeUrl = `${APP_URL.replace(/\/$/, '')}/api/quote-requests?action=unsubscribe&token=${unsubscribeToken}`;

      // Clear any existing pending reminders for this session (e.g. they clicked save twice)
      await sql`
        DELETE FROM quote_request_resume_emails
        WHERE form_session_id = ${formSessionId} AND sent_at IS NULL
      `;

      const schedule = [
        { kind: 'initial', offsetMs: 0 },
        { kind: 'reminder_1', offsetMs: 24 * 60 * 60 * 1000 },
        { kind: 'reminder_2', offsetMs: 4 * 24 * 60 * 60 * 1000 },
        { kind: 'reminder_3', offsetMs: 11 * 24 * 60 * 60 * 1000 },
      ];
      const now = Date.now();
      for (const s of schedule) {
        await sql`
          INSERT INTO quote_request_resume_emails (
            id, form_session_id, email, name, resume_url, kind,
            unsubscribe_token, scheduled_for
          ) VALUES (
            ${crypto.randomUUID()}, ${formSessionId}, ${email}, ${name},
            ${resumeUrl}, ${s.kind}, ${unsubscribeToken}, ${new Date(now + s.offsetMs)}
          )
        `;
      }

      try {
        const { subject, html } = buildResumeEmail({ kind: 'initial', name, resumeUrl, unsubscribeUrl });
        await sendMail({ to: email, subject, html });
        await sql`
          UPDATE quote_request_resume_emails
          SET sent_at = NOW()
          WHERE form_session_id = ${formSessionId} AND kind = 'initial'
        `;
      } catch (err) {
        console.error('[quote-requests save-and-email] initial send failed', err);
        return res.status(500).json({ error: 'Could not send email — please try again' });
      }

      return res.status(200).json({ ok: true });
    }

    if (action === 'autosave') {
      const body = await readJsonBody(req);
      const formSessionId = trimOrNull(body.formSessionId);
      const projectDetails = trimOrNull(body.projectDetails);
      if (!formSessionId || !projectDetails) {
        return res.status(204).end();
      }
      const sourceUrl = trimOrNull(body.sourceUrl);
      const userAgent = trimOrNull(req.headers['user-agent']);
      const ip = trimOrNull(
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
          req.socket?.remoteAddress
      );
      const lastStep = Number.isFinite(Number(body.lastStep)) ? Math.max(1, Math.min(4, Math.floor(Number(body.lastStep)))) : null;
      await sql`
        INSERT INTO quote_request_partials (
          form_session_id, name, email, phone, country_code, country_name,
          company, project_details, timeline, budget, source_url, user_agent,
          ip_address, last_step, last_activity_at
        ) VALUES (
          ${formSessionId}, ${trimOrNull(body.name)}, ${trimOrNull(body.email)},
          ${trimOrNull(body.phone)}, ${trimOrNull(body.countryCode)}, ${trimOrNull(body.countryName)},
          ${trimOrNull(body.company)}, ${projectDetails}, ${trimOrNull(body.timeline)},
          ${trimOrNull(body.budget)}, ${sourceUrl}, ${userAgent}, ${ip}, ${lastStep}, NOW()
        )
        ON CONFLICT (form_session_id) DO UPDATE SET
          name = EXCLUDED.name,
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          country_code = EXCLUDED.country_code,
          country_name = EXCLUDED.country_name,
          company = EXCLUDED.company,
          project_details = EXCLUDED.project_details,
          timeline = EXCLUDED.timeline,
          budget = EXCLUDED.budget,
          source_url = COALESCE(quote_request_partials.source_url, EXCLUDED.source_url),
          user_agent = COALESCE(quote_request_partials.user_agent, EXCLUDED.user_agent),
          ip_address = COALESCE(quote_request_partials.ip_address, EXCLUDED.ip_address),
          last_step = EXCLUDED.last_step,
          last_activity_at = NOW()
        WHERE quote_request_partials.completed_at IS NULL
      `;
      return res.status(204).end();
    }

    if (action === 'upload') {
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return res.status(503).json({ error: 'File storage not configured' });
      }
      const filename = decodeURIComponent(req.headers['x-filename'] || 'upload');
      const mimeType = req.headers['content-type'] || 'application/octet-stream';
      const fileBuffer = await readRawBody(req);
      if (!fileBuffer.length) return res.status(400).json({ error: 'No file data received' });
      if (fileBuffer.length > MAX_FILE_SIZE) {
        return res.status(413).json({ error: 'File too large (max 20 MB)' });
      }
      const fileId = crypto.randomUUID();
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = await put(`quote-requests/${fileId}/${safeName}`, fileBuffer, {
        access: 'public',
        contentType: mimeType,
      });
      return res.status(201).json({
        id: fileId,
        filename,
        mimeType,
        sizeBytes: fileBuffer.length,
        blobUrl: blob.url,
        blobPathname: blob.pathname,
      });
    }

    // Default action: submit form
    const body = await readJsonBody(req);

    const name = trimOrNull(body.name);
    const email = trimOrNull(body.email);
    if (!name && !email) {
      return res.status(400).json({ error: 'Name or email is required' });
    }

    const id = crypto.randomUUID();
    const createdAt = new Date();
    const files = Array.isArray(body.files) ? body.files.slice(0, 5) : [];
    const sourceUrl = trimOrNull(body.sourceUrl);
    const userAgent = trimOrNull(req.headers['user-agent']);
    const ip = trimOrNull(
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket?.remoteAddress
    );

    const qr = {
      id,
      form_session_id: trimOrNull(body.formSessionId),
      name,
      email,
      phone: trimOrNull(body.phone),
      country_code: trimOrNull(body.countryCode),
      country_name: trimOrNull(body.countryName),
      company: trimOrNull(body.company),
      project_details: trimOrNull(body.projectDetails),
      timeline: trimOrNull(body.timeline),
      budget: trimOrNull(body.budget),
      opt_in: !!body.optIn,
      source_url: sourceUrl,
      user_agent: userAgent,
      ip_address: ip,
      created_at: createdAt,
    };

    await sql`
      INSERT INTO quote_requests (
        id, form_session_id, name, email, phone, country_code, country_name,
        company, project_details, timeline, budget, opt_in,
        source_url, user_agent, ip_address, created_at
      ) VALUES (
        ${qr.id}, ${qr.form_session_id}, ${qr.name}, ${qr.email}, ${qr.phone},
        ${qr.country_code}, ${qr.country_name}, ${qr.company}, ${qr.project_details},
        ${qr.timeline}, ${qr.budget}, ${qr.opt_in}, ${qr.source_url},
        ${qr.user_agent}, ${qr.ip_address}, ${qr.created_at}
      )
    `;

    const storedFiles = [];
    for (const f of files) {
      if (!f || !f.blobUrl || !f.filename) continue;
      const fileRecordId = crypto.randomUUID();
      const filename = String(f.filename).slice(0, 255);
      const mimeType = f.mimeType ? String(f.mimeType).slice(0, 100) : null;
      const sizeBytes = Number.isFinite(f.sizeBytes) ? Math.floor(f.sizeBytes) : null;
      const blobUrl = String(f.blobUrl);
      const blobPathname = f.blobPathname ? String(f.blobPathname) : null;
      await sql`
        INSERT INTO quote_request_files (id, quote_request_id, filename, mime_type, size_bytes, blob_url, blob_pathname)
        VALUES (${fileRecordId}, ${id}, ${filename}, ${mimeType}, ${sizeBytes}, ${blobUrl}, ${blobPathname})
      `;
      storedFiles.push({ filename, mime_type: mimeType, size_bytes: sizeBytes, blob_url: blobUrl });
    }

    const subjectName = qr.name || qr.email || 'Anonymous';
    const apiBase = APP_URL.replace(/\/$/, '');
    // SPA has no deep-link route for a specific quote request — the list view
    // navigates internally, so we just send recipients to the app root.
    const crmUrl = apiBase;

    // Resolve recipients ourselves so we can per-recipient: sign tokens bound
    // to each recipient's email, and gate the Disqualify button by admin
    // permission. Non-admins still get Qualify (creating a deal is sensible
    // for any teammate); only admins see Disqualify (which deletes data).
    const subscribed = await resolveRecipients('quote_request.new', {});
    const extras = NOTIFY_TO ? [NOTIFY_TO.toLowerCase()] : [];
    const recipients = Array.from(new Set([...subscribed, ...extras]));
    const subject = `New quote request from ${subjectName}`;

    await Promise.allSettled(recipients.map(async (to) => {
      const role = await getRoleForUser(to);
      const isAdmin = hasPermission(role, 'users.manage');

      const qualifyToken = await signQuoteRequestActionToken({
        quoteRequestId: qr.id, action: 'qualify', email: to,
      });
      const qualifyUrl = `${apiBase}/api/quote-requests?action=action-link&id=${encodeURIComponent(qr.id)}&act=qualify&token=${encodeURIComponent(qualifyToken)}`;

      let disqualifyUrl = null;
      if (isAdmin) {
        const disqualifyToken = await signQuoteRequestActionToken({
          quoteRequestId: qr.id, action: 'disqualify', email: to,
        });
        disqualifyUrl = `${apiBase}/api/quote-requests?action=action-link&id=${encodeURIComponent(qr.id)}&act=disqualify&token=${encodeURIComponent(disqualifyToken)}`;
      }

      await sendMail({
        to,
        subject,
        html: buildNotificationEmail(qr, storedFiles, { qualifyUrl, disqualifyUrl, crmUrl }),
      });
    }));

    try {
      if (qr.form_session_id) {
        await sql`
          UPDATE quote_request_partials
          SET completed_at = NOW()
          WHERE form_session_id = ${qr.form_session_id}
        `;
        await sql`
          DELETE FROM quote_request_resume_emails
          WHERE form_session_id = ${qr.form_session_id} AND sent_at IS NULL
        `;
      }
      // Also stop reminders / partial-alerts for any other abandoned sessions
      // from the same person (matched by email — covers the case where they
      // restarted in a new tab/browser and finished there).
      if (qr.email) {
        await sql`
          UPDATE quote_request_partials
          SET completed_at = NOW()
          WHERE LOWER(email) = LOWER(${qr.email}) AND completed_at IS NULL
        `;
        await sql`
          DELETE FROM quote_request_resume_emails
          WHERE LOWER(email) = LOWER(${qr.email}) AND sent_at IS NULL
        `;
      }
    } catch (e) {
      console.warn('[quote-requests] partial/resume cleanup failed', e?.message);
    }

    return res.status(201).json({ id, ok: true });
  } catch (err) {
    console.error('[quote-requests] error', err);
    return res.status(500).json({ error: 'Request failed' });
  }
}
