// Resend webhook receiver — bounces and spam complaints.
//
// WHY THIS MATTERS MORE THAN IT LOOKS
// Every mailbox provider judges a sender on two numbers: how much of what they
// send bounces, and how often people press "spam". Both have to stay tiny
// (Google's published threshold for complaints is 0.3%). Without this endpoint
// neither number is ever recorded here — a dead address stays on the list and
// gets posted to again on every future campaign, and somebody who pressed spam
// keeps receiving. That's how a domain's reputation goes, and once it's gone it
// takes invoices and password resets down with it.
//
// So a hard bounce or a complaint suppresses the address GLOBALLY (see
// emailSuppression.js — suppression only ever blocks marketing, never a
// transactional email), and marks the campaign recipient so the report shows
// what happened.
//
// Setup (one-off, in the Resend dashboard → Webhooks):
//   • Endpoint: https://app.squideo.com/api/resend-webhook
//   • Events:   email.bounced, email.complained, email.delivery_delayed
//   • Copy the signing secret into RESEND_WEBHOOK_SECRET.
//
// Security: Resend signs with Svix headers — svix-id, svix-timestamp and
// svix-signature, where the signature is base64 HMAC-SHA256 over
// `${id}.${timestamp}.${body}` keyed on the secret's base64 body (the part
// after "whsec_"). Verified over the raw bytes.

import crypto from 'crypto';
import sql from './_lib/db.js';
import { suppress } from './_lib/emailSuppression.js';

export const config = { api: { bodyParser: false } };

// Replay window. A signature stays valid for five minutes, which is Svix's own
// tolerance — long enough for a retry, short enough that a captured request
// can't be replayed later.
const TOLERANCE_MS = 5 * 60 * 1000;

function verify({ secret, id, timestamp, signatureHeader, rawBody }) {
  if (!secret || !id || !timestamp || !signatureHeader) return false;

  const ts = Number(timestamp) * 1000;
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > TOLERANCE_MS) return false;

  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody.toString('utf8')}`)
    .digest('base64');

  // The header carries one or more space-separated "v1,<sig>" pairs — Svix
  // sends several while a secret is being rotated, and any one matching is a
  // valid request.
  return String(signatureHeader).split(' ').some((part) => {
    const sig = part.includes(',') ? part.split(',')[1] : part;
    const a = Buffer.from(sig || '');
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

// Resend's bounce payloads carry a type/subType. A HARD bounce means the
// address does not exist — never write to it again. A SOFT one (full mailbox,
// a server having a bad afternoon) is temporary and must not cost someone their
// place on the list, so it's recorded and nothing more.
// The vocabulary here is SES's, which is what Resend passes through:
// "Permanent" and "Transient", NOT "hard" and "soft". Matching only on the
// friendly words would classify every real hard bounce as soft and quietly
// suppress nothing, which is the whole endpoint failing silently. Both
// vocabularies are accepted so a future change of wording can't break it again.
function classifyBounce(data) {
  const type = String(data?.bounce?.type || data?.type || '').toLowerCase();
  const sub = String(data?.bounce?.subType || data?.bounce?.sub_type || '').toLowerCase();

  if (type.includes('permanent') || type.includes('hard')) return 'hard';
  // A "suppressed" or non-existent recipient is permanent whatever the type
  // says — the address is gone.
  if (/suppress|nonexistent|no[-_ ]?email|invalid/.test(sub)) return 'hard';
  if (type.includes('transient') || type.includes('soft') || type.includes('undetermined')) return 'soft';

  // Unknown shapes are treated as soft. Wrongly suppressing a real customer is
  // far more expensive than one extra bounce.
  return 'soft';
}

const recipientsOf = (data) => (Array.isArray(data?.to) ? data.to : [data?.to])
  .map((e) => String(e || '').trim().toLowerCase())
  .filter((e) => e.includes('@'));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[resend webhook] RESEND_WEBHOOK_SECRET not set — refusing');
    return res.status(500).end();
  }
  const ok = verify({
    secret,
    id: req.headers['svix-id'],
    timestamp: req.headers['svix-timestamp'],
    signatureHeader: req.headers['svix-signature'],
    rawBody,
  });
  if (!ok) return res.status(401).end();

  let payload = {};
  try { payload = JSON.parse(rawBody.toString('utf8') || '{}'); } catch { payload = {}; }
  const type = String(payload.type || '');
  const data = payload.data || {};
  const emails = recipientsOf(data);
  const providerId = data.email_id || data.id || null;

  // Answer immediately whatever happens next: a webhook that times out gets
  // retried, and a retried bounce must not be able to pile up.
  const finish = (body) => res.status(200).json(body);

  try {
    if (type === 'email.bounced') {
      const kind = classifyBounce(data);
      for (const email of emails) {
        await markRecipient({ providerId, email, kind });
        if (kind === 'hard') {
          // scope:'all' — "don't put this address in a campaign". It still
          // cannot block an invoice or a password reset.
          await suppress({ email, scope: 'all', reason: 'hard_bounce', source: 'resend' });
        }
      }
      return finish({ ok: true, handled: 'bounce', kind, count: emails.length });
    }

    if (type === 'email.complained') {
      for (const email of emails) {
        await markRecipient({ providerId, email, kind: 'complaint' });
        // A complaint is the strongest possible "stop". Global, immediately.
        await suppress({ email, scope: 'all', reason: 'complaint', source: 'resend' });
      }
      return finish({ ok: true, handled: 'complaint', count: emails.length });
    }

    // Delivery delays and everything else are acknowledged and ignored — a 200
    // stops Resend retrying an event we have no use for.
    return finish({ ok: true, ignored: type || 'unknown' });
  } catch (err) {
    console.error('[resend webhook] failed', { type, err: err.message });
    // Still 200: the suppression is best-effort and a retry storm helps nobody.
    return finish({ ok: false });
  }
}

// Mark the campaign recipient so the report can show it. Matched on the
// provider's message id where we have it (exact), falling back to the most
// recent send to that address (a bounce arrives minutes after the send, so the
// latest is the right one).
async function markRecipient({ providerId, email, kind }) {
  try {
    if (providerId) {
      const hit = await sql`
        UPDATE email_campaign_recipients
           SET bounced_at = NOW(), bounce_kind = ${kind},
               status = ${kind === 'hard' ? 'bounced' : 'sent'}
         WHERE provider_id = ${providerId}
        RETURNING id`;
      if (hit.length) return;
    }
    await sql`
      UPDATE email_campaign_recipients
         SET bounced_at = NOW(), bounce_kind = ${kind},
             status = ${kind === 'hard' ? 'bounced' : 'sent'}
       WHERE id = (
         SELECT id FROM email_campaign_recipients
          WHERE email = ${email} AND sent_at IS NOT NULL
          ORDER BY sent_at DESC LIMIT 1
       )`;
  } catch (err) {
    console.warn('[resend webhook] could not mark recipient', err.message);
  }
}
