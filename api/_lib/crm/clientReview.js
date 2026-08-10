// "Submit to client for review" — the single gate that makes an uploaded
// storyboard/video draft visible to the client and notifies them.
//
// Uploading a draft (api/revisions|storyboards/[action].js registerVersion) is
// now purely internal. Only this helper bumps client_submitted_version — the
// highest version_number the client is allowed to see in the portal + share
// link viewer — clears any prior approval/feedback so the review reopens, and
// fires the client-facing portal notification. Shared by the revision/storyboard
// routers (staff, by revision_video_id/storyboard_id) and the CRM production
// router (by project_videos id) so there is one source of truth.

import sql from '../db.js';
import { notifyPortalUser } from '../portal/notifications.js';
import { sendMail, APP_URL } from '../email.js';
import { performGmailSend } from './gmail.js';

// The anonymous client review links (same format the "Copy link" buttons use).
export const reviewUrlFor = (kind, shareToken) => (shareToken
  ? `${APP_URL}/?${kind === 'storyboard' ? 'storyboard' : 'revision'}=${shareToken}`
  : null);

async function logDealEvent(dealId, eventType, payload, actorEmail) {
  if (!dealId) return;
  try {
    await sql`
      INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
      VALUES (${dealId}, ${eventType}, ${JSON.stringify(payload || {})}, ${actorEmail || null})`;
  } catch (err) {
    console.warn('[clientReview] deal event log failed', err.message);
  }
}

// Submit the latest uploaded video draft to the client. Returns
// { clientSubmittedVersion, clientSubmittedAt, shareToken } or { error }.
// Pass `email` (see sendReviewEmail) to send the covering email in the same
// call — the gate runs FIRST so no email ever goes out carrying a link the
// client can't open yet.
export async function submitRevisionToClient({ revisionVideoId, actorEmail, email = null, actor = null }) {
  // Resolve the deal via EITHER link direction: revision_projects.deal_id OR
  // deals.revision_project_id (projects created from the video page historically
  // only set the latter). Without the deal we can't notify the client's company.
  const [row] = await sql`
    SELECT rv.title, rv.project_id, COALESCE(rp.deal_id, d.id) AS deal_id, rp.share_token, d.company_id,
           (SELECT MAX(version_number) FROM revision_versions WHERE video_id = rv.id) AS max_ver
      FROM revision_videos rv
      JOIN revision_projects rp ON rp.id = rv.project_id
      LEFT JOIN deals d ON (d.id = rp.deal_id OR d.revision_project_id = rp.id)
     WHERE rv.id = ${revisionVideoId}`;
  if (!row) return { error: 'not-found' };
  if (row.max_ver == null) return { error: 'no-draft' };
  // Backfill the reverse link so future portal reads resolve it directly.
  if (row.deal_id) await sql`UPDATE revision_projects SET deal_id = ${row.deal_id} WHERE id = ${row.project_id} AND deal_id IS NULL`.catch(() => {});

  const submittedAt = new Date();
  // emailOnly = the gate already ran and only the covering email failed
  // (see ReviewEmailComposer's retry). Re-running it would notify the client
  // a second time for one send.
  if (!email?.emailOnly) {
    await sql`
      UPDATE revision_videos
         SET client_submitted_version = ${row.max_ver},
             client_submitted_at = NOW(),
             client_submitted_by = ${actorEmail || null},
             approved_at = NULL, approved_by = NULL, feedback_submitted_at = NULL
       WHERE id = ${revisionVideoId}`;
    await sql`UPDATE revision_projects SET updated_at = NOW() WHERE id = ${row.project_id}`;

    await notifyPortalUser({
      companyId: row.company_id,
      dealId: row.deal_id,
      key: 'portal.revision_ready',
      title: 'Your video is ready to review',
      body: `A new version of "${row.title}" is ready for your feedback.`,
      link: `#/review/${row.share_token}`,
    });
    await logDealEvent(row.deal_id, 'revision_submitted_to_client',
      { video: row.title, version: row.max_ver }, actorEmail);
  }

  const mail = await sendReviewEmail({
    email, actor: actor || { email: actorEmail }, dealId: row.deal_id,
    kind: 'video', itemTitle: row.title, version: row.max_ver,
  });

  return {
    clientSubmittedVersion: row.max_ver,
    clientSubmittedAt: submittedAt.toISOString(),
    shareToken: row.share_token,
    ...mail,
  };
}

