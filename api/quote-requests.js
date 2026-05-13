import crypto from 'node:crypto';
import { put } from '@vercel/blob';
import sql from './_lib/db.js';
import { sendMail, APP_URL } from './_lib/email.js';

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

const trimOrNull = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

function buildNotificationEmail(qr, files) {
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

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const action = url.searchParams.get('action');

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
    await sendMail({
      to: NOTIFY_TO,
      subject: `New quote request from ${subjectName}`,
      html: buildNotificationEmail(qr, storedFiles),
    });

    return res.status(201).json({ id, ok: true });
  } catch (err) {
    console.error('[quote-requests] error', err);
    return res.status(500).json({ error: 'Request failed' });
  }
}
