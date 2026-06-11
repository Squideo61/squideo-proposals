// Authenticated tracking endpoints used by the browser extension, which
// instruments Gmail-composed mail client-side (it can't run the server send
// path). Two steps:
//   POST /api/crm/tracking/register  { token, links[], subject, recipients[] }
//     — called on 'presending', before Gmail assigns ids.
//   POST /api/crm/tracking/link      { token, gmailThreadId, gmailMessageId }
//     — called on 'sent', once Gmail emits the ids, so the CRM inbox eye can
//       attach to the thread.
import sql from '../db.js';
import { recordTrackedSend, recordSelfView } from './tracking.js';

export async function trackingRoute(req, res, id, action, user) {
  // The extension pings this when the user opens a thread in Gmail, so an open
  // pixel that fires moments later (them reading their own tracked send) isn't
  // counted as the recipient opening it. See openIsInternalSelfView.
  if (id === 'self-view') {
    if (req.method !== 'POST') return res.status(405).end();
    const body = req.body || {};
    if (!body.gmailThreadId) return res.status(400).json({ error: 'gmailThreadId required' });
    await recordSelfView(body.gmailThreadId, user.email);
    return res.status(200).json({ ok: true });
  }

  if (id === 'register') {
    if (req.method !== 'POST') return res.status(405).end();
    const body = req.body || {};
    if (!body.token) return res.status(400).json({ error: 'token required' });
    await recordTrackedSend({
      token: body.token,
      userEmail: user.email,
      messageId: null,
      threadId: null,
      subject: body.subject || null,
      recipients: Array.isArray(body.recipients) ? body.recipients : [],
      links: Array.isArray(body.links) ? body.links : [],
      source: 'extension',
    });
    return res.status(200).json({ ok: true });
  }

  if (id === 'link') {
    if (req.method !== 'POST') return res.status(405).end();
    const body = req.body || {};
    if (!body.token) return res.status(400).json({ error: 'token required' });
    await sql`
      UPDATE email_tracking
         SET gmail_thread_id  = ${body.gmailThreadId || null},
             gmail_message_id = ${body.gmailMessageId || null}
       WHERE token = ${body.token} AND user_email = ${user.email}
    `;
    return res.status(200).json({ ok: true });
  }

  return res.status(404).json({ error: 'Unknown tracking action: ' + id });
}