// Submit the latest uploaded storyboard PDF draft to the client.
export async function submitStoryboardToClient({ storyboardId, actorEmail, email = null, actor = null }) {
  const [row] = await sql`
    SELECT sb.title, sb.project_id, COALESCE(sp.deal_id, d.id) AS deal_id, sp.share_token, d.company_id,
           (SELECT MAX(version_number) FROM storyboard_versions WHERE storyboard_id = sb.id) AS max_ver
      FROM storyboards sb
      JOIN storyboard_projects sp ON sp.id = sb.project_id
      LEFT JOIN deals d ON (d.id = sp.deal_id OR d.storyboard_project_id = sp.id)
     WHERE sb.id = ${storyboardId}`;
  if (!row) return { error: 'not-found' };
  if (row.max_ver == null) return { error: 'no-draft' };
  if (row.deal_id) await sql`UPDATE storyboard_projects SET deal_id = ${row.deal_id} WHERE id = ${row.project_id} AND deal_id IS NULL`.catch(() => {});

  const submittedAt = new Date();
  if (!email?.emailOnly) { // see submitRevisionToClient
    // A previous approval is left standing: storyboard approvals are per-draft
    // (storyboards.approved_version), so the draft they signed off stays locked
    // while this new one opens for comments. See isDraftLocked in the router.
    await sql`
      UPDATE storyboards
         SET client_submitted_version = ${row.max_ver},
             client_submitted_at = NOW(),
             client_submitted_by = ${actorEmail || null},
             feedback_submitted_at = NULL
       WHERE id = ${storyboardId}`;
    await sql`UPDATE storyboard_projects SET updated_at = NOW() WHERE id = ${row.project_id}`;

    await notifyPortalUser({
      companyId: row.company_id,
      dealId: row.deal_id,
      key: 'portal.storyboard_ready',
      title: 'Your storyboard is ready to review',
      body: `A new version of "${row.title}" is ready for your feedback.`,
      link: `#/storyboard/${row.share_token}`,
    });
    await logDealEvent(row.deal_id, 'storyboard_submitted_to_client',
      { storyboard: row.title, version: row.max_ver }, actorEmail);
  }

  const mail = await sendReviewEmail({
    email, actor: actor || { email: actorEmail }, dealId: row.deal_id,
    kind: 'storyboard', itemTitle: row.title, version: row.max_ver,
  });

  return {
    clientSubmittedVersion: row.max_ver,
    clientSubmittedAt: submittedAt.toISOString(),
    shareToken: row.share_token,
    ...mail,
  };
}

// ── The covering email ──────────────────────────────────────────────────────
// A submit used to be silent apart from the portal bell. Producers write the
// email themselves now (ReviewEmailComposer), so this module needs to know
// where the review lives, who the client is, and how to get a message to them.

// Everything the composer needs to open a prefilled draft. `itemId` is a
// revision_videos.id or a storyboards.id depending on `kind`.
export async function reviewEmailContext({ kind, itemId, actorEmail }) {
  const isSb = kind === 'storyboard';
  const [row] = isSb
    ? await sql`
        SELECT sb.title, COALESCE(sp.deal_id, d.id) AS deal_id, sp.share_token,
               d.company_id, d.title AS deal_title, d.primary_contact_id, co.name AS company_name,
               sb.client_submitted_version,
               (SELECT MAX(version_number) FROM storyboard_versions WHERE storyboard_id = sb.id) AS max_ver
          FROM storyboards sb
          JOIN storyboard_projects sp ON sp.id = sb.project_id
          LEFT JOIN deals d ON (d.id = sp.deal_id OR d.storyboard_project_id = sp.id)
          LEFT JOIN companies co ON co.id = d.company_id
         WHERE sb.id = ${itemId}`
    : await sql`
        SELECT rv.title, COALESCE(rp.deal_id, d.id) AS deal_id, rp.share_token,
               d.company_id, d.title AS deal_title, d.primary_contact_id, co.name AS company_name,
               rv.client_submitted_version,
               (SELECT MAX(version_number) FROM revision_versions WHERE video_id = rv.id) AS max_ver
          FROM revision_videos rv
          JOIN revision_projects rp ON rp.id = rv.project_id
          LEFT JOIN deals d ON (d.id = rp.deal_id OR d.revision_project_id = rp.id)
          LEFT JOIN companies co ON co.id = d.company_id
         WHERE rv.id = ${itemId}`;
  if (!row) return { error: 'not-found' };

  const recipients = await clientRecipients({
    companyId: row.company_id, primaryContactId: row.primary_contact_id, dealId: row.deal_id,
  });
  return {
    kind: isSb ? 'storyboard' : 'video',
    itemId,
    title: row.title,
    projectTitle: row.deal_title || null,
    companyName: row.company_name || null,
    companyId: row.company_id || null,
    dealId: row.deal_id || null,
    reviewUrl: reviewUrlFor(kind, row.share_token),
    version: row.max_ver,
    clientSubmittedVersion: row.client_submitted_version ?? null,
    hasDraft: row.max_ver != null,
    recipients,
    gmail: await gmailSenderFor(actorEmail),
  };
}

