// Public unsubscribe. No auth — the signed token in the link IS the capability,
// and requiring a login to stop marketing email would be both hostile and
// non-compliant.
//
//   GET  /api/email-prefs?action=unsubscribe&t=…   → suppress + confirmation page
//   POST /api/email-prefs?action=unsubscribe&t=…   → RFC 8058 one-click, 204
//   GET  /api/email-prefs?action=resubscribe&t=…   → undo (for a mis-click)
//
// The POST exists because Gmail and Outlook render their own "Unsubscribe"
// button when they see List-Unsubscribe-Post, and call it directly. Honouring
// it is a large deliverability win: people who can unsubscribe in one tap don't
// press "report spam" instead, and spam complaints are what actually damage a
// sending domain.

import { cors } from './_lib/middleware.js';
import { readUnsubscribeToken, suppress, unsuppress } from './_lib/emailSuppression.js';

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function page(res, status, { heading, body, footer = '' }) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(status).end(`<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Email preferences — Squideo</title>
</head>
<body style="margin:0;background:#0F2A3D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:460px;margin:0 auto;padding:64px 20px;">
    <div style="background:#fff;border-radius:16px;padding:28px;box-shadow:0 18px 50px rgba(0,0,0,0.28);">
      <h1 style="margin:0 0 10px;font-size:20px;color:#0F2A3D;">${heading}</h1>
      <div style="font-size:14px;line-height:1.6;color:#6B7785;">${body}</div>
      ${footer}
    </div>
    <div style="text-align:center;margin-top:20px;font-size:12.5px;color:#7E97A8;">
      Squideo Ltd · <a href="mailto:enquiries@squideo.co.uk" style="color:#9FDFF5;">enquiries@squideo.co.uk</a> · 01482 738 656
    </div>
  </div>
</body></html>`);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = String(req.query.action || 'unsubscribe');
  const token = req.query.t ? String(req.query.t) : '';
  const parsed = readUnsubscribeToken(token);

  try {
    // A one-click POST gets a status code and nothing else — the mail client is
    // reading it, not a person. Still 204 on a bad token: the sender is Gmail,
    // and there is nothing useful it could do with an error.
    if (req.method === 'POST') {
      if (parsed) {
        await suppress({
          email: parsed.email, scope: 'marketing',
          reason: 'unsubscribe', source: parsed.list || 'one-click',
        });
      }
      return res.status(204).end();
    }

    if (req.method !== 'GET') return res.status(405).end();

    if (!parsed) {
      return page(res, 400, {
        heading: "That link didn't work",
        body: `We couldn't read that unsubscribe link — it may have been broken by your email
               client. Email <a href="mailto:enquiries@squideo.co.uk" style="color:#2BB8E6;">enquiries@squideo.co.uk</a>
               and we'll take you off the list by hand, straight away.`,
      });
    }

    if (action === 'resubscribe') {
      await unsuppress(parsed.email);
      return page(res, 200, {
        heading: "You're back on the list",
        body: `<strong>${esc(parsed.email)}</strong> will receive Squideo emails again.`,
      });
    }

    const ok = await suppress({
      email: parsed.email, scope: 'marketing',
      reason: 'unsubscribe', source: parsed.list || 'email',
    });
    if (!ok) {
      return page(res, 500, {
        heading: 'Something went wrong',
        body: `We couldn't record that just now. Email
               <a href="mailto:enquiries@squideo.co.uk" style="color:#2BB8E6;">enquiries@squideo.co.uk</a>
               and we'll do it by hand.`,
      });
    }

    // The resubscribe link matters: one-click unsubscribe is easy to hit by
    // accident, especially on a phone, and having no way back is a bad
    // experience for someone who actually wanted the emails.
    const undo = `/api/email-prefs?action=resubscribe&t=${encodeURIComponent(token)}`;
    return page(res, 200, {
      heading: "You're unsubscribed",
      body: `We won't send <strong>${esc(parsed.email)}</strong> any more marketing email.
             <br /><br />
             You'll still get anything to do with work we're actually doing for you —
             project updates, video reviews, invoices, and emails from the team
             written by an actual person. Those aren't marketing, and turning them
             off would break your projects.`,
      footer: `<div style="margin-top:18px;font-size:13px;">
                 <a href="${esc(undo)}" style="color:#2BB8E6;">Unsubscribed by mistake? Undo it</a>
               </div>`,
    });
  } catch (err) {
    console.error('[email-prefs] unhandled', err);
    if (req.method === 'POST') return res.status(204).end();
    return page(res, 500, {
      heading: 'Something went wrong',
      body: `Email <a href="mailto:enquiries@squideo.co.uk" style="color:#2BB8E6;">enquiries@squideo.co.uk</a> and we'll sort it.`,
    });
  }
}