// Who the review email should go to, best candidate first. The deal's primary
// contact leads because that's the person who signed; portal users follow
// because they already have a login; past viewers of this project are last but
// genuinely useful — they're whoever actually reviewed the previous round.
async function clientRecipients({ companyId, primaryContactId, dealId }) {
  const out = new Map(); // lower(email) -> { email, name, source }
  const add = (email, name, source) => {
    const key = String(email || '').trim().toLowerCase();
    if (!key || !key.includes('@')) return;
    if (!out.has(key)) out.set(key, { email: String(email).trim(), name: name || null, source });
    else if (!out.get(key).name && name) out.get(key).name = name;
  };

  if (primaryContactId) {
    const rows = await sql`SELECT name, email FROM contacts WHERE id = ${primaryContactId}`.catch(() => []);
    for (const r of rows) add(r.email, r.name, 'primary');
  }
  if (companyId) {
    const portal = await sql`
      SELECT pu.email, pu.name
        FROM portal_users pu
        JOIN portal_memberships pm ON pm.portal_user_id = pu.id
       WHERE pm.company_id = ${companyId}
         AND pm.disabled_at IS NULL AND pu.disabled_at IS NULL
       ORDER BY pu.created_at`.catch(() => []);
    for (const r of portal) add(r.email, r.name, 'portal');

    const contacts = await sql`
      SELECT c.name, c.email
        FROM contacts c
       WHERE c.email IS NOT NULL
         AND COALESCE(c.provisional, FALSE) = FALSE
         AND (c.company_id = ${companyId}
              OR EXISTS (SELECT 1 FROM contact_companies cc
                          WHERE cc.contact_id = c.id AND cc.company_id = ${companyId}))
       ORDER BY c.name NULLS LAST`.catch(() => []);
    for (const r of contacts) add(r.email, r.name, 'contact');
  }
  if (dealId) {
    const viewers = await sql`
      SELECT DISTINCT rv.name, rv.email
        FROM revision_viewers rv
        JOIN revision_projects rp ON rp.id = rv.project_id
       WHERE rv.email IS NOT NULL AND rp.deal_id = ${dealId}`.catch(() => []);
    for (const r of viewers) add(r.email, r.name, 'viewer');
  }

  const rank = { primary: 0, portal: 1, contact: 2, viewer: 3 };
  return [...out.values()].sort((a, b) => rank[a.source] - rank[b.source]);
}

// Is this staff member's Gmail connected? Decides whether the composer offers
// "send from your Gmail" or falls back to the Squideo address with their own
// email as reply-to. Production managers hit that fallback whenever they
// haven't linked a mailbox — without it, submitting simply refuses to send.
async function gmailSenderFor(actorEmail) {
  if (!actorEmail) return { connected: false, address: null };
  // Same test getFreshAccessToken applies: a live row that hasn't been
  // disconnected. There is no plain refresh_token column — it's stored
  // encrypted as refresh_token_enc.
  const [row] = await sql`
    SELECT gmail_address FROM gmail_accounts
     WHERE user_email = ${actorEmail} AND disconnected_at IS NULL
  `.catch(() => []);
  return { connected: !!row, address: row?.gmail_address || null };
}

// Send the covering email. `email` is the composed draft:
//   { to: [], cc: [], subject, html, text, via: 'gmail' | 'system' }
// Returns { emailSent, emailTo, emailVia } or { emailSent: false, emailError }.
// NEVER throws: the submit itself has already happened and must not be
// reported as a failure because the mail leg fell over.
export async function sendReviewEmail({ email, actor, dealId, kind, itemTitle, version }) {
  if (!email) return { emailSent: false };
  const to = cleanList(email.to);
  const cc = cleanList(email.cc);
  const subject = String(email.subject || '').trim();
  const html = String(email.html || '').trim();
  if (!to.length || !subject || !html) return { emailSent: false, emailError: 'Nothing to send' };
  const text = String(email.text || '').trim() || null;
  const via = email.via === 'system' ? 'system' : 'gmail';

  try {
    if (via === 'gmail') {
      // Threaded onto the deal so the conversation shows on the project like
      // any other client email — not stranded in someone's Sent folder.
      await performGmailSend(actor, {
        to, cc, bcc: [], subject, html, text: text || '',
        dealId: dealId || null, threadId: null, extraDealIds: [], attachments: [],
      });
    } else {
      await sendMail({ to, cc, subject, html, text, replyTo: actor?.email || null, throwOnError: true });
    }
  } catch (err) {
    console.warn('[clientReview] review email failed', err.message);
    return { emailSent: false, emailVia: via, emailError: friendlyMailError(err, via) };
  }

  await logDealEvent(dealId, 'review_email_sent',
    { kind, item: itemTitle, version, to, via }, actor?.email);
  return { emailSent: true, emailTo: to, emailVia: via };
}

function cleanList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  return [...new Set(arr.map(s => String(s || '').trim()).filter(s => s.includes('@')))];
}

function friendlyMailError(err, via) {
  if (via === 'gmail' && (err?.code === 'NOT_CONNECTED' || err?.code === 'REAUTH')) {
    return 'Your Gmail isn’t connected — reconnect it in Settings, or send from the Squideo address instead.';
  }
  return err?.message || 'The email could not be sent';
}
