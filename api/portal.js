// Customer-portal API — one consolidated router (repo pattern), fully separate
// from the staff CRM surface. Auth lives in the sq_portal HttpOnly cookie
// (JWT aud='portal-session'); every data query is scoped to the caller's
// organisation memberships. Responses go through the allowlist serialisers in
// api/_lib/portal/serialisers.js — no SELECT * passthrough.
//
// Routes (flat file — /api/portal/:action is rewritten to ?action= in vercel.json
// because Vercel's functions-config glob can't target bracketed filenames):
//   auth            — login / magic link / invites / reset / logout (public)
//   me              — profile (GET/PATCH)
//   overview        — dashboard payload (projects + ball-in-court)
//   project         — single project detail
//   library         — finished videos: delivered cuts, Drive "4. Signed Off",
//                     plus past work staff added from manage mode
//   library-item    — add/edit/remove that past work (manage mode only)
//   library-reorder — set a library group's running order (manage mode only)
//   library-upload-token — client-upload token for it (manage mode only)
//   company-logo    — the client's brand mark (manage mode only)
//   download        — org-checked file bytes / signed URLs
//   files           — brand + per-project documents (list/upload/delete)
//   script          — the project's script & visual direction stage (GET/POST)
//   extras          — discounted extras offers (GET) — accept via extras-accept
//   extras-accept   — server-priced accept → deal_extras row
//   request-video   — prefilled quote request with the 10% portal discount
//   po-number       — submit a purchase-order number
//   team            — members + invites + not-yet-invited contacts (GET/POST),
//                     revoke via team-revoke-invite
//   team-contact    — search the CRM contact book / attach someone to this
//                     organisation (manage mode only)
//   partner         — Partner Programme page data + call availability
//   partner-enquire — Partner Programme enquiry: how much video a month, and
//                     a date that suits. This is what alerts the team;
//                     reading the page does not.

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';
import { put, del, head } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';
import sql, { batchWrite } from './_lib/db.js';
import { streamBlob } from './_lib/blobStream.js';
import { streamPrivateBlob } from './_lib/blobPrivate.js';
import { sendMail, APP_URL } from './_lib/email.js';
import {
  sendNotification,
  resolveRecipients,
  persistInApp,
  ensurePortalNotificationDefaults,
  ensureSampleProjectNotificationDefault,
} from './_lib/notifications.js';
import { internalEmails, isInternalEmail } from './_lib/internalAccounts.js';
import { signQuoteRequestActionToken } from './_lib/auth.js';
import { getRoleForUser } from './_lib/userRoles.js';
import { hasPermission } from './_lib/permissions.js';
import { makeId, trimOrNull, lowerOrNull, ensureContactCompanies } from './_lib/crm/shared.js';
import { ensureDealExtrasTable } from './_lib/crm/extras.js';
import { buildNotificationEmail } from './quote-requests.js';
import { ensurePortalTables } from './_lib/portal/db.js';
import { logPortalActivity } from './_lib/portal/activity.js';
import { isFinalReleaseUnlocked, advanceDeliveredIfUnlocked } from './_lib/crm/delivery.js';
import { portalReviewLinkFor } from './_lib/crm/clientReview.js';
import {
  companyCreditBalance,
  videoCreditPricingParams,
  videoCreditQuote,
  videoCreditRatePerMin,
  createVideoCreditInvoiceOrder,
  reconcileVideoCreditOrders,
} from './_lib/videoCredit.js';
import {
  signPortalToken,
  portalCookieHeader,
  clearPortalCookieHeader,
  createRawToken,
  hashToken,
} from './_lib/portal/auth.js';
import { appendSetCookie } from './_lib/middleware.js';
import {
  requirePortalAuth,
  resolveCompanyId,
  requireDealInOrg,
  clientIp,
} from './_lib/portal/middleware.js';
import { deriveNextStep } from './_lib/portal/nextStep.js';
import { serialisePortalNotification } from './_lib/portal/notificationShape.js';
import { notifyPortalUser } from './_lib/portal/notifications.js';
import { deriveProjectTasks, countOpenTasks, bellTaskRows } from './_lib/portal/tasks.js';
import { voiceoverProposalContext } from './_lib/proposalPricing.js';
import {
  computePortalOffers,
  resolveOfferForAccept,
  extrasWindowOpen,
} from './_lib/portal/extrasOffers.js';
import { sendTeamInvite } from './_lib/portal/onboarding.js';
import {
  ensureVoiceoverCatalogue,
  serialiseArtist,
  getArtist,
  streamVoiceoverSample,
  resolveVoiceoverContext,
  applyVoiceoverSelection,
  shapePortalVoiceoverVideo,
  recordVoiceoverExtra,
  notifyVoiceoverChosen,
  emailVoiceoverConfirm,
  sectionName,
} from './_lib/voiceover.js';
import { ensureIntroCallTables } from './_lib/crm/introCallSlots.js';
import { ensureLeadAttribution } from './_lib/leadAttribution.js';
import { bookSlot, computeBookingSlots } from './_lib/introCallBooking.js';
import {
  companyHasLogo, portalLogoPath, emailLogoUrl, decodeLogo, ensureCompanyLogoColumns,
} from './_lib/portal/logo.js';
import {
  PORTAL_URL,
  portalMagicLinkHtml,
  portalResetHtml,
  portalExtraConfirmHtml,
  portalVoiceoverConfirmHtml,
  courseCrashCourseHtml,
  briefBuilderHtml,
} from './_lib/portal/emails.js';
import { ensureCourseTables } from './_lib/course/db.js';
import { createPortalSignup, SignupError } from './_lib/course/signup.js';
import { applyTag } from './_lib/crm/tags.js';
import {
  scheduleCourseEmails, scheduleBriefEmails, cancelCourseEmails, kindsInFamily,
} from './_lib/course/emails.js';
import { ensureClientBriefs } from './_lib/brief/db.js';
import { missingRequired, renderBriefText, briefProgress, answerLabel } from './_lib/brief/questions.js';
import { anyDriveAccessToken, listSignedOffFiles, streamDriveFile } from './_lib/portal/drive.js';
import {
  serialisePortalDeal,
  serialisePortalVideo,
  serialisePortalCompanyFile,
  serialisePortalDealFile,
  serialisePortalExtra,
  serialisePortalMember,
  serialisePortalInvite,
  aggregateVideoStage,
} from './_lib/portal/serialisers.js';
import { clientSchedule } from './_lib/portal/schedule.js';

export const config = {
  api: { bodyParser: false }, // raw body needed for uploads; JSON parsed manually
};

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 10;
const LOGIN_MAX_ATTEMPTS = 5; // per (email, ip) per 10 minutes
const MAGIC_SENDS_PER_10MIN = 3;
const INVITES_PER_DAY_PER_ORG = 10;
const UPLOADS_PER_DAY_PER_ORG = 50;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

// Library videos go to the PUBLIC revision blob store rather than the private
// deal-files one, so a <video> tag can stream them (the same store delivered
// cuts already play from). Same env fallback as api/revisions/[action].js.
const REVISION_BLOB_TOKEN =
  process.env.REVISION_BLOB_READ_WRITE_TOKEN || process.env.REVIEW_BLOB_READ_WRITE_TOKEN;

// Actions whose requests the browser issues itself, so a staff preview session
// may present its token as ?pv= (see the router).
const PV_QUERY_ACTIONS = new Set([
  'download', 'review-download', 'voiceover-sample', 'library-upload-token',
]);

// Actions that stay read-only even in manage mode. Everything here either
// commits the client to a spend or belongs to their own account — staff have a
// proper CRM path for each, and doing it "as them" would misattribute it.
const MANAGE_BLOCKED = new Set([
  'me', 'extras-accept', 'video-credit-checkout', 'video-credit-invoice',
]);

// ═══ THE RATE CARD IS FOR CLIENTS, NOT PROSPECTS ═════════════════════════════
// Video credit is the rung AFTER a first project: you buy production time in
// bulk once a style exists to repeat. Showing £/min to a video-guide signup
// we've never scoped anything for anchors every quote we send them afterwards
// — they'll read a bespoke price as a mark-up on a number they already know.
//
// Enforced HERE and not only in the nav, because hiding a menu item is not
// access control: all three routes are reachable by URL with a valid session.
const CLIENT_ONLY = new Set([
  'video-credit', 'video-credit-checkout', 'video-credit-invoice',
]);

const UPLOAD_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'txt', 'md',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'zip', 'ai', 'eps', 'psd', 'indd', 'key', 'pages',
  'otf', 'ttf', 'woff', 'woff2',
  'mp4', 'mov',
]);

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

// A valid bcrypt hash to equalise login timing on unknown emails (mirrors the
// staff login in api/auth/[action].js).
let _dummyHash = null;
function dummyPasswordHash() {
  if (!_dummyHash) _dummyHash = bcrypt.hashSync('squideo-portal-no-such-user', BCRYPT_COST);
  return _dummyHash;
}

async function isLoginLocked(email, ip) {
  const rows = await sql`
    SELECT attempts FROM portal_failed_logins
    WHERE email = ${email} AND ip = ${ip} AND last_at > NOW() - INTERVAL '10 minutes'
  `;
  return rows.length > 0 && rows[0].attempts >= LOGIN_MAX_ATTEMPTS;
}

async function recordFailedLogin(email, ip) {
  await sql`
    INSERT INTO portal_failed_logins (email, ip, attempts, first_at, last_at)
    VALUES (${email}, ${ip}, 1, NOW(), NOW())
    ON CONFLICT (email, ip) DO UPDATE SET
      attempts = CASE WHEN portal_failed_logins.last_at > NOW() - INTERVAL '10 minutes'
                      THEN portal_failed_logins.attempts + 1 ELSE 1 END,
      last_at  = NOW()
  `;
}

async function clearFailedLogins(email, ip) {
  await sql`DELETE FROM portal_failed_logins WHERE email = ${email} AND ip = ${ip}`;
}

// Pass `req` for a genuine sign-in (records a login row with IP/geo). Omit it
// when merely re-issuing the cookie after a token-version bump (profile save) —
// that isn't a login and shouldn't add a login event.
async function issuePortalSession(res, user, req = null) {
  const jwt = await signPortalToken({ puid: user.id, email: user.email, tv: user.token_version ?? 0 });
  appendSetCookie(res, portalCookieHeader(jwt));
  await sql`UPDATE portal_users SET last_login_at = NOW() WHERE id = ${user.id}`;
  // Awaited so the row survives the serverless freeze; logPortalActivity is
  // itself best-effort and never throws.
  if (req) await logPortalActivity({ req, portalUserId: user.id, eventKey: 'login' });
}

async function loadPortalUser(email) {
  const rows = await sql`
    SELECT id, email, name, phone, job_title, password_hash, token_version, disabled_at
      FROM portal_users WHERE email = ${email}
  `;
  return rows[0] || null;
}

// Create a one-time token (magic link / reset) for a user. Only the hash is
// stored; the raw token goes in the email link.
async function issueLoginToken(portalUserId, purpose, ttlMinutes) {
  const raw = createRawToken();
  await sql`
    INSERT INTO portal_login_tokens (id, portal_user_id, token_hash, purpose, expires_at)
    VALUES (${makeId('plt')}, ${portalUserId}, ${hashToken(raw)}, ${purpose},
            ${new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString()})
  `;
  return raw;
}

// Atomic single-use consume: stamps used_at in the same statement that checks
// it, so a replayed token can never win a race.
async function consumeLoginToken(rawToken, purpose) {
  const rows = await sql`
    UPDATE portal_login_tokens
       SET used_at = NOW()
     WHERE token_hash = ${hashToken(String(rawToken || ''))}
       AND purpose = ${purpose}
       AND used_at IS NULL
       AND expires_at > NOW()
    RETURNING portal_user_id
  `;
  return rows[0]?.portal_user_id || null;
}

// The org a sign-in email is branded with: the account's first (all but a
// handful of clients have exactly one) organisation.
async function primaryCompanyId(portalUserId) {
  const rows = await sql`
    SELECT company_id FROM portal_memberships
     WHERE portal_user_id = ${portalUserId} AND disabled_at IS NULL
     ORDER BY created_at ASC LIMIT 1
  `;
  return rows[0]?.company_id || null;
}

function publicPortalUser(user, memberships = null) {
  return {
    email: user.email,
    name: user.name || null,
    phone: user.phone || null,
    jobTitle: user.job_title || user.jobTitle || null,
    companies: memberships || user.companies || [],
  };
}

// ── Ball-in-court state gathering (shared by overview + project detail) ──────
// One query per concern across ALL the org's deals, then derived per deal.
async function gatherDealStates(dealIds) {
  const empty = { proposals: new Map(), videos: new Map(), revPending: new Map(), sbPending: new Map(), revLinks: new Map(), sbLinks: new Map(), kickoffDeals: new Set(), kickoffBookings: new Map(), brandCompanies: new Set(), scriptFiles: new Map() };
  if (!dealIds.length) return empty;

  // Self-heal the voiceover columns/table before the video query joins them.
  await ensureVoiceoverCatalogue();

  const [proposalRows, videoRows, revRows, sbRows, kickoffRows, brandRows, scriptRows] = await Promise.all([
    sql`
      SELECT p.id, p.deal_id, p.created_at, p.data AS proposal_data, s.data AS signature_data, s.signed_at
        FROM proposals p
        LEFT JOIN signatures s ON s.proposal_id = p.id
       WHERE p.deal_id = ANY(${dealIds})
       ORDER BY (s.signed_at IS NOT NULL) DESC, p.created_at DESC
    `,
    sql`
      SELECT v.id, v.deal_id, v.title, v.status, v.sort_order, v.video_number,
             v.production_phase, v.production_stage, v.video_length,
             v.production_schedule,
             v.voiceover_artist_id, va.name AS voiceover_artist_name, va.category AS voiceover_category
        FROM project_videos v
        LEFT JOIN voiceover_artists va ON va.id = v.voiceover_artist_id
       WHERE v.deal_id = ANY(${dealIds})
       ORDER BY v.sort_order ASC, v.created_at ASC
    `,
    sql`
      // Ordered so the portal's list of reviews reads in video order rather than
      // whatever the planner returned — the "ready to review" banner used to
      // name an arbitrary video because of it. client_submitted_at (which the
      // banner picks the most recent by) is added by the revisions router's
      // self-heal, so fall back to the column-free query on a database that
      // hasn't had it yet rather than losing every link.
      SELECT COALESCE(rp.deal_id, dd.id) AS deal_id, rp.share_token, rp.approved_at AS project_approved_at,
             rv.id AS video_id, rv.title AS video_title, rv.approved_at, rv.feedback_submitted_at,
             rv.client_submitted_version, rv.client_submitted_at
        FROM revision_projects rp
        JOIN revision_videos rv ON rv.project_id = rp.id
        LEFT JOIN deals dd ON dd.revision_project_id = rp.id
       WHERE rp.deal_id = ANY(${dealIds}) OR dd.id = ANY(${dealIds})
       ORDER BY rv.sort_order, rv.created_at
    `.catch(() => sql`
      SELECT COALESCE(rp.deal_id, dd.id) AS deal_id, rp.share_token, rp.approved_at AS project_approved_at,
             rv.id AS video_id, rv.title AS video_title, rv.approved_at, rv.feedback_submitted_at,
             rv.client_submitted_version
        FROM revision_projects rp
        JOIN revision_videos rv ON rv.project_id = rp.id
        LEFT JOIN deals dd ON dd.revision_project_id = rp.id
       WHERE rp.deal_id = ANY(${dealIds}) OR dd.id = ANY(${dealIds})
       ORDER BY rv.sort_order, rv.created_at
    `).catch(() => []),
    // approved_version (which draft the approval covers) is added by the
    // storyboards router's self-heal, so fall back to the column-free query on a
    // database that hasn't had it applied yet rather than losing every link.
    sql`
      SELECT COALESCE(sp.deal_id, dd.id) AS deal_id, sp.share_token, sb.id AS storyboard_id, sb.title AS storyboard_title,
             sb.approved_at, sb.approved_version, sb.feedback_submitted_at,
             sb.client_submitted_version, sb.client_submitted_at
        FROM storyboard_projects sp
        JOIN storyboards sb ON sb.project_id = sp.id
        LEFT JOIN deals dd ON dd.storyboard_project_id = sp.id
       WHERE sp.deal_id = ANY(${dealIds}) OR dd.id = ANY(${dealIds})
       ORDER BY sb.sort_order, sb.created_at
    `.catch(() => sql`
      SELECT COALESCE(sp.deal_id, dd.id) AS deal_id, sp.share_token, sb.id AS storyboard_id, sb.title AS storyboard_title,
             sb.approved_at, sb.feedback_submitted_at,
             sb.client_submitted_version
        FROM storyboard_projects sp
        JOIN storyboards sb ON sb.project_id = sp.id
        LEFT JOIN deals dd ON dd.storyboard_project_id = sp.id
       WHERE sp.deal_id = ANY(${dealIds}) OR dd.id = ANY(${dealIds})
       ORDER BY sb.sort_order, sb.created_at
    `).catch(() => []),
    sql`
      SELECT DISTINCT ON (deal_id) deal_id, starts_at, meet_url, client_timezone
        FROM intro_call_bookings
       WHERE deal_id = ANY(${dealIds}) AND kind = 'kickoff' AND status = 'confirmed'
       ORDER BY deal_id, created_at DESC
    `.catch(() => []),
    // Companies (among these deals) that already have brand assets on file — a
    // brand-category portal file uploaded on any prior project. Used to mark the
    // "upload brand guidelines" task done for returning organisations.
    sql`
      SELECT DISTINCT d.company_id
        FROM deals d
       WHERE d.id = ANY(${dealIds})
         AND EXISTS (
           SELECT 1 FROM portal_company_files f
            WHERE f.company_id = d.company_id AND f.category = 'brand'
         )
    `.catch(() => []),
    // How many script / visual-direction files the client has sent per deal —
    // one half of the "script & visual direction" step (the other is the
    // deals.script_status flag staff tick, or the client's "you write it").
    sql`
      SELECT deal_id, COUNT(*)::int AS n FROM deal_files
       WHERE deal_id = ANY(${dealIds}) AND category IN ('script', 'visual_direction')
       GROUP BY deal_id
    `.catch(() => []),
  ]);

  const proposals = new Map(); // dealId -> { id, signature, hasVo }
  for (const p of proposalRows) {
    if (!proposals.has(p.deal_id)) {
      // Does this project include a voiceover at all? (AI VO is standard but can
      // be removed from the proposal; or the client bought the human VO extra.)
      let hasVo = false;
      try {
        const vo = voiceoverProposalContext(p.proposal_data, p.signature_data);
        hasVo = vo.aiIncluded || vo.humanPurchased || vo.humanIncludedStandard;
      } catch { hasVo = false; }
      proposals.set(p.deal_id, {
        id: p.id,
        signature: p.signed_at ? { data: p.signature_data, signedAt: p.signed_at } : null,
        hasVo,
      });
    }
  }

  const videos = new Map(); // dealId -> rows[]
  for (const v of videoRows) {
    if (!videos.has(v.deal_id)) videos.set(v.deal_id, []);
    videos.get(v.deal_id).push(v);
  }

  // The banner names ONE video, so of several waiting it takes the one sent
  // most recently — that's the one the client was last asked about, and its id
  // rides along on the link so the viewer opens it rather than video 1.
  const sentAt = (r) => new Date(r?.client_submitted_at || 0).getTime() || 0;
  const pendingSentAt = new Map(); // dealId -> timestamp of the row currently held
  const revPending = new Map(); // dealId -> { shareToken, videoId, videoTitle }
  const revLinks = new Map();   // dealId -> [{ shareToken, videoId, title, approved, feedbackSubmitted }]
  for (const r of revRows) {
    if (!revLinks.has(r.deal_id)) revLinks.set(r.deal_id, []);
    // Only surface a review the client has actually been sent (a draft uploaded
    // but not yet submitted stays internal). client_submitted_version = highest
    // draft the client may see; NULL = nothing submitted.
    if (r.client_submitted_version != null) {
      revLinks.get(r.deal_id).push({
        shareToken: r.share_token,
        videoId: r.video_id,
        title: r.video_title,
        approved: !!r.approved_at,
        feedbackSubmitted: !!r.feedback_submitted_at,
      });
      if (!r.approved_at && !r.feedback_submitted_at
        && sentAt(r) >= (pendingSentAt.get(r.deal_id) ?? -1)) {
        pendingSentAt.set(r.deal_id, sentAt(r));
        revPending.set(r.deal_id, {
          shareToken: r.share_token, videoId: r.video_id, videoTitle: r.video_title,
        });
      }
    }
  }

  const sbPendingSentAt = new Map(); // see pendingSentAt above
  const sbPending = new Map();
  const sbLinks = new Map();
  for (const r of sbRows) {
    if (!sbLinks.has(r.deal_id)) sbLinks.set(r.deal_id, []);
    // Only surface once submitted to the client (see revLinks note above).
    if (r.client_submitted_version != null) {
      // An approval covers the draft it was given for. A newer draft sent since
      // is back with the client, so it isn't "approved" as far as the portal's
      // ball-in-court is concerned.
      const approved = !!r.approved_at
        && (r.approved_version == null || r.approved_version >= (r.client_submitted_version ?? 0));
      sbLinks.get(r.deal_id).push({
        shareToken: r.share_token,
        storyboardId: r.storyboard_id,
        title: r.storyboard_title,
        approved,
        feedbackSubmitted: !!r.feedback_submitted_at,
      });
      if (!approved && !r.feedback_submitted_at
        && sentAt(r) >= (sbPendingSentAt.get(r.deal_id) ?? -1)) {
        sbPendingSentAt.set(r.deal_id, sentAt(r));
        sbPending.set(r.deal_id, {
          shareToken: r.share_token, storyboardId: r.storyboard_id, storyboardTitle: r.storyboard_title,
        });
      }
    }
  }

  const kickoffDeals = new Set(kickoffRows.map((r) => r.deal_id));
  const kickoffBookings = new Map(kickoffRows.map((r) => [r.deal_id, {
    startsAt: r.starts_at, timezone: r.client_timezone || null, joinUrl: r.meet_url || null,
  }]));
  const brandCompanies = new Set(brandRows.map((r) => r.company_id));
  const scriptFiles = new Map(scriptRows.map((r) => [r.deal_id, r.n]));

  return { proposals, videos, revPending, sbPending, revLinks, sbLinks, kickoffDeals, kickoffBookings, brandCompanies, scriptFiles };
}

function nextStepFor(deal, states) {
  const prop = states.proposals.get(deal.id) || null;
  // The banner must track the SAME live position as the phase bar, which uses
  // the aggregated video stage (least-advanced video) — not the deal's own
  // production_phase/stage columns, which are stamped once at production start
  // and never move. Without this, a project whose videos have all advanced to
  // "Completed" still shows the stale "We're on it — at <old stage>" banner.
  const agg = aggregateVideoStage(states.videos.get(deal.id) || []);
  const effectiveDeal = agg
    ? { ...deal, production_phase: agg.phase, production_stage: agg.stage }
    : deal;
  return deriveNextStep({
    deal: effectiveDeal,
    proposalId: prop?.id || null,
    signature: prop?.signature || null,
    revisionPending: states.revPending.get(deal.id) || null,
    storyboardPending: states.sbPending.get(deal.id) || null,
    videos: states.videos.get(deal.id) || [],
    tasks: tasksFor(deal, states),
  });
}

// The client's "project tasks" for a deal (purchase order, voiceover, kick-off).
function tasksFor(deal, states) {
  const prop = states.proposals.get(deal.id) || null;
  return deriveProjectTasks({
    deal,
    videos: states.videos.get(deal.id) || [],
    hasKickoffBooking: states.kickoffDeals.has(deal.id),
    kickoffBooking: states.kickoffBookings.get(deal.id) || null,
    hasVoiceover: prop?.hasVo ?? false,
    hasBrandAssets: states.brandCompanies.has(deal.company_id),
    scriptStatus: deal.script_status || null,
    scriptFileCount: states.scriptFiles.get(deal.id) || 0,
    sigPaymentOption: prop?.signature?.data?.paymentOption || null,
  });
}

// ── The router ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return res.status(200).end();
    const { action } = req.query;
    await ensurePortalTables();

    // ═════════════════════════ PUBLIC: auth ═════════════════════════
    if (action === 'auth') return authRoutes(req, res);

    // Requests the BROWSER makes directly — a <video>/<audio> source, a download
    // link, the Blob SDK's own fetch for an upload token — can't carry our
    // per-tab X-Portal-Preview header, so a staff preview/manage session passes
    // the same signed token as ?pv=. Restricted to these actions: nothing that
    // our own fetch wrapper calls should ever take a token from the query string
    // (see src/portal/api.js mediaUrl).
    if (PV_QUERY_ACTIONS.has(action) && req.query.pv && !req.headers['x-portal-preview']) {
      req.headers['x-portal-preview'] = String(req.query.pv);
    }

    // Everything else requires a portal session.
    const user = await requirePortalAuth(req, res);
    if (!user) return;

    // Preview sessions (staff viewing as a client) are read-only — all portal
    // reads are GET, so blocking non-GET blocks every side-effect (uploads,
    // extras, requests, PO, invites, profile edits) in one place.
    //
    // Manage mode (a preview token minted with the `manage` claim) lifts that so
    // staff can act in the portal for real — except for the handful of actions
    // that are the client's alone to take: spending money and their own account.
    if (user.isPreview && req.method !== 'GET') {
      if (!user.canManage) {
        return res.status(403).json({ error: 'Preview mode — changes are disabled. This is a read-only view of the client’s portal.' });
      }
      if (MANAGE_BLOCKED.has(action)) {
        return res.status(403).json({ error: 'That one stays with the client — payments, extras and their own account settings can’t be actioned from manage mode. Use the CRM instead.' });
      }
    }

    // Rate-card routes, refused unless this org is meant to see credit.
    // Resolved from the SESSION's own company list, never from the query
    // string — a prospect who guesses a client's companyId is already blocked
    // by resolveCompanyId, and this check must not be the weaker of the two.
    if (CLIENT_ONLY.has(action)) {
      const cid = req.query.companyId ? String(req.query.companyId) : user.companyIds[0];
      const co = user.companies.find((c) => c.id === cid);
      if (co && co.creditVisible === false) {
        // Last line of defence: nobody is ever locked out of credit they have
        // already paid for. A staff mis-click on "switch off" must not hide a
        // client's own balance from them.
        const held = await companyCreditBalance(co).catch(() => null);
        if (!((held?.issued || 0) > 0)) {
          return res.status(403).json({ error: 'Video credit is available once your first project is under way.' });
        }
      }
    }

    switch (action) {
      case 'me': return meRoutes(req, res, user);
      case 'track': return trackRoute(req, res, user);
      case 'notifications': return notificationsRoute(req, res, user);
      case 'course': return courseRoute(req, res, user);
      case 'course-progress': return courseProgressRoute(req, res, user);
      case 'brief': return briefRoute(req, res, user);
      case 'demo-project': return demoProjectRoute(req, res, user);
      case 'demo-event': return demoEventRoute(req, res, user);
      case 'overview': return overviewRoute(req, res, user);
      case 'project': return projectRoute(req, res, user);
      case 'library': return libraryRoute(req, res, user);
      case 'files-upload-token': return filesUploadTokenRoute(req, res, user);
      case 'library-upload-token': return libraryUploadTokenRoute(req, res, user);
      case 'library-item': return libraryItemRoute(req, res, user);
      case 'library-reorder': return libraryReorderRoute(req, res, user);
      case 'company-logo': return companyLogoRoute(req, res, user);
      case 'download': return downloadRoute(req, res, user);
      case 'review-download': return reviewDownloadRoute(req, res, user);
      case 'files': return filesRoutes(req, res, user);
      case 'extras': return extrasRoute(req, res, user);
      case 'extras-accept': return extrasAcceptRoute(req, res, user);
      case 'voiceover': return voiceoverRoute(req, res, user);
      case 'voiceover-select': return voiceoverSelectRoute(req, res, user);
      case 'voiceover-sample': return voiceoverSampleRoute(req, res, user);
      case 'kickoff': return kickoffRoute(req, res, user);
      case 'kickoff-book': return kickoffBookRoute(req, res, user);
      case 'request-video': return requestVideoRoute(req, res, user);
      case 'script': return scriptRoute(req, res, user);
      case 'video-credit': return videoCreditRoute(req, res, user);
      case 'video-credit-checkout': return videoCreditCheckoutRoute(req, res, user);
      case 'video-credit-invoice': return videoCreditInvoiceRoute(req, res, user);
      case 'po-number': return poNumberRoute(req, res, user);
      case 'team': return teamRoutes(req, res, user);
      case 'team-contact': return teamContactRoute(req, res, user);
      case 'team-revoke-invite': return teamRevokeInviteRoute(req, res, user);
      case 'partner': return partnerRoute(req, res, user);
      case 'partner-enquire': return partnerEnquireRoute(req, res, user);
      default: return res.status(404).json({ error: 'Not found' });
    }
  } catch (err) {
    console.error('[portal] error', err);
    return res.status(500).json({ error: 'Request failed' });
  }
}

// ═════════════════════════ track ═════════════════════════
// Which pages a client opens. Actions (uploads, extras, payments) are read from
// their own authoritative timestamps and are deliberately NOT logged here —
// this fills the one real gap, which is knowing what they looked at.
//
// logPortalActivity no-ops without a portal_user_id, so a staff preview or
// manage session silently records nothing: the client's activity stays theirs.
// 'course' is deliberately absent. The video guide reports itself when a video
// is FINISHED (course.completed_video), which is the only part of it worth
// knowing; logging every visit to the page on top of that told us a client had
// been busy when all they'd done was reload.
const TRACKED_VIEWS = new Set([
  'home', 'project', 'library', 'documents', 'extras', 'voiceover', 'kickoff',
  'script', 'request', 'video-credit', 'partner', 'team', 'settings', 'review', 'storyboard',
  'brief', 'demo',
]);

async function trackRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Always 200: tracking must never be something the client notices failing.
  if (!user.puid) return res.status(200).json({ ok: true });
  const body = await readJsonBody(req);
  const view = trimOrNull(body.view);
  if (!view || !TRACKED_VIEWS.has(view)) return res.status(200).json({ ok: true });
  const companyId = user.companyIds.includes(String(body.companyId)) ? String(body.companyId) : null;
  // A deal id is only recorded once it's checked against the caller's org.
  let dealId = trimOrNull(body.dealId);
  if (dealId) {
    const [ok] = await sql`
      SELECT id FROM deals WHERE id = ${dealId} AND company_id = ANY(${user.companyIds})
    `.catch(() => []);
    if (!ok) dealId = null;
  }
  await logPortalActivity({
    req, portalUserId: user.puid, companyId, dealId,
    eventKey: 'view', detail: { view },
  });
  return res.status(200).json({ ok: true });
}

// ═════════════════════════ video guide ═════════════════════════
// Every signed-in portal user gets all eight videos — clients and course
// signups alike. There is nothing org-scoped here, which is why it needs no
// resolveCompanyId: the entitlement IS having a session.

// A video counts as watched at 90% rather than on `ended` — people stop before
// the outro, and a course that refuses to tick off a video someone has plainly
// watched is worse than one that's slightly generous.
const COURSE_COMPLETE_RATIO = 0.9;

async function courseRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  await ensureCourseTables();

  const modules = await sql`
    SELECT id, slug, module_number, title, subtitle, description,
           duration_seconds, poster IS NOT NULL AS has_poster, poster_updated_at
      FROM course_modules
     WHERE published
     ORDER BY COALESCE(sort_order, module_number), module_number
  `;

  // A preview session has no puid and so no progress of its own — the staff
  // member is looking at the shape of the page, not at anyone's watch history.
  const progress = user.puid
    ? await sql`
        SELECT module_id, furthest_seconds, duration_seconds, completed_at, view_count
          FROM course_progress WHERE portal_user_id = ${user.puid}
      `
    : [];
  const byModule = new Map(progress.map((p) => [p.module_id, p]));

  const items = modules.map((m) => {
    const p = byModule.get(m.id) || null;
    return {
      id: m.id,
      slug: m.slug,
      moduleNumber: m.module_number,
      title: m.title,
      subtitle: m.subtitle || null,
      description: m.description || null,
      durationSeconds: m.duration_seconds ?? null,
      posterUrl: m.has_poster
        ? `/api/course?action=poster&slug=${encodeURIComponent(m.slug)}` +
          (m.poster_updated_at ? `&v=${new Date(m.poster_updated_at).getTime()}` : '')
        : null,
      resumeSeconds: p?.furthest_seconds ?? 0,
      completed: !!p?.completed_at,
      started: !!p,
    };
  });

  const completed = items.filter((i) => i.completed).length;
  // "Continue watching" is the first thing they haven't finished — which after
  // a completed course is nothing, so the page shows the completion card.
  const next = items.find((i) => !i.completed) || null;

  return res.status(200).json({
    modules: items,
    completedCount: completed,
    totalCount: items.length,
    percentComplete: items.length ? Math.round((completed / items.length) * 100) : 0,
    continueSlug: next?.slug || null,
    allComplete: items.length > 0 && completed === items.length,
  });
}

// A 15-second heartbeat plus pause/ended/visibilitychange. Always 200: progress
// is invisible plumbing, and a viewer must never see it fail.
async function courseProgressRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ok = () => res.status(200).json({ ok: true });
  if (!user.puid) return ok();                 // preview session — nothing to record

  try {
    await ensureCourseTables();
    const body = await readJsonBody(req);
    const slug = trimOrNull(body.slug);
    if (!slug) return ok();

    const [m] = await sql`SELECT id, duration_seconds FROM course_modules WHERE slug = ${slug} AND published`;
    if (!m) return ok();

    const duration = Math.max(0, Math.round(Number(body.durationSeconds) || m.duration_seconds || 0));
    const position = Math.max(0, Math.round(Number(body.positionSeconds) || 0));
    // Clamp to the video's length: a corrupt or spoofed position must not be
    // able to mark a video complete, or to poison the reporting.
    const capped = duration ? Math.min(position, duration) : position;
    const done = body.ended === true || (duration > 0 && capped / duration >= COURSE_COMPLETE_RATIO);

    await sql`
      INSERT INTO course_progress (
        portal_user_id, module_id, furthest_seconds, seconds_watched,
        duration_seconds, view_count, completed_at)
      VALUES (${user.puid}, ${m.id}, ${capped}, ${capped}, ${duration || null}, 1,
              ${done ? new Date() : null})
      ON CONFLICT (portal_user_id, module_id) DO UPDATE SET
        -- A high-water mark: scrubbing backwards must not lose their place.
        furthest_seconds = GREATEST(course_progress.furthest_seconds, EXCLUDED.furthest_seconds),
        seconds_watched  = course_progress.seconds_watched + EXCLUDED.seconds_watched,
        duration_seconds = COALESCE(EXCLUDED.duration_seconds, course_progress.duration_seconds),
        view_count       = course_progress.view_count + 1,
        last_viewed_at   = NOW(),
        -- Completion sticks. Re-watching half of a finished video doesn't
        -- un-finish it.
        completed_at     = COALESCE(course_progress.completed_at, EXCLUDED.completed_at)
    `;

    if (done) {
      await logPortalActivity({
        req, portalUserId: user.puid, eventKey: 'course.completed_video', detail: { slug },
      });
      await stampCourseCompletionIfDone(req, user.puid);
    }
  } catch (err) {
    console.warn('[course] progress drop', err.message);
  }
  return ok();
}

// Stamp course_signups.completed_at the first time every published video is
// done. Best-effort and idempotent — the WHERE clause means a second call after
// completion changes nothing.
async function stampCourseCompletionIfDone(req, puid) {
  const [row] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM course_modules WHERE published) AS total,
      (SELECT COUNT(*)::int FROM course_progress p
         JOIN course_modules m ON m.id = p.module_id
        WHERE p.portal_user_id = ${puid} AND m.published AND p.completed_at IS NOT NULL) AS done
  `;
  if (!row || !row.total || row.done < row.total) return;
  const updated = await sql`
    UPDATE course_signups SET completed_at = NOW()
     WHERE portal_user_id = ${puid} AND completed_at IS NULL
    RETURNING id, contact_id
  `;
  if (updated.length) {
    await logPortalActivity({ req, portalUserId: puid, eventKey: 'course.completed' });
    // Tag the CRM contact so sales can filter on it. applyTag never throws.
    await applyTag(updated[0].contact_id, 'course-completed', {
      label: 'Course completed', colour: '#15803D', by: 'system:course',
    });
    // Stop the course nudges. The cron re-checks this anyway, but cancelling
    // now means the rows are visibly dead rather than looking due until the
    // sweep runs.
    //
    // Scoped to the course family: finishing the videos says nothing about a
    // half-written brief, and silencing those would lose the warmer lead of
    // the two.
    await cancelCourseEmails(updated[0].id, kindsInFamily('course'));
  }
}

// ═════════════════════════ notifications ═════════════════════════
// The client's bell: two different things that used to be muddled into one.
//
//   TASKS are things they still have to DO — upload the brand guidelines, book
//   the kick-off. They're read LIVE from the project every time, never stored,
//   because a stored task row is a snapshot: the moment someone uploads a logo
//   it's a lie sitting in the bell until they happen to click it. Live tasks
//   simply stop being returned.
//
//   NOTIFICATIONS are things that HAPPENED — your video is ready to review,
//   your storyboard was finalised. Those are events, they're stored, and they
//   stay until read.
//
// One bundled "Your project is ready — you have 3 tasks" row used to stand in
// for the first group. It's gone (and filtered out of the feed on the way past,
// so the ones already written disappear rather than lingering behind the new
// task list saying the same thing worse).
//
// Scoped strictly to the caller's own portal_user id.
const RETIRED_NOTIFICATION_KEYS = ['portal.tasks_launched'];

async function notificationsRoute(req, res, user) {
  // Preview sessions have no puid — nothing to show, nothing to mark.
  if (!user.puid) return res.status(200).json({ notifications: [], unread: 0, tasks: [] });

  if (req.method === 'GET') {
    // Tasks are only computed when asked for (?tasks=1). Deriving them costs
    // the best part of a dozen round-trips through the task engine, and this
    // endpoint is polled every 25 seconds by every open tab — so the client
    // asks for them on load and when the tab is re-focused, and the ticking
    // poll just refreshes the stored feed. Tasks change when somebody DOES
    // something, which is exactly when those two moments happen.
    const withTasks = req.query.tasks === '1';
    // Piggy-backed on the same infrequent call for the same reason.
    if (withTasks) await seedSampleTourNotification(user);

    const [rows, [{ unread }], tasks] = await Promise.all([
      sql`
        SELECT id, notification_key, title, body, link, created_at, read_at
          FROM portal_notifications
         WHERE portal_user_id = ${user.puid}
           AND NOT (notification_key = ANY(${RETIRED_NOTIFICATION_KEYS}))
         ORDER BY created_at DESC
         LIMIT 50
      `,
      sql`
        SELECT COUNT(*)::int AS unread FROM portal_notifications
         WHERE portal_user_id = ${user.puid} AND read_at IS NULL
           AND NOT (notification_key = ANY(${RETIRED_NOTIFICATION_KEYS}))
      `,
      // Best-effort: the bell must still open if the task engine trips over.
      withTasks
        ? openTasksForUser(user).catch((err) => {
          console.warn('[portal] bell tasks failed', err.message);
          return [];
        })
        : Promise.resolve(null),
    ]);
    return res.status(200).json({
      notifications: rows.map(serialisePortalNotification),
      unread,
      // Absent (rather than empty) when not asked for, so the client knows to
      // keep the list it already has instead of blanking the section.
      ...(withTasks ? { tasks } : {}),
    });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (body.all) {
      await sql`
        UPDATE portal_notifications SET read_at = NOW()
         WHERE portal_user_id = ${user.puid} AND read_at IS NULL
      `;
      return res.status(200).json({ ok: true });
    }
    const id = trimOrNull(body.id);
    if (!id) return res.status(400).json({ error: 'id or all required' });
    await sql`
      UPDATE portal_notifications SET read_at = NOW()
       WHERE id = ${id} AND portal_user_id = ${user.puid} AND read_at IS NULL
    `;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Every task still open across the client's live projects, newest project
// first, as flat rows the bell can list one per line. Same task engine the
// dashboard and project page use, so the bell can't disagree with them.
async function openTasksForUser(user) {
  const deals = await sql`
    SELECT * FROM deals
     WHERE company_id = ANY(${user.companyIds}) AND stage IN ('signed', 'paid')
     ORDER BY last_activity_at DESC NULLS LAST
  `;
  if (!deals.length) return [];
  const states = await gatherDealStates(deals.map((d) => d.id));
  return bellTaskRows(deals.map((deal) => ({ deal, tasks: tasksFor(deal, states) })));
}

// The one-off "have a look round the sample project" nudge.
//
// Self-seeding on read rather than written at signup, for two reasons: every
// client who already had an account when this shipped should get it too (no
// backfill), and it can't be sent before the sample actually has something in
// it. Guarded on the key, so it lands exactly once per person, ever.
async function seedSampleTourNotification(user) {
  try {
    const [seen] = await sql`
      SELECT id FROM portal_notifications
       WHERE portal_user_id = ${user.puid} AND notification_key = 'portal.sample_tour'
       LIMIT 1
    `;
    if (seen) return;
    const [cfg] = await sql`SELECT demo_project FROM settings WHERE id = 1`.catch(() => []);
    const demo = cfg?.demo_project || {};
    if (!demo.videoUrl && !demo.storyboardPdfUrl) return;
    await notifyPortalUser({
      portalUserId: user.puid,
      companyId: user.companyIds[0] || null,
      key: 'portal.sample_tour',
      title: 'Have a look around before you need to',
      body: 'We\'ve set up a sample project so you can try the review tools — sign off a storyboard, comment on a cut — on a made-up job. Two minutes, and nothing you do reaches anyone.',
      link: '#/demo',
    });
  } catch (err) {
    console.warn('[portal] sample tour seed failed', err.message);
  }
}

// ═════════════════════════ self-serve signup ═════════════════════════
// The only account creation in the product without an invite, and therefore the
// one public door — written defensively in api/_lib/course/signup.js.
//
// Two lead magnets arrive here: the video guide and the brief builder. They
// differ only in where they land someone and what the email says, so they share
// a handler; everything genuinely per-source lives in SIGNUP_SOURCES.
//
// Two outcomes the caller can tell apart:
//   next:'portal' — brand new account, signed in, go straight to `to`.
//   next:'email'  — that address already has a portal account, so a magic link
//                   is sent instead. It must NOT be signed in here: a public
//                   form that hands out a session for any address typed into it
//                   is an account takeover, not a signup.
//
// That difference is an enumeration oracle — it reveals whether an address has
// a Squideo portal account. Accepted deliberately: the alternative is a "check
// your email" wall for everyone, which is the single biggest drop-off on the
// page. The throttle (5/IP/hour, 20/day) makes bulk enumeration impractical,
// which is the part that actually matters.
//
// `to` is returned rather than left to the front end so a page embedded on the
// marketing site doesn't have to know portal routes to send someone to the
// right place.
const SIGNUP_LANDINGS = {
  course: {
    to: '#/course',
    subject: 'Your Free 6-Min Video Guide is unlocked',
    html: (args) => courseCrashCourseHtml(args),
    textNew: `All eight videos are unlocked here: ${PORTAL_URL}#/course`,
    textReturning: (loginUrl) => `You already have a Squideo account — sign in here to watch the guide: ${loginUrl}`,
    activityKey: 'course.signup',
    schedule: scheduleCourseEmails,
  },
  brief: {
    to: '#/brief',
    subject: 'Your video brief is ready when you are',
    html: (args) => briefBuilderHtml(args),
    textNew: `Pick up your brief here: ${PORTAL_URL}#/brief`,
    textReturning: (loginUrl) => `You already have a Squideo account — sign in here to carry on with your brief: ${loginUrl}`,
    activityKey: 'brief.signup',
    schedule: scheduleBriefEmails,
  },
};

async function selfServeSignup(req, res, body, source) {
  const landing = SIGNUP_LANDINGS[source] || SIGNUP_LANDINGS.course;
  let result;
  try {
    result = await createPortalSignup({
      source,
      email: body.email,
      name: body.name,
      companyName: body.companyName,
      marketingConsent: body.marketingConsent === true,
      consentText: body.consentText,
      attribution: body.attribution,
      honeypot: body.website,          // off-screen field; bots fill it in
      ip: clientIp(req),
    });
  } catch (err) {
    if (err instanceof SignupError) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  // Honeypot: answer exactly as a success would, and do nothing.
  if (result.silent) return res.status(200).json({ ok: true, next: 'portal', to: landing.to });

  if (result.outcome === 'created') {
    await issuePortalSession(res, result.user, req);
    await logPortalActivity({ req, portalUserId: result.user.id, eventKey: landing.activityKey });

    // ── The iframe handoff ────────────────────────────────────────────────────
    // A form embedded on the marketing site runs in a THIRD-PARTY browsing
    // context. The session cookie above is set on a same-origin fetch, but the
    // context is what browsers judge: Safari blocks third-party cookie writes
    // outright and Chrome partitions them, so the cookie either never lands or
    // lands somewhere the top-level portal will never read. The visitor would
    // arrive signed out, on the one page we told them was already theirs.
    //
    // So the embed asks for a one-time login token instead and redirects the
    // TOP window to /portal?login=…, where the exchange — and the cookie — is
    // first-party and works everywhere.
    //
    // Only ever minted for a brand-new account, i.e. exactly where we already
    // issue a session unconditionally. Never on the 'existing' branch below:
    // handing a login token to whoever typed an address into a public form is
    // the account takeover this whole route is written to avoid.
    let loginToken = null;
    if (body.handoff === true) {
      loginToken = await issueLoginToken(result.user.id, 'magic_link', 15).catch(() => null);
    }
    // Queue this door's nudge series. Nothing sends until the cron is enabled in
    // Admin → Video guide, and every step re-checks its gates at send time.
    await landing.schedule(result.signupId, result.user.email);
    // Best-effort: a failed welcome email must not cost them the account they
    // just created and are already signed in to.
    try {
      await sendMail({
        to: result.user.email,
        subject: landing.subject,
        html: landing.html({ name: result.user.name }),
        text: landing.textNew,
      });
    } catch (err) { console.warn(`[${source}] welcome email failed`, err.message); }
    return res.status(200).json({ ok: true, next: 'portal', to: landing.to, loginToken });
  }

  // Existing account (or a disabled one — same answer either way). Send a
  // sign-in link, reusing the magic-link machinery and its rate limit.
  if (result.user) {
    const recent = await sql`
      SELECT COUNT(*)::int AS n FROM portal_login_tokens
       WHERE portal_user_id = ${result.user.id} AND purpose = 'magic_link'
         AND created_at > NOW() - INTERVAL '10 minutes'
    `;
    if ((recent[0]?.n || 0) < MAGIC_SENDS_PER_10MIN) {
      const raw = await issueLoginToken(result.user.id, 'magic_link', 15);
      const loginUrl = `${PORTAL_URL}?login=${encodeURIComponent(raw)}`;
      try {
        await sendMail({
          to: result.user.email,
          subject: landing.subject,
          html: landing.html({ name: result.user.name, loginUrl, returning: true }),
          text: landing.textReturning(loginUrl),
        });
      } catch (err) { console.warn(`[${source}] returning-user email failed`, err.message); }
    }
  }
  return res.status(200).json({ ok: true, next: 'email', to: landing.to });
}

// ═════════════════════════ auth ═════════════════════════
async function authRoutes(req, res) {
  const op = req.query.op || null;

  // GET auth?op=invite-info&token= — minimal prefill for the accept screen.
  if (req.method === 'GET' && op === 'invite-info') {
    const raw = req.query.token ? String(req.query.token) : '';
    if (!raw) return res.status(400).json({ error: 'token required' });
    const rows = await sql`
      SELECT i.email, i.company_id, i.prefill, i.expires_at, i.accepted_at, i.revoked_at, c.name AS company_name
        FROM portal_invites i JOIN companies c ON c.id = i.company_id
       WHERE i.token_hash = ${hashToken(raw)}
    `;
    const inv = rows[0];
    if (!inv || inv.revoked_at || new Date(inv.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This invite link is no longer valid. Ask your Squideo contact to resend it.' });
    }
    if (inv.accepted_at) {
      return res.status(409).json({ error: 'already_accepted', email: inv.email });
    }
    const existing = await sql`SELECT 1 FROM portal_users WHERE email = ${inv.email}`;
    return res.status(200).json({
      email: inv.email,
      companyName: inv.company_name,
      // The invite token is what tells us whose portal this is, so the accept
      // screen is the one pre-auth screen that can brand itself properly.
      logoUrl: (await companyHasLogo(inv.company_id)) ? portalLogoPath(inv.company_id) : null,
      prefill: inv.prefill || {},
      existingAccount: existing.length > 0,
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = await readJsonBody(req);
  const bodyOp = op || body.op;

  // ── accept-invite ──
  if (bodyOp === 'accept-invite') {
    const raw = trimOrNull(body.token);
    if (!raw) return res.status(400).json({ error: 'token required' });

    // Atomic consume — a second accept with the same link loses here.
    const consumed = await sql`
      UPDATE portal_invites SET accepted_at = NOW()
       WHERE token_hash = ${hashToken(raw)}
         AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
      RETURNING id, email, company_id, prefill, invited_by
    `;
    const inv = consumed[0];
    if (!inv) return res.status(400).json({ error: 'This invite link is no longer valid. Ask your Squideo contact to resend it.' });

    let user = await loadPortalUser(inv.email);
    if (user?.disabled_at) return res.status(403).json({ error: 'This account has been disabled. Contact Squideo to restore access.' });

    if (!user) {
      const password = String(body.password || '');
      if (password.length < MIN_PASSWORD_LENGTH) {
        // Un-consume so they can retry with a valid password.
        await sql`UPDATE portal_invites SET accepted_at = NULL WHERE id = ${inv.id}`;
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      const prefill = inv.prefill || {};
      const name = trimOrNull(body.name) || trimOrNull(prefill.name);
      const phone = trimOrNull(body.phone) || trimOrNull(prefill.phone);
      const jobTitle = trimOrNull(body.jobTitle) || trimOrNull(prefill.jobTitle);
      const contactRows = await sql`
        SELECT id FROM contacts WHERE LOWER(email) = ${inv.email} ORDER BY created_at ASC LIMIT 1
      `;
      const id = makeId('pu');
      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
      await sql`
        INSERT INTO portal_users (id, email, name, phone, job_title, password_hash, contact_id)
        VALUES (${id}, ${inv.email}, ${name}, ${phone}, ${jobTitle}, ${passwordHash}, ${contactRows[0]?.id || null})
      `;
      user = await loadPortalUser(inv.email);
    }

    await sql`
      INSERT INTO portal_memberships (portal_user_id, company_id, invited_by)
      VALUES (${user.id}, ${inv.company_id}, ${inv.invited_by})
      ON CONFLICT (portal_user_id, company_id) DO UPDATE SET disabled_at = NULL
    `;
    await issuePortalSession(res, user, req);

    // Seed the new member's own notification feed with whatever is already
    // waiting on them, so the bell is useful on first login — tasks and reviews
    // that "came in" before they accepted (a pending invitee gets no feed rows).
    // Targeted at this user only, best-effort.
    try {
      const openDeals = await sql`SELECT * FROM deals WHERE company_id = ${inv.company_id} AND stage IN ('signed', 'paid')`;
      if (openDeals.length) {
        const states = await gatherDealStates(openDeals.map((d) => d.id));
        for (const deal of openDeals) {
          // No "you have N tasks" row: outstanding tasks are read live into the
          // bell's own Tasks section, one per line, so a stored summary of them
          // would say the same thing worse and go stale the moment one is done.
          const sb = states.sbPending.get(deal.id);
          if (sb) await notifyPortalUser({
            portalUserId: user.id, companyId: inv.company_id, dealId: deal.id,
            key: 'portal.storyboard_ready', title: 'Your storyboard is ready to review',
            body: `A storyboard on ${deal.title} is ready for your feedback.`,
            link: portalReviewLinkFor('storyboard', sb.shareToken, sb.storyboardId),
          });
          const rv = states.revPending.get(deal.id);
          if (rv) await notifyPortalUser({
            portalUserId: user.id, companyId: inv.company_id, dealId: deal.id,
            key: 'portal.revision_ready', title: 'Your video is ready to review',
            body: `A video on ${deal.title} is ready for your feedback.`,
            link: portalReviewLinkFor('video', rv.shareToken, rv.videoId),
          });
        }
      }
    } catch (err) {
      console.warn('[portal] seed join notifications failed', err.message);
    }

    // Alert the team (best-effort).
    try {
      await ensurePortalNotificationDefaults();
      const [co] = await sql`SELECT name FROM companies WHERE id = ${inv.company_id}`;
      await sendNotification('portal.member_joined', {
        subject: `👋 ${user.name || user.email} joined the client portal`,
        text: `${user.name || user.email} (${user.email}) set up portal access for ${co?.name || 'a client organisation'}.`,
        inApp: {
          title: `${user.name || user.email} joined the client portal`,
          body: co?.name || user.email,
          link: `#/company/${inv.company_id}`,
        },
        // Deliberately NOT inAppOnly: accepting an invite is one of the few
        // portal events worth being told about wherever you are, so it honours
        // each person's in-app/email/both preference rather than forcing the bell.
      });
    } catch (err) {
      console.warn('[portal] member_joined notify failed', err.message);
    }

    const memberships = await sql`
      SELECT m.company_id AS id, c.name FROM portal_memberships m
      JOIN companies c ON c.id = m.company_id
      WHERE m.portal_user_id = ${user.id} AND m.disabled_at IS NULL
    `;
    return res.status(200).json({ user: publicPortalUser(user, memberships) });
  }

  // ── login ──
  if (bodyOp === 'login') {
    const email = lowerOrNull(body.email);
    const password = String(body.password || '');
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const ip = clientIp(req);
    if (await isLoginLocked(email, ip)) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in 10 minutes, or use an email sign-in link.' });
    }
    const user = await loadPortalUser(email);
    if (!user || !user.password_hash) {
      await bcrypt.compare(password, dummyPasswordHash());
      await recordFailedLogin(email, ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      await recordFailedLogin(email, ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.disabled_at) return res.status(403).json({ error: 'This account has been disabled. Contact Squideo to restore access.' });
    await clearFailedLogins(email, ip);
    await issuePortalSession(res, user, req);
    return res.status(200).json({ user: publicPortalUser(user) });
  }

  // ── self-serve signup ── the ONLY account creation in the product without an
  // invite. One handler, one lead magnet per op — see selfServeSignup below.
  if (bodyOp === 'course-signup' || bodyOp === 'brief-signup') {
    return selfServeSignup(req, res, body, bodyOp === 'brief-signup' ? 'brief' : 'course');
  }

  // ── magic-request ── (always 200: no account enumeration)
  if (bodyOp === 'magic-request') {
    const email = lowerOrNull(body.email);
    const ok = () => res.status(200).json({ ok: true, message: 'If that email has a portal account, a sign-in link is on its way.' });
    if (!email) return ok();
    const user = await loadPortalUser(email);
    if (!user || user.disabled_at) return ok();
    const recent = await sql`
      SELECT COUNT(*)::int AS n FROM portal_login_tokens
       WHERE portal_user_id = ${user.id} AND purpose = 'magic_link'
         AND created_at > NOW() - INTERVAL '10 minutes'
    `;
    if ((recent[0]?.n || 0) >= MAGIC_SENDS_PER_10MIN) return ok();
    const raw = await issueLoginToken(user.id, 'magic_link', 15);
    const loginUrl = `${PORTAL_URL}?login=${encodeURIComponent(raw)}`;
    const logoUrl = await emailLogoUrl(await primaryCompanyId(user.id));
    await sendMail({
      to: email,
      subject: 'Your Squideo portal sign-in link',
      html: portalMagicLinkHtml({ loginUrl, logoUrl }),
      text: `Sign in to your Squideo Client Portal (link works once, expires in 15 minutes): ${loginUrl}`,
    });
    return ok();
  }

  // ── magic-consume ──
  if (bodyOp === 'magic-consume') {
    const puid = await consumeLoginToken(body.token, 'magic_link');
    if (!puid) return res.status(400).json({ error: 'This sign-in link has expired or already been used. Request a new one.' });
    const rows = await sql`SELECT id, email, name, phone, job_title, token_version, disabled_at FROM portal_users WHERE id = ${puid}`;
    const user = rows[0];
    if (!user || user.disabled_at) return res.status(403).json({ error: 'This account has been disabled. Contact Squideo to restore access.' });
    await issuePortalSession(res, user, req);
    return res.status(200).json({ user: publicPortalUser(user) });
  }

  // ── reset-request ── (always 200)
  if (bodyOp === 'reset-request') {
    const email = lowerOrNull(body.email);
    const ok = () => res.status(200).json({ ok: true, message: 'If that email has a portal account, a reset link is on its way.' });
    if (!email) return ok();
    const user = await loadPortalUser(email);
    if (!user || user.disabled_at) return ok();
    const recent = await sql`
      SELECT COUNT(*)::int AS n FROM portal_login_tokens
       WHERE portal_user_id = ${user.id} AND purpose = 'password_reset'
         AND created_at > NOW() - INTERVAL '10 minutes'
    `;
    if ((recent[0]?.n || 0) >= MAGIC_SENDS_PER_10MIN) return ok();
    const raw = await issueLoginToken(user.id, 'password_reset', 60);
    const resetUrl = `${PORTAL_URL}?reset=${encodeURIComponent(raw)}`;
    const logoUrl = await emailLogoUrl(await primaryCompanyId(user.id));
    await sendMail({
      to: email,
      subject: 'Reset your Squideo portal password',
      html: portalResetHtml({ resetUrl, logoUrl }),
      text: `Choose a new Squideo Client Portal password (link works once, expires in 60 minutes): ${resetUrl}`,
    });
    return ok();
  }

  // ── reset-consume ──
  if (bodyOp === 'reset-consume') {
    const password = String(body.password || '');
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    const puid = await consumeLoginToken(body.token, 'password_reset');
    if (!puid) return res.status(400).json({ error: 'This reset link has expired or already been used. Request a new one.' });
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    // Bump token_version: a password reset is a security event, so every other
    // session dies; the fresh session below carries the new version.
    const rows = await sql`
      UPDATE portal_users
         SET password_hash = ${passwordHash}, token_version = token_version + 1
       WHERE id = ${puid} AND disabled_at IS NULL
      RETURNING id, email, name, phone, job_title, token_version
    `;
    const user = rows[0];
    if (!user) return res.status(403).json({ error: 'This account has been disabled. Contact Squideo to restore access.' });
    await issuePortalSession(res, user, req);
    return res.status(200).json({ user: publicPortalUser(user) });
  }

  // ── logout ──
  if (bodyOp === 'logout') {
    appendSetCookie(res, clearPortalCookieHeader());
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown auth operation' });
}

// ═════════════════════════ me ═════════════════════════
async function meRoutes(req, res, user) {
  if (req.method === 'GET') {
    // Whether the sample project has anything in it. The nav advertises it to
    // everyone with a badge, so it has to know — a badged section that opens on
    // "coming shortly" is worse than no section at all. One cheap read on a
    // request that's already talking to the database, and a failure reads as
    // "not available" rather than 500ing the whole session.
    const [demoCfg] = await sql`SELECT demo_project FROM settings WHERE id = 1`.catch(() => []);
    const demo = demoCfg?.demo_project || {};
    return res.status(200).json({
      user: publicPortalUser(user, user.companies),
      sampleProject: { available: !!(demo.videoUrl || demo.storyboardPdfUrl) },
      preview: user.isPreview
        ? {
          company: user.companies[0] || null,
          manage: user.canManage === true,
          staffEmail: user.previewBy || null,
        }
        : null,
    });
  }
  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    const name = 'name' in body ? trimOrNull(body.name) : user.name;
    const phone = 'phone' in body ? trimOrNull(body.phone) : user.phone;
    const jobTitle = 'jobTitle' in body ? trimOrNull(body.jobTitle) : user.jobTitle;
    await sql`
      UPDATE portal_users SET name = ${name}, phone = ${phone}, job_title = ${jobTitle}
       WHERE id = ${user.puid}
    `;

    if (body.newPassword) {
      const newPassword = String(body.newPassword);
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      const [row] = await sql`SELECT password_hash FROM portal_users WHERE id = ${user.puid}`;
      if (row?.password_hash) {
        const valid = await bcrypt.compare(String(body.currentPassword || ''), row.password_hash);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
      }
      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
      const updated = await sql`
        UPDATE portal_users
           SET password_hash = ${passwordHash}, token_version = token_version + 1
         WHERE id = ${user.puid}
        RETURNING id, email, name, phone, job_title, token_version
      `;
      await issuePortalSession(res, updated[0]); // re-issue so THIS session survives the bump
    }
    return res.status(200).json({ ok: true, user: { ...publicPortalUser(user, user.companies), name, phone, jobTitle } });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

// ═════════════════════════ overview ═════════════════════════
async function overviewRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;

  const deals = await sql`
    SELECT d.id, d.title, d.company_id, d.stage, d.payment_terms, d.po_number,
           d.production_phase, d.production_stage, d.delivery_deadline,
           d.client_tasks_launched_at, d.script_status,
           d.portal_extras_discount, d.created_at, c.name AS company_name
      FROM deals d JOIN companies c ON c.id = d.company_id
     WHERE d.company_id = ${companyId}
       AND d.stage IN ('proposal_sent', 'viewed', 'signed', 'paid')
     ORDER BY d.created_at DESC
  `;
  const states = await gatherDealStates(deals.map((d) => d.id));
  await ensureDealExtrasTable();

  const projects = [];
  for (const deal of deals) {
    const rawVideos = states.videos.get(deal.id) || [];
    const nextStep = nextStepFor(deal, states);
    const videos = rawVideos.map(serialisePortalVideo);
    const offers = extrasWindowOpen(deal) ? await computePortalOffers(deal) : [];
    const tasks = tasksFor(deal, states);
    projects.push(serialisePortalDeal(deal, {
      nextStep,
      videos,
      tasks,
      openTasks: countOpenTasks(tasks),
      extrasAvailable: offers.length,
      // Live board position = least-advanced video (see serialisePortalDeal).
      projectProduction: aggregateVideoStage(rawVideos),
    }));
  }

  const [brandCount] = await sql`
    SELECT COUNT(*)::int AS n FROM portal_company_files WHERE company_id = ${companyId}
  `;
  const actionNeeded = projects.filter((p) => p.nextStep?.court === 'you').length;

  // An unfinished brief, so the dashboard can offer to pick it up. Read-only on
  // purpose — the brief route CREATES a draft on GET, and calling that from the
  // dashboard would mark every visitor as having started one, turning a real
  // sales signal into noise.
  const [draft] = await sql`
    SELECT id, answers, updated_at FROM client_briefs
     WHERE portal_user_id = ${user.puid} AND submitted_at IS NULL
       AND answers <> '{}'::jsonb
     LIMIT 1
  `.catch(() => []);

  // Credit is the rung AFTER a first project, so the dashboard only offers it
  // to a client who has one and hasn't already bought any. `creditVisible` is
  // the same rule the nav and CLIENT_ONLY use, so the nudge can never appear
  // for someone who has no credit page to nudge them to.
  const activeCo = user.companies.find((c) => c.id === companyId) || null;
  let suggestCredit = false;
  if (activeCo?.creditVisible !== false && projects.length > 0) {
    const bal = await companyCreditBalance(activeCo || { id: companyId }).catch(() => null);
    suggestCredit = (bal?.issued || 0) === 0;
  }

  return res.status(200).json({
    company: user.companies.find((c) => c.id === companyId) || { id: companyId },
    companies: user.companies,
    projects,
    actionNeeded,
    suggestCredit,
    brandFileCount: brandCount?.n || 0,
    briefDraft: draft ? {
      id: draft.id,
      updatedAt: draft.updated_at,
      projectName: (draft.answers || {}).projectName || null,
      ...briefProgress(draft.answers || {}),
    } : null,
  });
}

// ═════════════════════════ project ═════════════════════════
async function projectRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const deal = await requireDealInOrg(res, req.query.dealId ? String(req.query.dealId) : null, user.companyIds);
  if (!deal) return;

  const states = await gatherDealStates([deal.id]);
  const prop = states.proposals.get(deal.id) || null;

  // General project documents. Script / visual-direction uploads are filed
  // under their own stage (#/script/<dealId>), so they're kept out of this list
  // rather than appearing twice.
  const files = await sql`
    SELECT id, filename, mime_type, size_bytes, portal_user_id, created_at
      FROM deal_files
     WHERE deal_id = ${deal.id} AND source = 'portal'
       AND (category IS NULL OR category NOT IN ('script', 'visual_direction'))
     ORDER BY created_at DESC
  `.catch(() => []);

  await ensureDealExtrasTable();
  const extras = await sql`
    SELECT id, description, amount, status, created_at
      FROM deal_extras WHERE deal_id = ${deal.id} AND source = 'portal'
     ORDER BY created_at DESC
  `;
  const offers = extrasWindowOpen(deal) ? await computePortalOffers(deal) : [];

  const rawVideos = states.videos.get(deal.id) || [];
  // Whether the signed-off video may be downloaded (deal paid in full or a staff
  // override) — gates the approved review-cut download below. Best-effort.
  let finalReleaseUnlocked = false;
  try { finalReleaseUnlocked = await isFinalReleaseUnlocked(deal.id); } catch { finalReleaseUnlocked = false; }
  // Final delivery: once unlocked, a signed-off video is delivered → advance it
  // to the Completed phase so the client's bar moves off "In production". Mutate
  // the in-memory rows too so this same response reflects it.
  if (finalReleaseUnlocked) {
    try {
      const advanced = await advanceDeliveredIfUnlocked(deal.id, true);
      if (advanced > 0) {
        for (const v of rawVideos) {
          if (v.production_stage === 'signed_off' || v.production_stage === 'final_invoice') {
            v.production_phase = 'completed';
            v.production_stage = 'delivered';
          }
        }
      }
    } catch { /* best-effort */ }
  }
  // Compute the banner AFTER the delivery advance above so a just-delivered
  // video's project reads "Your video is ready 🎉", not the stale in-production
  // state (nextStepFor derives from the aggregated video stage).
  const nextStep = nextStepFor(deal, states);
  return res.status(200).json({
    project: serialisePortalDeal(deal, {
      nextStep,
      tasks: tasksFor(deal, states),
      projectProduction: aggregateVideoStage(rawVideos),
      finalReleaseUnlocked,
      // The project-wide timeline, shown only when no video carries its own —
      // see ProjectSchedule in the portal. A multi-video project schedules per
      // video; a single-video one is often scheduled from the deal page.
      schedule: clientSchedule(deal.production_schedule),
      videos: rawVideos.map(serialisePortalVideo),
      proposal: prop ? { id: prop.id, signed: !!prop.signature } : null,
      reviews: states.revLinks.get(deal.id) || [],
      storyboards: states.sbLinks.get(deal.id) || [],
      files: files.map(serialisePortalDealFile),
      extras: extras.map(serialisePortalExtra),
      extrasAvailable: offers.length,
      extrasWindowOpen: extrasWindowOpen(deal),
    }),
  });
}

// ═════════════════════════ library ═════════════════════════
async function libraryRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;

  const deals = await sql`
    SELECT id, title, drive_folder_id, production_phase, production_stage, created_at
      FROM deals
     WHERE company_id = ${companyId} AND stage IN ('signed', 'paid')
     ORDER BY created_at DESC
  `;
  const dealIds = deals.map((d) => d.id);

  // 0. Past work added by staff in manage mode — the back catalogue we made for
  // this client before the portal (or before this deal) existed. Company-scoped,
  // so it shows even for an org with no signed deals at all.
  const archiveRows = await sql`
    SELECT id, deal_id, series, title, filename, mime_type, size_bytes, created_at,
           (poster IS NOT NULL) AS has_poster, poster_updated_at
      FROM portal_library_items
     WHERE company_id = ${companyId}
     ORDER BY sort_order ASC NULLS LAST, created_at DESC
  `.catch(() => []);
  const archiveByDeal = new Map();
  const archiveBySeries = new Map();
  const archiveLoose = [];
  for (const a of archiveRows) {
    const entry = {
      kind: 'archive',
      itemId: a.id,
      name: a.title || a.filename || 'Video',
      series: a.series || null,
      dealId: a.deal_id || null,
      mimeType: a.mime_type || null,
      sizeBytes: a.size_bytes != null ? Number(a.size_bytes) : null,
      createdTime: a.created_at,
      // The poster is served as bytes (scope=poster) rather than inlined — a
      // shelf of base64 JPEGs would be megabytes of JSON. posterVersion is the
      // cache key, so a re-chosen frame isn't served from cache.
      posterVersion: a.has_poster
        ? (a.poster_updated_at ? new Date(a.poster_updated_at).getTime() : 1)
        : null,
    };
    // A series is how the client thinks about a run of videos, so it wins over
    // the project link. Failing that it joins one of their live projects, and
    // failing that it lands in "Previous work".
    if (a.series) {
      if (!archiveBySeries.has(a.series)) archiveBySeries.set(a.series, []);
      archiveBySeries.get(a.series).push(entry);
    } else if (a.deal_id && dealIds.includes(a.deal_id)) {
      if (!archiveByDeal.has(a.deal_id)) archiveByDeal.set(a.deal_id, []);
      archiveByDeal.get(a.deal_id).push(entry);
    } else {
      archiveLoose.push(entry);
    }
  }
  // Series groups sit between the live projects and the loose back catalogue.
  const seriesGroups = [...archiveBySeries.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, files]) => ({ dealId: null, series: name, title: name, createdAt: null, files }));
  const looseGroup = archiveLoose.length
    ? [{ dealId: null, series: null, title: 'Previous work', createdAt: null, files: archiveLoose }]
    : [];
  // Every series we hold, so the manage-mode form can offer them for reuse
  // rather than relying on staff retyping a name identically.
  const allSeries = [...archiveBySeries.keys()].sort((a, b) => a.localeCompare(b));

  if (!dealIds.length) {
    return res.status(200).json({
      projects: [...seriesGroups, ...looseGroup],
      ...(user.canManage ? { allProjects: [], allSeries } : {}),
    });
  }

  // 1. Delivered review cuts — the approved final cut the client reviewed. A
  // video only reaches 'delivered' once the deal is paid in full (or a staff
  // override is set), so surfacing it here is already consistent with the
  // payment gate; no extra balance check (and no Xero call) is needed. This is
  // what makes a just-delivered video appear in the library even before anyone
  // has placed a render in the Drive "Signed Off" folder.
  const cutRows = await sql`
    SELECT pv.id AS video_id, pv.deal_id, pv.title,
           rver.filename, rver.size_bytes, rver.mime_type, rver.created_at
      FROM project_videos pv
      JOIN LATERAL (
        SELECT filename, size_bytes, mime_type, created_at
          FROM revision_versions
         WHERE video_id = pv.revision_video_id AND blob_url IS NOT NULL
         ORDER BY version_number DESC, created_at DESC
         LIMIT 1
      ) rver ON true
     WHERE pv.deal_id = ANY(${dealIds})
       AND pv.production_stage = 'delivered'
       AND pv.revision_video_id IS NOT NULL
  `.catch(() => []);
  const cutsByDeal = new Map();
  for (const c of cutRows) {
    if (!cutsByDeal.has(c.deal_id)) cutsByDeal.set(c.deal_id, []);
    cutsByDeal.get(c.deal_id).push({
      kind: 'cut',
      videoId: c.video_id,
      name: c.title || c.filename || 'Final video',
      mimeType: c.mime_type || null,
      sizeBytes: c.size_bytes != null ? Number(c.size_bytes) : null,
      createdTime: c.created_at,
    });
  }

  // 2. Drive "Signed Off" files — final renders the team places in Drive.
  const withDrive = deals.filter((d) => d.drive_folder_id);
  const driveByDeal = new Map();
  let driveUnavailable = false;
  if (withDrive.length) {
    const token = await anyDriveAccessToken();
    if (!token) {
      driveUnavailable = true;
    } else {
      await Promise.all(withDrive.map(async (d) => {
        const files = await listSignedOffFiles(token, d.drive_folder_id).catch(() => []);
        if (files.length) {
          driveByDeal.set(d.id, files.map((f) => ({
            kind: 'drive',
            // Opaque per-request id; re-validated against a fresh org-scoped
            // listing at download time (never trusted as a raw Drive capability).
            fileId: f.driveFileId,
            name: f.name,
            mimeType: f.mimeType,
            sizeBytes: f.sizeBytes,
            createdTime: f.createdTime,
          })));
        }
      }));
    }
  }

  const projects = deals
    .map((d) => ({
      dealId: d.id,
      title: d.title,
      createdAt: d.created_at,
      files: [
        ...(cutsByDeal.get(d.id) || []),
        ...(driveByDeal.get(d.id) || []),
        ...(archiveByDeal.get(d.id) || []),
      ],
    }))
    .filter((p) => p.files.length > 0);
  projects.push(...seriesGroups, ...looseGroup);

  // Only flag "unavailable" when Drive is the sole reason there's nothing to
  // show — if we surfaced any cuts, the library isn't empty.
  return res.status(200).json({
    projects,
    ...(driveUnavailable && projects.length === 0 ? { unavailable: true } : {}),
    // Manage mode files an upload against a project — the picker needs every
    // project, not just the ones that already have something in the library.
    ...(user.canManage ? { allProjects: deals.map((d) => ({ id: d.id, title: d.title })), allSeries } : {}),
  });
}

// ═══════════════ library: past work added in manage mode ═══════════════
// Staff-only (a manage-mode preview session). Videos are large, so the browser
// streams them straight to Blob storage with a short-lived client token — the
// same bypass the CRM uses for revision drafts — and only the resulting URL
// comes back here to be recorded.
// A 960px-wide JPEG frame lands around 100 KB; the cap is headroom, not a target.
const MAX_POSTER_BYTES = 1024 * 1024;
const POSTER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function requireManage(res, user, message = 'Only Squideo staff can add to the library.') {
  if (!user.canManage) {
    res.status(403).json({ error: message });
    return false;
  }
  return true;
}

async function libraryUploadTokenRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireManage(res, user)) return;
  if (!REVISION_BLOB_TOKEN) return res.status(503).json({ error: 'Video storage not configured (REVISION_BLOB_READ_WRITE_TOKEN missing)' });
  const body = await readJsonBody(req);
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      token: REVISION_BLOB_TOKEN,
      // Authorisation already happened above (a manage token, scoped to this
      // org). Deliberately no onUploadCompleted — see api/revisions/[action].js:
      // it makes the Blob API wait for a server callback that never lands in dev
      // and adds a fragile round-trip in prod. The row is written by the
      // library-item POST as soon as upload() resolves.
      onBeforeGenerateToken: async () => ({ addRandomSuffix: true }),
    });
    return res.status(200).json(jsonResponse);
  } catch (err) {
    if (res.headersSent) return;
    return res.status(400).json({ error: err?.message || 'Upload authorisation failed' });
  }
}

async function libraryItemRoute(req, res, user) {
  if (!requireManage(res, user)) return;
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const blobUrl = trimOrNull(body.blobUrl);
    if (!blobUrl) return res.status(400).json({ error: 'blobUrl required' });
    const filename = trimOrNull(body.filename) || 'video.mp4';
    const title = trimOrNull(body.title) || filename.replace(/\.[^.]+$/, '');
    // A deal id is optional — file it against one of their projects when we know
    // which, else it lands in "Previous work". Cross-org ids are ignored rather
    // than rejected: the upload has already happened, losing it would be worse.
    let dealId = trimOrNull(body.dealId);
    if (dealId) {
      const [ok] = await sql`SELECT id FROM deals WHERE id = ${dealId} AND company_id = ${companyId}`;
      if (!ok) dealId = null;
    }
    const id = makeId('pli');
    await sql`
      INSERT INTO portal_library_items
        (id, company_id, deal_id, series, title, filename, mime_type, size_bytes, blob_url, blob_pathname, created_by)
      VALUES (${id}, ${companyId}, ${dealId}, ${trimOrNull(body.series)}, ${title}, ${filename},
              ${trimOrNull(body.mimeType)}, ${Number.isFinite(Number(body.sizeBytes)) ? Number(body.sizeBytes) : null},
              ${blobUrl}, ${trimOrNull(body.blobPathname)}, ${user.previewBy || null})
    `;
    return res.status(201).json({ id });
  }

  // Retitle / regroup an item already in the library. Without this a mistyped
  // series would mean deleting and re-uploading the whole video.
  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    const id = trimOrNull(body.id) || (req.query.id ? String(req.query.id) : null);
    if (!id) return res.status(400).json({ error: 'id required' });
    const [cur] = await sql`
      SELECT id, title, series, deal_id FROM portal_library_items
       WHERE id = ${id} AND company_id = ${companyId}
    `;
    if (!cur) return res.status(404).json({ error: 'Not found' });

    // A thumbnail captured from a frame of the video, or null to clear it.
    // Handled on its own so the picker doesn't have to resend title/series.
    if ('poster' in body) {
      const raw = body.poster;
      let value = null;
      if (raw) {
        const img = decodeLogo(raw);
        // Raster only. A poster is always canvas output, and accepting SVG here
        // would let a script-bearing image be served from our own origin.
        if (!img || !POSTER_TYPES.has(img.contentType)) {
          return res.status(400).json({ error: 'That frame could not be read as an image.' });
        }
        if (img.bytes.length > MAX_POSTER_BYTES) return res.status(413).json({ error: 'That frame is too large — try a smaller capture.' });
        value = String(raw);
      }
      await sql`
        UPDATE portal_library_items
           SET poster = ${value}, poster_updated_at = ${value ? new Date().toISOString() : null}
         WHERE id = ${id} AND company_id = ${companyId}
      `;
      if (!('title' in body) && !('series' in body) && !('dealId' in body)) {
        return res.status(200).json({ ok: true });
      }
    }

    const title = 'title' in body ? (trimOrNull(body.title) || cur.title) : cur.title;
    const series = 'series' in body ? trimOrNull(body.series) : cur.series;
    let dealId = 'dealId' in body ? trimOrNull(body.dealId) : cur.deal_id;
    if (dealId && dealId !== cur.deal_id) {
      const [ok] = await sql`SELECT id FROM deals WHERE id = ${dealId} AND company_id = ${companyId}`;
      if (!ok) dealId = null;
    }
    await sql`
      UPDATE portal_library_items
         SET title = ${title}, series = ${series}, deal_id = ${dealId}
       WHERE id = ${id} AND company_id = ${companyId}
    `;
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const id = req.query.id ? String(req.query.id) : null;
    if (!id) return res.status(400).json({ error: 'id required' });
    const rows = await sql`
      DELETE FROM portal_library_items
       WHERE id = ${id} AND company_id = ${companyId}
      RETURNING blob_url
    `;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].blob_url) {
      try { await del(rows[0].blob_url, { token: REVISION_BLOB_TOKEN }); }
      catch (err) { console.warn('[portal] library blob delete failed', err.message); }
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Set the running order of a library group. Takes the full ordered list of ids
// and stamps 0..n-1 across them in one transaction, so a group is never left
// half-ordered (which is why the client sends the whole group, not a swap).
async function libraryReorderRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireManage(res, user)) return;
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;
  const body = await readJsonBody(req);
  const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x)).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  if (ids.length > 500) return res.status(400).json({ error: 'Too many items' });
  // company_id in the WHERE is the org check — a foreign id simply updates
  // nothing rather than leaking whether it exists.
  await batchWrite(ids.map((id, i) => sql`
    UPDATE portal_library_items SET sort_order = ${i}
     WHERE id = ${id} AND company_id = ${companyId}
  `));
  return res.status(200).json({ ok: true });
}

// ═══════════════ the client's logo (manage mode) ═══════════════
// Same `companies.logo` the CRM's organisation page writes — this is the second
// door onto it, so staff already inside the client's portal don't have to go
// back to the CRM to fix the branding they're looking at.
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

async function companyLogoRoute(req, res, user) {
  if (!requireManage(res, user)) return;
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;
  await ensureCompanyLogoColumns().catch(() => {});

  if (req.method === 'GET') {
    const [row] = await sql`
      SELECT logo, logo_updated_at, logo_updated_by FROM companies WHERE id = ${companyId}
    `;
    if (!row) return res.status(404).json({ error: 'Organisation not found' });
    return res.status(200).json({
      logo: row.logo || null,
      updatedAt: row.logo_updated_at || null,
      updatedBy: row.logo_updated_by || null,
    });
  }

  // POST { logo } — a base64 image data URL (what LogoUploader produces), or
  // null/'' to remove it. Stored as NULL when absent so the has_logo checks stay
  // a cheap IS NOT NULL that never detoasts the value.
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const raw = body.logo;
    const clearing = raw === null || raw === undefined || raw === '';
    let value = null;
    if (!clearing) {
      const decoded = decodeLogo(raw);
      if (!decoded) return res.status(400).json({ error: 'That doesn’t look like an image — upload a PNG, JPG, SVG or WEBP.' });
      if (decoded.bytes.length > MAX_LOGO_BYTES) return res.status(413).json({ error: 'Logo too large — keep it under 2 MB.' });
      value = String(raw);
    }
    const [row] = await sql`
      UPDATE companies
         SET logo = ${value},
             logo_updated_at = ${value ? new Date().toISOString() : null},
             logo_updated_by = ${value ? (user.previewBy || null) : null},
             updated_at = NOW()
       WHERE id = ${companyId}
      RETURNING id, (logo IS NOT NULL) AS has_logo, logo_updated_at
    `;
    if (!row) return res.status(404).json({ error: 'Organisation not found' });
    return res.status(200).json({ ok: true, hasLogo: !!row.has_logo, updatedAt: row.logo_updated_at || null });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ═══════════════════ review-cut download (gated) ═══════════════════
// The client can download the signed-off draft video once (a) they've approved
// it in the review flow AND (b) the deal is paid in full (or staff overrode).
// Streams the latest revision-version blob for the video.
async function reviewDownloadRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const videoId = req.query.videoId ? String(req.query.videoId) : null;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  // Resolve the revision video → its project → the owning deal/company, and
  // enforce org membership (a cross-org id 404s — no existence oracle).
  const [rv] = await sql`
    SELECT rv.approved_at, rp.deal_id, d.company_id
      FROM revision_videos rv
      JOIN revision_projects rp ON rp.id = rv.project_id
      JOIN deals d ON d.id = rp.deal_id
     WHERE rv.id = ${videoId}
  `.catch(() => []);
  if (!rv || !rv.company_id || !user.companyIds.includes(rv.company_id)) {
    return res.status(404).json({ error: 'Video not found' });
  }
  if (!rv.approved_at) {
    return res.status(403).json({ error: 'Approve this video in the review first, then it can be downloaded.' });
  }
  // Payment gate: paid in full, or a staff release override.
  const unlocked = await isFinalReleaseUnlocked(rv.deal_id).catch(() => false);
  if (!unlocked) {
    return res.status(402).json({ error: 'Your final invoice needs to be settled before the finished video can be downloaded.' });
  }

  const [ver] = await sql`
    SELECT blob_url, filename FROM revision_versions
     WHERE video_id = ${videoId} AND blob_url IS NOT NULL
     ORDER BY version_number DESC, created_at DESC LIMIT 1
  `.catch(() => []);
  if (!ver || !ver.blob_url) return res.status(404).json({ error: 'No downloadable file yet' });

  // Revision cuts live in the public revision blob store — a 302 to the
  // unguessable URL is sufficient once the gate above has passed.
  res.setHeader('Location', ver.blob_url);
  return res.status(302).end();
}

// ═════════════════════════ download ═════════════════════════
// Blob-store 302. `?download=1` asks Vercel Blob for an attachment disposition
// so the browser saves the file instead of playing it in the tab — without it a
// video URL just navigates away from the portal.
function blobRedirect(res, url, wantDownload) {
  const target = wantDownload ? url + (url.includes('?') ? '&' : '?') + 'download=1' : url;
  res.setHeader('Location', target);
  return res.status(302).end();
}

// streamBlob (the Range-passthrough relay used where a 302 won't do, because a
// canvas capture needs a same-origin video) now lives in api/_lib/blobStream.js
// — Admin → Video guide needs the same thing for its thumbnails.

async function downloadRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const scope = req.query.scope ? String(req.query.scope) : null;
  const id = req.query.id ? String(req.query.id) : null;
  // Every scope names its file with `id` except a delivered cut, which is
  // identified by the project video it belongs to — the library page sends
  // dealId + videoId and no id at all. Requiring `id` here 400'd every cut tile
  // before it reached its branch below: no playback, no download.
  const videoId = req.query.videoId ? String(req.query.videoId) : null;
  const wantDownload = req.query.download === '1';
  if (!scope || (!id && !(scope === 'cut' && videoId))) {
    return res.status(400).json({ error: 'scope and id required' });
  }

  // Worth knowing who actually took delivery, and of what.
  //
  // Only a real download counts. Serving bytes is not the same as someone
  // saving a file: a poster is a thumbnail, stream=1 is the thumbnail picker,
  // inline=1 is a preview — and a 302 to a video the player is simply PLAYING
  // is not a download either. That last one is why every video-guide video
  // used to appear in the log as "Downloaded a file".
  //
  // So each branch below notes its own download once it knows what the file
  // actually is, which is also the only way the log can name it. Best-effort:
  // nothing here is awaited beyond the helper's own catch.
  const noteDownload = (name) => {
    if (!user.puid) return;
    logPortalActivity({
      req, portalUserId: user.puid,
      dealId: trimOrNull(req.query.dealId),
      eventKey: 'download', detail: { scope, name: trimOrNull(name) },
    }).catch(() => {});
  };

  // Past-work item added by staff — org-checked, then streamed from the public
  // revision blob store (same place delivered cuts live).
  if (scope === 'archive') {
    const rows = await sql`
      SELECT blob_url, mime_type, company_id, title, filename FROM portal_library_items WHERE id = ${id}
    `.catch(() => []);
    const item = rows[0];
    if (!item || !item.blob_url || !user.companyIds.includes(item.company_id)) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (wantDownload) noteDownload(item.title || item.filename);
    // stream=1 relays the bytes through us instead of redirecting. Only the
    // thumbnail picker asks for this: drawing a frame onto a canvas taints it
    // unless the video is same-origin, and a redirect to the blob host isn't.
    // Playback and downloads keep the cheap 302.
    if (req.query.stream === '1') {
      return streamBlob(req, res, item.blob_url, item.mime_type || 'video/mp4');
    }
    return blobRedirect(res, item.blob_url, wantDownload);
  }

  // A video-guide video. No org check: the course is the same eight videos for
  // every account, and having ANY live portal session is the entitlement. That
  // is exactly what the signup buys, and it's why this can't live on the public
  // /api/course endpoint, which serves only the free ones.
  if (scope === 'course') {
    const rows = await sql`
      SELECT blob_url, mime_type, title FROM course_modules
       WHERE id = ${id} AND published AND blob_url IS NOT NULL
    `.catch(() => []);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // Nothing logged either way: the course is reported by course_progress, one
    // row per video finished, and the player fetching bytes is not an event.
    return blobRedirect(res, rows[0].blob_url, wantDownload);
  }

  // The thumbnail chosen for a library item — image bytes, org-checked.
  if (scope === 'poster') {
    const rows = await sql`
      SELECT poster, company_id FROM portal_library_items WHERE id = ${id}
    `.catch(() => []);
    const item = rows[0];
    if (!item || !item.poster || !user.companyIds.includes(item.company_id)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const img = decodeLogo(item.poster);
    if (!img || !POSTER_TYPES.has(img.contentType)) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', img.contentType);
    res.setHeader('Content-Length', String(img.bytes.length));
    // The URL carries a version, so this can cache hard.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    // Same lockdown as /api/portal-logo: an image served from our own origin
    // must not be able to do anything if opened directly.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return res.status(200).end(img.bytes);
  }

  // Org/brand documents — streamed, not redirected. These live in the PRIVATE
  // store, where a blob URL in the browser is a 403 no matter how it's dressed
  // up (getDownloadUrl only appends ?download=1; it does not sign anything).
  if (scope === 'company') {
    const rows = await sql`
      SELECT blob_url, mime_type, filename, company_id FROM portal_company_files WHERE id = ${id}
    `;
    const f = rows[0];
    if (!f || !user.companyIds.includes(f.company_id)) return res.status(404).json({ error: 'File not found' });
    noteDownload(f.filename);
    return streamPrivateBlob(res, f.blob_url, { filename: f.filename, mimeType: f.mime_type });
  }

  // Per-project documents (portal uploads on deal_files) — same private store.
  if (scope === 'deal') {
    const rows = await sql`
      SELECT f.blob_url, f.mime_type, f.filename, d.company_id
        FROM deal_files f JOIN deals d ON d.id = f.deal_id
       WHERE f.id = ${id} AND f.source = 'portal'
    `;
    const f = rows[0];
    if (!f || !f.blob_url || !user.companyIds.includes(f.company_id)) return res.status(404).json({ error: 'File not found' });
    noteDownload(f.filename);
    return streamPrivateBlob(res, f.blob_url, { filename: f.filename, mimeType: f.mime_type });
  }

  // Delivered review cut — the approved final cut, streamed from the revision
  // blob store. Gate is the delivery itself: a video is only at 'delivered'
  // once the deal is paid in full (or a staff override is set), so we check the
  // stage rather than re-running the (slow, Xero-hitting) balance check.
  if (scope === 'cut') {
    const deal = await requireDealInOrg(res, req.query.dealId ? String(req.query.dealId) : null, user.companyIds);
    if (!deal) return;
    const cutVideoId = videoId || id;
    const rows = await sql`
      SELECT rver.blob_url, pv.title
        FROM project_videos pv
        JOIN revision_versions rver ON rver.video_id = pv.revision_video_id
       WHERE pv.id = ${cutVideoId} AND pv.deal_id = ${deal.id}
         AND pv.production_stage = 'delivered' AND rver.blob_url IS NOT NULL
       ORDER BY rver.version_number DESC, rver.created_at DESC
       LIMIT 1
    `.catch(() => []);
    const cut = rows[0];
    if (!cut || !cut.blob_url) return res.status(404).json({ error: 'File not found' });
    // Taking delivery of the final cut is the one download that really matters,
    // so it's worth separating from the client merely watching it in the portal.
    if (wantDownload) noteDownload(cut.title || deal.title);
    // Revision cuts live in the public revision blob store — a 302 to the
    // unguessable URL is sufficient once the delivery gate above has passed.
    return blobRedirect(res, cut.blob_url, wantDownload);
  }

  // Library — Drive "Signed Off" file, streamed through us. The file id must
  // appear in a FRESH listing of the deal's own Signed Off folder (org checked
  // first), so a stolen/guessed Drive id for any other file always 404s.
  if (scope === 'library') {
    const deal = await requireDealInOrg(res, req.query.dealId ? String(req.query.dealId) : null, user.companyIds);
    if (!deal) return;
    if (!deal.drive_folder_id) return res.status(404).json({ error: 'File not found' });
    const token = await anyDriveAccessToken();
    if (!token) return res.status(503).json({ error: 'Downloads are temporarily unavailable — try again shortly' });
    const files = await listSignedOffFiles(token, deal.drive_folder_id);
    const file = files.find((f) => f.driveFileId === id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const inline = req.query.inline === '1';
    if (!inline) noteDownload(file.name);
    return streamDriveFile(res, token, file.driveFileId, {
      filename: file.name,
      mimeType: file.mimeType,
      download: !inline,
    });
  }

  return res.status(400).json({ error: 'Unknown scope' });
}

// ═════════════════════════ files ═════════════════════════
// Mints a client-upload token so the browser can send a file STRAIGHT to Blob
// storage instead of through this function.
//
// It has to work that way. A serverless request body is capped at ~4.5MB by the
// platform, well under the 20MB this route claims to accept — and the platform
// rejects the oversized request before any of our code runs, with a non-JSON
// body, so the client saw a bare "Upload failed" with nothing to act on. Brand
// guidelines are routinely a 10MB PDF. Same pattern as the library, revision
// and course uploads, all of which hit this years ago.
//
// Authorised by simply having a portal session: the token only permits writing
// to our own store, and nothing is readable without going through the download
// route, which checks the file's company against the caller's memberships.
async function filesUploadTokenRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'File storage not configured' });
  if (!user.companyIds?.length) return res.status(403).json({ error: 'No organisation' });
  const body = await readJsonBody(req);
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      // No maximumSizeInBytes / allowedContentTypes: either one makes the
      // multipart-create call 400 (see api/revisions/[action].js). The real
      // checks happen at registration, against the blob we can actually see.
      onBeforeGenerateToken: async () => ({ addRandomSuffix: true }),
    });
    return res.status(200).json(jsonResponse);
  } catch (err) {
    if (res.headersSent) return;
    return res.status(400).json({ error: err?.message || 'Upload authorisation failed' });
  }
}

async function filesRoutes(req, res, user) {
  const scope = req.query.scope ? String(req.query.scope) : 'brand';

  if (req.method === 'GET') {
    if (scope === 'deal') {
      const deal = await requireDealInOrg(res, req.query.dealId ? String(req.query.dealId) : null, user.companyIds);
      if (!deal) return;
      const rows = await sql`
        SELECT id, filename, mime_type, size_bytes, portal_user_id, created_at
          FROM deal_files WHERE deal_id = ${deal.id} AND source = 'portal'
         ORDER BY created_at DESC
      `;
      return res.status(200).json({ files: rows.map(serialisePortalDealFile) });
    }
    if (scope === 'script') {
      const deal = await requireDealInOrg(res, req.query.dealId ? String(req.query.dealId) : null, user.companyIds);
      if (!deal) return;
      return res.status(200).json({ files: await scriptFilesFor(deal.id) });
    }
    const companyId = resolveCompanyId(req, res, user);
    if (!companyId) return;
    const rows = await sql`
      SELECT f.id, f.category, f.filename, f.mime_type, f.size_bytes,
             f.uploaded_by_portal_user, f.uploaded_by_staff, f.created_at,
             pu.name AS uploaded_by_name
        FROM portal_company_files f
        LEFT JOIN portal_users pu ON pu.id = f.uploaded_by_portal_user
       WHERE f.company_id = ${companyId}
       ORDER BY f.created_at DESC
    `;
    return res.status(200).json({ files: rows.map(serialisePortalCompanyFile) });
  }

  if (req.method === 'POST') {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'File storage not configured' });

    // Two ways in. A JSON body registers a blob the browser already uploaded
    // direct (the normal path — see filesUploadTokenRoute for why); a raw body
    // is the old in-request upload, kept as the fallback for anything that
    // can't reach Blob storage from the browser.
    const direct = String(req.headers['content-type'] || '').includes('application/json');
    let filename, mimeType, buf = null, uploaded = null, sizeBytes;

    if (direct) {
      const body = await readJsonBody(req);
      filename = trimOrNull(body.filename) || 'upload';
      mimeType = trimOrNull(body.mimeType) || 'application/octet-stream';
      const blobUrl = trimOrNull(body.blobUrl);
      if (!blobUrl) return res.status(400).json({ error: 'No file was uploaded' });
      // head() with OUR token is the ownership check: a URL that isn't in our
      // store throws, so a forged one can't be registered against a company.
      // It's also the only trustworthy size — the browser's number is a claim.
      try {
        uploaded = await head(blobUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
      } catch {
        return res.status(400).json({ error: 'That upload could not be verified — try again.' });
      }
      sizeBytes = Number(uploaded.size) || 0;
    } else {
      filename = decodeURIComponent(req.headers['x-filename'] || 'upload');
      mimeType = req.headers['content-type'] || 'application/octet-stream';
      buf = await readRawBody(req);
      if (!buf.length) return res.status(400).json({ error: 'No file data received' });
      sizeBytes = buf.length;
    }

    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (!UPLOAD_EXTENSIONS.has(ext)) {
      if (uploaded) await del(uploaded.url, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
      return res.status(400).json({ error: `That file type isn't supported (.${ext}). Try a PDF, doc, image or zip.` });
    }
    if (sizeBytes > MAX_FILE_SIZE) {
      if (uploaded) await del(uploaded.url, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
      return res.status(413).json({ error: 'File too large (max 20 MB)' });
    }

    // Deal-scoped documents land on deal_files (source='portal') so they show
    // in the CRM Files card automatically; brand/org docs live on their own table.
    // A script / visual-direction upload is the same row, filed by category so
    // it also lands on the deal's "Script & visual direction" card.
    // (Deal scope only — on the org/brand path `category` means brand|document.)
    const dealCategory = scope === 'deal' && SCRIPT_CATEGORIES.has(String(req.query.category || ''))
      ? String(req.query.category)
      : null;
    let companyId, dealId = null, dealScriptStatus = null;
    if (scope === 'deal') {
      const deal = await requireDealInOrg(res, req.query.dealId ? String(req.query.dealId) : null, user.companyIds);
      if (!deal) return;
      companyId = deal.company_id;
      dealId = deal.id;
      dealScriptStatus = deal.script_status || null;
    } else {
      companyId = resolveCompanyId(req, res, user);
      if (!companyId) return;
    }

    const [uploadsToday] = await sql`
      SELECT (
        (SELECT COUNT(*) FROM portal_company_files WHERE company_id = ${companyId} AND created_at > NOW() - INTERVAL '24 hours')
        +
        (SELECT COUNT(*) FROM deal_files f JOIN deals d ON d.id = f.deal_id
          WHERE d.company_id = ${companyId} AND f.source = 'portal' AND f.created_at > NOW() - INTERVAL '24 hours')
      )::int AS n
    `;
    if ((uploadsToday?.n || 0) >= UPLOADS_PER_DAY_PER_ORG) {
      return res.status(429).json({ error: 'Upload limit reached for today — try again tomorrow or email the files to your producer.' });
    }

    // Staff uploading in manage mode, on the client's behalf. A preview session
    // has no puid, so without this the row lands anonymous and the client sees
    // a file that appeared from nowhere — the opposite of the point, which is
    // that they can see we have their brand assets and who put them there.
    const staffUploader = user.isPreview ? (user.previewBy || null) : null;
    const actorLabel = user.isPreview ? 'The Squideo team' : (user.name || user.email);

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    let stored;
    if (dealId) {
      const fileId = crypto.randomUUID();
      const blob = uploaded || await put(`deal-files/${dealId}/${fileId}/${safeName}`, buf, { access: 'private', contentType: mimeType });
      await sql`
        INSERT INTO deal_files (id, deal_id, filename, mime_type, size_bytes, blob_url, blob_pathname, uploaded_by, source, portal_user_id, category)
        VALUES (${fileId}, ${dealId}, ${filename}, ${mimeType}, ${sizeBytes}, ${blob.url}, ${blob.pathname}, NULL, 'portal', ${user.puid}, ${dealCategory})
      `;
      stored = { id: fileId, filename, mimeType, sizeBytes, category: dealCategory, createdAt: new Date().toISOString() };
      // A script/direction upload answers the stage — including when they'd
      // previously asked us to write it, or we'd ticked "already received".
      // 'refining' survives: a fresh version of a draft we're already polishing
      // doesn't change what we're doing with it.
      if (dealCategory && dealScriptStatus !== 'refining') {
        await setScriptStatus(dealId, 'received', `client:${user.email}`);
      }
    } else {
      const id = makeId('pcf');
      const category = req.query.category === 'document' ? 'document' : 'brand';
      const blob = uploaded || await put(`portal-files/${companyId}/${id}/${safeName}`, buf, { access: 'private', contentType: mimeType });
      const [inserted] = await sql`
        INSERT INTO portal_company_files (id, company_id, category, filename, mime_type, size_bytes, blob_url, blob_pathname, uploaded_by_portal_user, uploaded_by_staff)
        VALUES (${id}, ${companyId}, ${category}, ${filename}, ${mimeType}, ${sizeBytes}, ${blob.url}, ${blob.pathname}, ${user.puid},
                -- uploaded_by_staff is a FK to users(email). Resolved through a
                -- subquery so an address that isn't a CRM user lands as NULL
                -- instead of failing the whole upload on a constraint — losing
                -- the byline is a blemish, losing the file is a bug.
                (SELECT u.email FROM users u WHERE u.email = ${staffUploader}))
        RETURNING uploaded_by_staff
      `;
      stored = {
        id, category, filename, mimeType, sizeBytes,
        uploadedByStaff: !!inserted?.uploaded_by_staff, createdAt: new Date().toISOString(),
      };
    }

    // Best-effort team ping (in-app only — uploads can be frequent). A script or
    // visual-direction file gets its own key so producers can be alerted to it
    // without subscribing to every document upload — and so a re-sent version
    // reads as "a new version", which is what they actually need to act on.
    try {
      await ensurePortalNotificationDefaults();
      const [co] = await sql`SELECT name FROM companies WHERE id = ${companyId}`;
      const what = dealCategory === 'visual_direction' ? 'visual direction' : 'script';
      await sendNotification(dealCategory ? 'portal.script_uploaded' : 'portal.doc_uploaded', {
        subject: dealCategory
          ? `✍️ ${actorLabel} sent a ${what}: ${filename}`
          : `📎 ${actorLabel} uploaded ${filename}`,
        text: dealCategory
          ? `${actorLabel} uploaded a ${what} (${filename}) via the client portal (${co?.name || companyId}).`
          : `${actorLabel} uploaded ${filename} via the client portal (${co?.name || companyId}).`,
        inApp: {
          title: dealCategory ? `Client ${what}: ${filename}` : `Client file: ${filename}`,
          body: `${actorLabel} · ${co?.name || ''}`,
          link: dealId ? `#/deal/${dealId}` : `#/company/${companyId}`,
          // Clients upload in bursts — a brand pack is a dozen files, and one
          // notification each buries everything else in the bell. Roll them into
          // a single running summary per deal/company instead. `{n}` becomes the
          // count. The first file still names itself, which is the useful case.
          coalesce: {
            group: `portal-upload:${dealId || companyId}:${dealCategory || 'file'}`,
            summaryTitle: dealCategory
              ? `Client ${what}: {n} files`
              : `Client files: {n} uploaded`,
            summaryBody: `${actorLabel} · ${co?.name || ''}`,
            windowMinutes: 180,
          },
        },
        inAppOnly: true,
      });
    } catch (err) {
      console.warn('[portal] upload notify failed', err.message);
    }

    return res.status(201).json({ file: stored });
  }

  if (req.method === 'DELETE') {
    const id = req.query.id ? String(req.query.id) : null;
    if (!id) return res.status(400).json({ error: 'id required' });
    if (scope === 'deal') {
      const rows = await sql`
        SELECT f.id, f.blob_url, f.portal_user_id, d.company_id
          FROM deal_files f JOIN deals d ON d.id = f.deal_id
         WHERE f.id = ${id} AND f.source = 'portal'
      `;
      const f = rows[0];
      if (!f || !user.companyIds.includes(f.company_id)) return res.status(404).json({ error: 'File not found' });
      // Manage mode is staff acting in the portal — they can tidy up anything
      // in the org, not just their own uploads.
      if (!user.canManage && f.portal_user_id !== user.puid) {
        return res.status(403).json({ error: 'You can only remove files you uploaded' });
      }
      if (f.blob_url) { try { await del(f.blob_url); } catch (err) { console.warn('[portal] blob delete failed', err.message); } }
      await sql`DELETE FROM deal_files WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }
    const rows = await sql`
      SELECT id, blob_url, uploaded_by_portal_user, company_id FROM portal_company_files WHERE id = ${id}
    `;
    const f = rows[0];
    if (!f || !user.companyIds.includes(f.company_id)) return res.status(404).json({ error: 'File not found' });
    if (!user.canManage && f.uploaded_by_portal_user && f.uploaded_by_portal_user !== user.puid) {
      return res.status(403).json({ error: 'You can only remove files you uploaded' });
    }
    if (f.blob_url) { try { await del(f.blob_url); } catch (err) { console.warn('[portal] blob delete failed', err.message); } }
    await sql`DELETE FROM portal_company_files WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ═════════════════════════ script & visual direction ═════════════════════════
// One client-facing stage covering both halves. The files themselves go through
// filesRoutes (scope=deal&category=script|visual_direction) — this route reads
// the stage back and takes the "we'd like you to write it" answer.
const SCRIPT_CATEGORIES = new Set(['script', 'visual_direction']);

async function scriptFilesFor(dealId) {
  const rows = await sql`
    SELECT f.id, f.filename, f.category, f.mime_type, f.size_bytes, f.portal_user_id,
           f.created_at, pu.name AS uploaded_by_name
      FROM deal_files f
      LEFT JOIN portal_users pu ON pu.id = f.portal_user_id
     WHERE f.deal_id = ${dealId} AND f.category IN ('script', 'visual_direction')
     ORDER BY f.created_at DESC
  `.catch(() => []);
  return rows.map((f) => ({
    ...serialisePortalDealFile(f),
    category: f.category,
    uploadedByName: f.uploaded_by_name || null,
  }));
}

// Stamp the deal's script stage. Only ever moves it forward to a real answer —
// an upload always wins ('received'), so a client who first asked us to write it
// and then sends one themselves ends up in the right state.
async function setScriptStatus(dealId, status, by) {
  await sql`
    UPDATE deals
       SET script_status = ${status}, script_status_at = ${status ? new Date().toISOString() : null},
           script_status_by = ${status ? by : null}, updated_at = NOW()
     WHERE id = ${dealId}
  `.catch((err) => { console.warn('[portal] script status update failed', err.message); });
}

async function scriptRoute(req, res, user) {
  const deal = await requireDealInOrg(res, req.query.dealId ? String(req.query.dealId) : null, user.companyIds);
  if (!deal) return;

  if (req.method === 'GET') {
    const files = await scriptFilesFor(deal.id);
    return res.status(200).json({
      dealId: deal.id,
      dealTitle: deal.title,
      status: deal.script_status || null,
      statusAt: deal.script_status_at || null,
      // True when we ticked "we already have their script" and nothing has been
      // uploaded here — so the page can say "we've already got it" rather than
      // showing an empty file list under a done step.
      receivedElsewhere: deal.script_status === 'received' && files.length === 0,
      files,
    });
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    // The only status a client sets directly: "we'd like Squideo to write it"
    // (and undoing that). 'received' is stamped by an upload, or by staff.
    const wantsUs = body?.writeForUs === true;
    if (wantsUs) {
      await setScriptStatus(deal.id, 'squideo', `client:${user.email}`);
      try {
        await ensurePortalNotificationDefaults();
        const [co] = await sql`SELECT name FROM companies WHERE id = ${deal.company_id}`;
        await sendNotification('portal.script_uploaded', {
          subject: `✍️ ${co?.name || 'A client'} would like us to write the script`,
          text: `${user.name || user.email} asked Squideo to write the script for ${deal.title || 'their project'}.`,
          inApp: {
            title: 'Script: client wants us to write it',
            body: `${user.name || user.email} · ${deal.title || co?.name || ''}`,
            link: `#/deal/${deal.id}`,
          },
          inAppOnly: true,
        });
      } catch (err) {
        console.warn('[portal] script notify failed', err.message);
      }
    } else if (deal.script_status === 'squideo') {
      await setScriptStatus(deal.id, null, null);
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ═════════════════════════ extras ═════════════════════════
async function extrasRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const deal = await requireDealInOrg(res, req.query.dealId ? String(req.query.dealId) : null, user.companyIds);
  if (!deal) return;
  await ensureDealExtrasTable();
  const windowOpen = extrasWindowOpen(deal);
  const offers = windowOpen ? await computePortalOffers(deal) : [];
  const accepted = await sql`
    SELECT id, description, amount, status, created_at
      FROM deal_extras WHERE deal_id = ${deal.id} AND source = 'portal'
     ORDER BY created_at DESC
  `;
  return res.status(200).json({
    dealId: deal.id,
    dealTitle: deal.title,
    windowOpen,
    discount: Number(deal.portal_extras_discount ?? 0.10),
    offers,
    accepted: accepted.map(serialisePortalExtra),
  });
}

async function extrasAcceptRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = await readJsonBody(req);
  const deal = await requireDealInOrg(res, trimOrNull(body.dealId), user.companyIds);
  if (!deal) return;
  if (!extrasWindowOpen(deal)) {
    return res.status(409).json({ error: 'Extras can only be added while a project is live — contact your producer instead.' });
  }
  // Server-side pricing authority: the client sends only an offer key; the
  // amount is recomputed from the proposal / staff-priced offer rows.
  const priced = await resolveOfferForAccept(deal, body.offerKey, body.quantity);
  if (!priced) return res.status(400).json({ error: 'That extra is no longer available — refresh and try again.' });

  await ensureDealExtrasTable();
  const qtyLabel = priced.quantity > 1 ? ` × ${priced.quantity}` : '';
  const description = `${priced.title}${qtyLabel} — added via client portal${priced.discounted ? ' (portal discount)' : ''}`;
  const newId = makeId('xtr');
  await sql`
    INSERT INTO deal_extras (id, deal_id, description, amount, vat_rate, status, payment_type, created_by, source, portal_user_id)
    VALUES (${newId}, ${deal.id}, ${description}, ${priced.amount}, NULL, 'pending', 'final', NULL, 'portal', ${user.puid})
  `;

  // Team alert — a client committing spend deserves an email (unlike
  // staff-logged extras, which are in-app only).
  try {
    await ensurePortalNotificationDefaults();
    const amountStr = '£' + priced.amount.toFixed(2);
    await sendNotification('portal.extra_accepted', {
      subject: `💸 Portal extra: ${priced.title} (${amountStr}) — ${deal.title}`,
      text: `${user.name || user.email} added "${priced.title}"${qtyLabel} (${amountStr} ex-VAT) to ${deal.title} via the client portal. It rides the final invoice.`,
      inApp: {
        title: `Portal extra: ${amountStr} ex-VAT`,
        body: `${user.name || user.email} · ${priced.title}${qtyLabel} · ${deal.title}`,
        link: `#/deal/${deal.id}`,
      },
    });
  } catch (err) {
    console.warn('[portal] extra_accepted notify failed', err.message);
  }

  // Client confirmation email (best-effort).
  try {
    await sendMail({
      to: user.email,
      subject: `Added to ${deal.title}: ${priced.title}`,
      html: portalExtraConfirmHtml({
        logoUrl: await emailLogoUrl(deal.company_id),
        clientName: user.name,
        projectTitle: deal.title,
        title: `${priced.title}${qtyLabel}`,
        amount: priced.amount,
        originalAmount: priced.originalAmount,
      }),
      text: `We've added ${priced.title}${qtyLabel} (£${priced.amount.toFixed(2)} ex VAT) to ${deal.title}. It'll appear on your final invoice.`,
    });
  } catch (err) {
    console.warn('[portal] extra confirm email failed', err.message);
  }

  const [row] = await sql`SELECT id, description, amount, status, created_at FROM deal_extras WHERE id = ${newId}`;
  return res.status(201).json({ extra: serialisePortalExtra(row) });
}

// ═════════════════════════ voiceover ═════════════════════════
// The client auditions the global artist catalogue (two sections, matching
// squideo.com) and picks one PER VIDEO. A pick locks — they can't change it.

// The label a client-facing charge/video uses (2607-014-01 or the title).
function voiceoverVideoLabel(deal, video) {
  return deal.reference && video.video_number
    ? `${deal.reference}-${String(video.video_number).padStart(2, '0')}`
    : (video.title || 'your video');
}

// GET voiceover?dealId= — eligibility + catalogue (only the sections this
// client can pick, each with its per-pick charge) + this project's videos.
async function voiceoverRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const deal = await requireDealInOrg(res, req.query.dealId ? String(req.query.dealId) : null, user.companyIds);
  if (!deal) return;
  await ensureVoiceoverCatalogue();

  const ctx = await resolveVoiceoverContext(deal);

  const videos = await sql`
    SELECT v.id, v.title, v.video_number, v.sort_order, v.created_at,
           v.voiceover_artist_id, va.name AS voiceover_artist_name, va.category AS voiceover_category
      FROM project_videos v
      LEFT JOIN voiceover_artists va ON va.id = v.voiceover_artist_id
     WHERE v.deal_id = ${deal.id}
     ORDER BY v.sort_order ASC, v.created_at ASC`;

  // No voiceover on this project (the AI inclusion was removed and no human VO
  // was bought) → nothing to choose.
  if (!ctx.hasVo) {
    return res.status(200).json({ dealId: deal.id, dealTitle: deal.title, hasVo: false, sections: [], videos: videos.map(shapePortalVoiceoverVideo) });
  }

  const artists = await sql`SELECT * FROM voiceover_artists WHERE archived_at IS NULL AND category = ANY(${ctx.sections}) ORDER BY category, sort_order, created_at`;
  const grouped = {};
  for (const key of ctx.sections) grouped[key] = [];
  for (const a of artists) if (grouped[a.category]) grouped[a.category].push(serialiseArtist(a));

  return res.status(200).json({
    dealId: deal.id,
    dealTitle: deal.title,
    reference: deal.reference || null,
    hasVo: true,
    // Ordered sections with the £ charge for picking any artist in them.
    sections: ctx.sections.map((key) => ({ key, charge: ctx.charges[key] ?? 0, artists: grouped[key] || [] })),
    entitlement: ctx.entitlement,
    paymentMode: ctx.paymentMode,               // 'now' | 'final'
    videos: videos.map(shapePortalVoiceoverVideo),
  });
}

// POST voiceover-select { dealId, videoId, artistId, applyToAll }
// Server is the pricing authority: it recomputes the charge for the chosen tier
// (never trusts the client). Free picks lock immediately; a paid pick either
// rides the final invoice (PO) or requires a Stripe payment first (full/50-50).
async function voiceoverSelectRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = await readJsonBody(req);
  const deal = await requireDealInOrg(res, trimOrNull(body.dealId), user.companyIds);
  if (!deal) return;
  await ensureVoiceoverCatalogue();

  const videoId = trimOrNull(body.videoId);
  const artistId = trimOrNull(body.artistId);
  if (!videoId || !artistId) return res.status(400).json({ error: 'videoId and artistId are required' });

  const artist = await getArtist(artistId);
  if (!artist || artist.archived_at) {
    return res.status(400).json({ error: 'That voiceover artist is no longer available — refresh and try again.' });
  }
  const [video] = await sql`SELECT id, title, video_number, voiceover_artist_id FROM project_videos WHERE id = ${videoId} AND deal_id = ${deal.id}`;
  if (!video) return res.status(404).json({ error: 'Video not found' });
  if (video.voiceover_artist_id) {
    return res.status(409).json({ error: 'A voiceover is already locked in for this video. Contact your producer to change it.' });
  }

  const ctx = await resolveVoiceoverContext(deal);
  if (!ctx.hasVo) return res.status(409).json({ error: 'This project doesn’t include a voiceover.' });
  // The artist's section must be one this client is allowed to pick from.
  if (!ctx.sections.includes(artist.category)) {
    return res.status(403).json({ error: 'That voice isn’t available on your project.' });
  }
  const charge = ctx.charges[artist.category];
  if (charge == null) return res.status(409).json({ error: 'That voice can’t be selected right now — contact your producer.' });

  const applyToAll = body.applyToAll === true;
  const videoLabel = voiceoverVideoLabel(deal, video);

  // Paid upgrade on a pay-now (full / 50-50) deal → take the card payment FIRST.
  // The pick is applied by the Stripe webhook once payment completes.
  if (charge > 0 && ctx.paymentMode === 'now') {
    try {
      const checkoutUrl = await createVoiceoverCheckout({ deal, user, artist, video, applyToAll, charge });
      return res.status(200).json({ requiresPayment: true, checkoutUrl, amount: charge });
    } catch (err) {
      console.error('[portal] voiceover checkout failed', err.message);
      return res.status(502).json({ error: 'Could not start payment — please try again.' });
    }
  }

  // Free pick, or a paid pick on a PO deal (rides the final invoice).
  if (charge > 0) {
    await recordVoiceoverExtra({ dealId: deal.id, artist, videoLabel, applyToAll, amount: charge, paid: false, portalUserId: user.puid });
  }
  const videos = await applyVoiceoverSelection({ dealId: deal.id, videoId, artistId, applyToAll, portalUserId: user.puid });
  await notifyVoiceoverChosen({ deal, actorName: user.name || user.email, artist, videoLabel, applyToAll, charge, paidNow: false });
  await emailVoiceoverConfirm({ deal, clientEmail: user.email, clientName: user.name, artist, videoLabel, applyToAll });

  return res.status(200).json({ videos, charged: charge > 0 ? { amount: charge, mode: 'final' } : null });
}

// Create a Stripe Checkout Session for a paid voiceover upgrade. The metadata
// carries everything the webhook needs to apply the pick after payment.
async function createVoiceoverCheckout({ deal, user, artist, video, applyToAll, charge }) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const label = `${sectionName(artist.category)} voiceover — ${artist.name}`;
  // Query param BEFORE the hash so it lands in location.search and doesn't
  // corrupt the hash-routed dealId (#/voiceover/<dealId>).
  const returnTo = (flag) => `${PORTAL_URL}/?${flag}=1#/voiceover/${deal.id}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: user.email || undefined,
    line_items: [{
      price_data: { currency: 'gbp', product_data: { name: label }, unit_amount: Math.round(charge * 100) },
      quantity: 1,
    }],
    metadata: {
      kind: 'voiceover_upgrade',
      dealId: deal.id,
      videoId: video.id,
      artistId: artist.id,
      applyToAll: applyToAll ? 'true' : 'false',
      portalUserId: user.puid || '',
      amount: String(charge),
    },
    success_url: returnTo('vo_paid'),
    cancel_url: returnTo('vo_cancelled'),
  });
  return session.url;
}

// GET voiceover-sample?artistId= — stream a sample clip (global catalogue, any
// authenticated client; no deal scoping). Range-capable for <audio> seeking.
async function voiceoverSampleRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  await ensureVoiceoverCatalogue();
  const artist = await getArtist(trimOrNull(req.query.artistId));
  if (!artist || artist.archived_at) return res.status(404).json({ error: 'Sample not found' });
  return streamVoiceoverSample(req, res, artist);
}

// ═════════════════════════ kick-off call ═════════════════════════
// A project task: the client books a kick-off call. Reuses the intro-call
// engine (team availability + Google Meet). If the PM has proposed a specific
// time (intro_call_links.kind='kickoff' with proposed_starts_at), we offer
// "confirm this time"; otherwise the client picks from live availability.

// GET kickoff?dealId= — proposed time (if any), available slots + any booking.
async function kickoffRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const deal = await requireDealInOrg(res, req.query.dealId ? String(req.query.dealId) : null, user.companyIds);
  if (!deal) return;
  await ensureIntroCallTables();

  // Any confirmed booking already?
  const [booking] = await sql`
    SELECT starts_at, ends_at, meet_url FROM intro_call_bookings
     WHERE deal_id = ${deal.id} AND kind = 'kickoff' AND status = 'confirmed'
     ORDER BY starts_at DESC LIMIT 1`;

  // The PM's proposed time, if a kick-off link carries one.
  const [link] = await sql`
    SELECT proposed_starts_at FROM intro_call_links
     WHERE deal_id = ${deal.id} AND kind = 'kickoff' AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`;

  const { rules, result } = await computeBookingSlots({ dealId: deal.id });

  return res.status(200).json({
    dealId: deal.id,
    projectName: deal.title,
    durationMinutes: rules.durationMinutes,
    timezone: rules.timezone,
    ready: result.blocked.length === 0,
    proposedStartsAt: link?.proposed_starts_at || null,
    slots: result.slots,
    booking: booking ? { startsAt: booking.starts_at, endsAt: booking.ends_at, meetUrl: booking.meet_url } : null,
  });
}

// POST kickoff-book { dealId, startsAt }
async function kickoffBookRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = await readJsonBody(req);
  const deal = await requireDealInOrg(res, trimOrNull(body.dealId), user.companyIds);
  if (!deal) return;
  await ensureIntroCallTables();

  // One kick-off per deal — if it's already booked, don't double up.
  const [existing] = await sql`
    SELECT id FROM intro_call_bookings WHERE deal_id = ${deal.id} AND kind = 'kickoff' AND status = 'confirmed' LIMIT 1`;
  if (existing) return res.status(409).json({ error: 'Your kick-off call is already booked.' });

  // Link the booking to a kick-off link if one exists (carries the PM context).
  const [link] = await sql`
    SELECT token FROM intro_call_links WHERE deal_id = ${deal.id} AND kind = 'kickoff' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`;

  const out = await bookSlot({
    dealId: deal.id,
    linkToken: link?.token || null,
    projectName: deal.title,
    name: user.name || user.email,
    email: user.email,
    startISO: body.startsAt,
    timezone: trimOrNull(body.timezone),
    kind: 'kickoff',
  });
  if (!out.ok) {
    const payload = { error: out.error };
    if (out.slots) payload.slots = out.slots;
    return res.status(out.status).json(payload);
  }
  return res.status(200).json({ ok: true, booking: { startsAt: out.start, endsAt: out.end, meetUrl: out.meetUrl } });
}

// ═════════════════════════ request-video ═════════════════════════
async function requestVideoRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = await readJsonBody(req);
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;
  const projectDetails = trimOrNull(body.projectDetails);
  if (!projectDetails) return res.status(400).json({ error: 'Tell us a little about the video you need' });

  const id = await createPortalQuoteRequest({
    user, companyId, projectDetails,
    timeline: trimOrNull(body.timeline),
    budget: trimOrNull(body.budget),
    useCredit: body.useCredit === true,
    sourceUrl: `${PORTAL_URL}#/request`,
    files: Array.isArray(body.files) ? body.files : [],
  });
  return res.status(201).json({ ok: true, id });
}

// Creates the quote_requests row and fires the team alert. Shared by the
// "New video" form and by a submitted brief, so the two can't drift on the
// things that are easy to get wrong — the prospect discount rule, the lead
// magnet stamp, and the per-recipient qualify/disqualify links.
async function createPortalQuoteRequest({
  user, companyId, projectDetails, timeline = null, budget = null,
  useCredit = false, sourceUrl = null, files = [], briefId = null,
  volume = null,
}) {
  const company = user.companies.find((c) => c.id === companyId) || null;
  const id = crypto.randomUUID();
  const createdAt = new Date();

  // A video-guide signup gets a portal account and a `prospect` org, but they
  // are NOT a client — so they aren't owed the 10% portal discount, and the
  // team alert must not tell sales they are. Stamping lead_magnet at the same
  // time is what makes "from the video guide: N leads · £X signed" countable;
  // it's a separate dimension from attr_channel, which still records how they
  // originally found us.
  const [origin] = await sql`
    SELECT COALESCE(c.prospect, FALSE) AS prospect,
           (SELECT cs.id FROM course_signups cs
             WHERE cs.portal_user_id = ${user.puid} LIMIT 1) AS course_signup_id
      FROM companies c WHERE c.id = ${companyId}
  `.catch(() => [{}]);
  const isProspect = origin?.prospect === true;
  const courseSignupId = origin?.course_signup_id || null;
  const leadMagnet = courseSignupId ? 'explainer-course' : null;
  const discount = !isProspect;

  // Identity comes from the SESSION, never the request body — the CRM sees
  // exactly who asked, and the row is pre-linked to the org.
  const qr = {
    id,
    name: user.name || user.email,
    email: user.email,
    phone: user.phone || null,
    company: company?.name || null,
    project_details: projectDetails,
    timeline,
    budget,
    opt_in: false,
    source_url: sourceUrl || `${PORTAL_URL}#/request`,
    created_at: createdAt,
    country_code: null,
    country_name: null,
  };
  // Attribution follows the PERSON, not the form.
  //
  // Someone who clicked an ad, took the video guide and came back a fortnight
  // later to ask for a quote is still that ad's conversion — but the portal is
  // on app.squideo.com and the ad landed them on squideo.com, so nothing in the
  // browser (cookie, localStorage, referrer) survives the hop. track.js can't
  // help here.
  //
  // What does survive is the signup: /course captured the gclid and campaign at
  // the time, and this request already knows which signup it belongs to. Copy
  // it forward, or Marketing counts a PPC-sourced lead as direct and the
  // campaign that actually paid for it looks worthless.
  //
  // Only from the course signup — deliberately. Falling back to "whatever
  // campaign this email ever touched" would credit a two-year-old ad for a
  // long-standing client's routine reorder.
  const [attr] = courseSignupId
    ? await sql`
        SELECT attr_channel, attr_source, attr_medium, attr_campaign, attr_term, attr_content,
               attr_gclid, attr_gbraid, attr_wbraid, attr_fbclid, attr_msclkid,
               attr_campaign_id, attr_adgroup_id, attr_keyword, attr_matchtype,
               attr_network, attr_device, attr_landing_url, attr_referrer, attr_first_seen_at
          FROM course_signups WHERE id = ${courseSignupId}
      `.catch(() => [])
    : [];
  const a = attr || {};

  await ensureLeadAttribution();
  await sql`
    INSERT INTO quote_requests (
      id, name, email, phone, company, project_details, timeline, budget,
      opt_in, source_url, created_at, source, portal_user_id, portal_discount, company_id, use_credit,
      lead_magnet, course_signup_id,
      attr_channel, attr_source, attr_medium, attr_campaign, attr_term, attr_content,
      attr_gclid, attr_gbraid, attr_wbraid, attr_fbclid, attr_msclkid,
      attr_campaign_id, attr_adgroup_id, attr_keyword, attr_matchtype,
      attr_network, attr_device, attr_landing_url, attr_referrer, attr_first_seen_at
    ) VALUES (
      ${qr.id}, ${qr.name}, ${qr.email}, ${qr.phone}, ${qr.company},
      ${qr.project_details}, ${qr.timeline}, ${qr.budget}, ${qr.opt_in},
      ${qr.source_url}, ${qr.created_at}, 'portal', ${user.puid}, ${discount}, ${companyId}, ${useCredit},
      ${leadMagnet}, ${courseSignupId},
      ${a.attr_channel ?? null}, ${a.attr_source ?? null}, ${a.attr_medium ?? null},
      ${a.attr_campaign ?? null}, ${a.attr_term ?? null}, ${a.attr_content ?? null},
      ${a.attr_gclid ?? null}, ${a.attr_gbraid ?? null}, ${a.attr_wbraid ?? null},
      ${a.attr_fbclid ?? null}, ${a.attr_msclkid ?? null},
      ${a.attr_campaign_id ?? null}, ${a.attr_adgroup_id ?? null},
      ${a.attr_keyword ?? null}, ${a.attr_matchtype ?? null},
      ${a.attr_network ?? null}, ${a.attr_device ?? null},
      ${a.attr_landing_url ?? null}, ${a.attr_referrer ?? null}, ${a.attr_first_seen_at ?? null}
    )
  `;

  // Attach any files already uploaded via the public quote upload endpoint.
  const storedFiles = [];
  for (const f of (Array.isArray(files) ? files.slice(0, 5) : [])) {
    if (!f || !f.blobUrl || !f.filename) continue;
    const filename = String(f.filename).slice(0, 255);
    const mimeType = f.mimeType ? String(f.mimeType).slice(0, 100) : null;
    const sizeBytes = Number.isFinite(f.sizeBytes) ? Math.floor(f.sizeBytes) : null;
    await sql`
      INSERT INTO quote_request_files (id, quote_request_id, filename, mime_type, size_bytes, blob_url, blob_pathname)
      VALUES (${crypto.randomUUID()}, ${id}, ${filename}, ${mimeType}, ${sizeBytes}, ${String(f.blobUrl)}, ${f.blobPathname ? String(f.blobPathname) : null})
    `;
    storedFiles.push({ filename, mime_type: mimeType, size_bytes: sizeBytes, blob_url: String(f.blobUrl) });
  }

  // Same team alert as the public form, with the portal-discount subject and
  // per-recipient one-click Qualify/Disqualify links.
  const apiBase = APP_URL.replace(/\/$/, '');
  const crmUrl = `${apiBase}/api/quote-requests?action=open&id=${encodeURIComponent(qr.id)}`;
  // The label sales reads first. "10% discount" on a prospect would be a
  // pricing instruction nobody meant to give.
  // A completed brief is a materially warmer lead than a one-box request, and
  // it deserves a subject line that says so — it's the difference between "get
  // to this today" and "get to this this week".
  const leadLabel = briefId
    ? (leadMagnet ? 'completed brief (video guide)' : 'completed video brief')
    : (leadMagnet ? 'video-guide lead'
                  : (discount ? 'portal quote request (10% discount)' : 'portal quote request'));

  // Volume is the signal that decides whether this is one project or the start
  // of a programme — i.e. whether to propose production credit alongside the
  // first quote. It belongs in the subject line because it changes what gets
  // proposed, not just how it's followed up.
  const VOLUME_NOTE = {
    few: 'wants 2-3 videos',
    programme: 'wants several a quarter',
  };
  const volumeNote = VOLUME_NOTE[volume] || null;

  const subject = `New ${leadLabel} from ${qr.name}${qr.company ? ` — ${qr.company}` : ''}`
    + (volumeNote ? ` · ${volumeNote}` : '')
    + (useCredit ? ' · has credit to draw down' : '');
  const subscribed = await resolveRecipients('quote_request.new', {});
  await Promise.allSettled(subscribed.map(async (to) => {
    const role = await getRoleForUser(to);
    const isAdmin = hasPermission(role, 'users.manage');
    const qualifyToken = await signQuoteRequestActionToken({ quoteRequestId: qr.id, action: 'qualify', email: to });
    const qualifyUrl = `${apiBase}/api/quote-requests?action=action-link&id=${encodeURIComponent(qr.id)}&act=qualify&token=${encodeURIComponent(qualifyToken)}`;
    let disqualifyUrl = null;
    if (isAdmin) {
      const t = await signQuoteRequestActionToken({ quoteRequestId: qr.id, action: 'disqualify', email: to });
      disqualifyUrl = `${apiBase}/api/quote-requests?action=action-link&id=${encodeURIComponent(qr.id)}&act=disqualify&token=${encodeURIComponent(t)}`;
    }
    await sendMail({
      to,
      subject,
      html: buildNotificationEmail(qr, storedFiles, { qualifyUrl, disqualifyUrl, crmUrl, leadLabel }),
    });
  }));
  if (subscribed.length) {
    await persistInApp('quote_request.new', subscribed, {
      subject,
      inApp: {
        title: subject,
        body: [qr.company, qr.budget, qr.timeline, volumeNote,
               briefId ? 'Full brief' : null,
               leadMagnet ? 'Video guide' : (discount ? 'Portal · 10% discount' : 'Portal'),
               useCredit ? 'has credit to draw down' : null].filter(Boolean).join(' · '),
        link: '#/quote-requests',
      },
    });
  }

  return id;
}

// ═════════════════════════ sample project ═════════════════════════
// Config only — the sample project itself is a fixture in the browser bundle
// and never touches the database. All this returns is where Ben's video lives,
// so it can be re-recorded and swapped from Admin without a deploy.
async function demoProjectRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const [row] = await sql`SELECT demo_project FROM settings WHERE id = 1`.catch(() => []);
  const cfg = row?.demo_project || {};
  return res.status(200).json({
    demo: {
      videoUrl: cfg.videoUrl || null,
      posterUrl: cfg.posterUrl || null,
      title: cfg.title || null,
      videoTitle: cfg.videoTitle || null,
      // The storyboard stage of the tour. Two PDFs so the draft switcher shows
      // a real difference; with only one, both drafts point at it.
      storyboardPdfUrl: cfg.storyboardPdfUrl || null,
      storyboardPdfUrlV1: cfg.storyboardPdfUrlV1 || null,
      storyboardTitle: cfg.storyboardTitle || null,
    },
  });
}

const DEMO_STAGES = { storyboard: 'storyboard', video: 'video review' };

// What the visitor did in the sample project.
//
// The tour is a fixture, so none of it leaves a trace anywhere else — which
// meant the single most qualifying thing a prospect can do (use our review
// tools on a job, all the way to sign-off) was invisible to the people who
// would want to ring them. This is the only server call the tour makes, and
// it records rather than stores: an activity row and, on a first finalise,
// one alert to the team and one into the client's own bell.
//
// Always 200 — a lead signal failing must never break the thing generating it.
async function demoEventRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ok = () => res.status(200).json({ ok: true });
  // A staff preview session has no puid: someone checking the tour over isn't
  // a lead, and shouldn't leave one behind.
  if (!user.puid) return ok();

  const body = await readJsonBody(req);
  const event = trimOrNull(body.event);
  const stage = trimOrNull(body.stage);
  if (!DEMO_STAGES[stage] || !['commented', 'finalised'].includes(event)) return ok();
  const comments = Number.isFinite(Number(body.comments))
    ? Math.max(0, Math.min(999, Math.round(Number(body.comments)))) : 0;
  const companyId = user.companyIds.includes(String(body.companyId)) ? String(body.companyId) : null;

  // One alert per person per stage, forever. They can reset and finalise the
  // sample as many times as they like — the second one tells us nothing the
  // first didn't, and a demo that can buzz the team on a loop is a demo the
  // team turns off.
  const [seen] = await sql`
    SELECT id FROM portal_activity
     WHERE portal_user_id = ${user.puid}
       AND event_key = ${'demo.' + event}
       AND detail->>'stage' = ${stage}
     LIMIT 1
  `.catch(() => []);

  await logPortalActivity({
    req, portalUserId: user.puid, companyId,
    eventKey: 'demo.' + event, detail: { stage, comments },
  });
  if (seen || event !== 'finalised') return ok();

  const who = user.name || user.email;
  const stageLabel = DEMO_STAGES[stage];

  // Their own bell. The tour has just claimed we're told the moment they hit
  // that button — this is the proof, arriving in the same feed a real project
  // would use. Labelled "Sample project" so it can't be mistaken for one.
  await notifyPortalUser({
    portalUserId: user.puid,
    companyId,
    key: 'demo.finalised',
    title: `Sample project · ${stageLabel} finalised`,
    body: comments > 0
      ? `Your ${comments} comment${comments === 1 ? '' : 's'} would be with your producer by now. This is the notification you'd get on a real project.`
      : `On a real project your producer is told the moment you press that button. This is the notification you'd get.`,
    link: '#/demo',
  }).catch(() => {});

  // And the team. Skipped for our own addresses — testing the tour shouldn't
  // buzz everyone's phone.
  try {
    const ours = await internalEmails().catch(() => []);
    if (isInternalEmail(user.email, ours)) return ok();

    const [co] = companyId
      ? await sql`SELECT name FROM companies WHERE id = ${companyId}`.catch(() => [])
      : [];
    await ensureSampleProjectNotificationDefault();
    await sendNotification('portal.sample_project', {
      subject: `🎬 ${who} finished the sample ${stageLabel}`,
      text: [
        `${who} (${user.email}) has just used our review tools end to end on the sample project.`,
        co?.name ? `Company: ${co.name}` : null,
        comments > 0 ? `They left ${comments} comment${comments === 1 ? '' : 's'} before signing it off.` : 'They signed it off without leaving comments.',
        '',
        'They know how the process works and have seen the quality. Worth a call.',
      ].filter(Boolean).join('\n'),
      inApp: {
        title: `Sample ${stageLabel} finished — ${who}`,
        // The line a phone shows on the lock screen: who, where, how engaged.
        body: [co?.name, comments > 0 ? `${comments} comment${comments === 1 ? '' : 's'}` : null]
          .filter(Boolean).join(' · ') || user.email,
        link: companyId ? `#/company/${companyId}` : '#/marketing/course',
      },
      // Deliberately NOT inAppOnly: the bell-only default is set on the role
      // above, so anyone who'd rather have this by email can say so and be
      // listened to. Forcing the channel here would quietly override them.
    });
  } catch (err) {
    console.warn('[portal] sample-project notify failed', err.message);
  }
  return ok();
}

// ═════════════════════════ the brief ═════════════════════════
// GET   /api/portal/brief   → the open draft, creating one if there isn't one
// PATCH /api/portal/brief   → autosave; merges answers, never replaces them
// POST  /api/portal/brief   → send to Squideo (creates the quote request)
//
// Autosave is the whole point of this being a page rather than a document.
// People fill a brief in over days, usually with someone else's answer to a
// question they can't answer themselves, so every field has to survive them
// closing the tab.
async function briefRoute(req, res, user) {
  await ensureClientBriefs();
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;

  // A staff preview session has no puid of its own (see signPortalPreviewToken),
  // so "my open brief" is meaningless for it. It looks at the ORGANISATION's
  // open brief instead — which is what staff opening this actually want to see,
  // and it's the same company the preview token is already scoped to.
  const isPreview = !user.puid;

  const loadOpen = async () => {
    const [row] = isPreview
      ? await sql`
          SELECT * FROM client_briefs
           WHERE company_id = ${companyId} AND submitted_at IS NULL
           ORDER BY updated_at DESC LIMIT 1`
      : await sql`
          SELECT * FROM client_briefs
           WHERE portal_user_id = ${user.puid} AND submitted_at IS NULL LIMIT 1`;
    return row || null;
  };

  const serialise = (r) => ({
    id: r.id,
    answers: r.answers || {},
    completedAt: r.completed_at || null,
    submittedAt: r.submitted_at || null,
    updatedAt: r.updated_at || null,
  });

  if (req.method === 'GET') {
    let row = await loadOpen();
    if (!row && !isPreview) {
      // Created lazily on first open rather than at signup, so an untouched
      // brief never shows up in the CRM as a lead signal that isn't real.
      //
      // Skipped entirely for a preview: portal_user_id is NOT NULL, so staff
      // opening this would have hit a constraint error instead of a page — and
      // even if it inserted, it would invent a brief no client ever started.
      const id = crypto.randomUUID();
      await sql`
        INSERT INTO client_briefs (id, portal_user_id, company_id)
        VALUES (${id}, ${user.puid}, ${companyId})
        ON CONFLICT DO NOTHING`;
      row = await loadOpen();
      if (!row) return res.status(500).json({ error: "Couldn't start a brief" });
    }
    // Past briefs, so someone who has already sent one can look it up.
    const past = await (isPreview
      ? sql`
          SELECT id, answers, submitted_at FROM client_briefs
           WHERE company_id = ${companyId} AND submitted_at IS NOT NULL
           ORDER BY submitted_at DESC LIMIT 10`
      : sql`
          SELECT id, answers, submitted_at FROM client_briefs
           WHERE portal_user_id = ${user.puid} AND submitted_at IS NOT NULL
           ORDER BY submitted_at DESC LIMIT 10`).catch(() => []);
    return res.status(200).json({
      brief: row ? serialise(row) : null,
      readOnly: isPreview,
      past: past.map((p) => ({
        id: p.id,
        submittedAt: p.submitted_at,
        projectName: (p.answers || {}).projectName || 'Untitled brief',
      })),
    });
  }

  // Preview is look-don't-touch. Manage mode doesn't lift this one: a brief is
  // the client's own account of what they want, and portal_user_id is NOT NULL
  // so there is no honest row to write it to anyway.
  if (isPreview) {
    return res.status(403).json({ error: 'A brief can only be edited by the client themselves.' });
  }

  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    const patch = (body && typeof body.answers === 'object' && !Array.isArray(body.answers))
      ? body.answers : null;
    if (!patch) return res.status(400).json({ error: 'answers must be an object' });

    const row = await loadOpen();
    if (!row) return res.status(404).json({ error: 'No open brief' });

    // Merged server-side with ||, so two tabs (or a phone and a laptop) can't
    // wipe each other's answers by each posting their own whole document.
    // `completed` is only ever set from the server's own view of the answers.
    const [updated] = await sql`
      UPDATE client_briefs
         SET answers = answers || ${JSON.stringify(patch)}::jsonb,
             updated_at = NOW()
       WHERE id = ${row.id}
       RETURNING *`;
    const done = missingRequired(updated.answers || {}).length === 0;
    if (done && !updated.completed_at) {
      await sql`UPDATE client_briefs SET completed_at = NOW() WHERE id = ${updated.id}`;
    } else if (!done && updated.completed_at) {
      await sql`UPDATE client_briefs SET completed_at = NULL WHERE id = ${updated.id}`;
    }
    return res.status(200).json({ ok: true, updatedAt: updated.updated_at, complete: done });
  }

  if (req.method === 'POST') {
    const row = await loadOpen();
    if (!row) return res.status(404).json({ error: 'No open brief' });
    const answers = row.answers || {};

    const missing = missingRequired(answers);
    if (missing.length) {
      return res.status(400).json({
        error: 'A few questions still need an answer',
        missing: missing.map((q) => ({ key: q.key, label: q.label, screen: q.screenKey })),
      });
    }

    // Rendered from the STORED answers, never from the request body — what the
    // team reads is always what the client actually filled in.
    const projectDetails = renderBriefText(answers);

    // A client with a balance shouldn't have to TELL us they have one. The
    // "New video" form asks with a tick box because it's a shorter surface;
    // here we just look.
    // Pass the whole company: the ledger is matched by id where possible but
    // falls back to a normalised NAME match, so dropping the name silently
    // misses balances on companies linked that way.
    const creditCo = user.companies.find((c) => c.id === companyId) || { id: companyId };
    const bal = await companyCreditBalance(creditCo).catch(() => null);
    const hasCredit = (bal?.remaining || 0) > 0;

    const quoteRequestId = await createPortalQuoteRequest({
      user, companyId, projectDetails,
      timeline: answers.deadline || null,
      // The LABEL, not the slug. `parseBudgetLower` in quoteRequestActions.js
      // scrapes numbers and takes the minimum, so '5-10k' became a £5 deal.
      budget: answerLabel('budget', answers),
      volume: answers.volume || null,
      useCredit: hasCredit,
      sourceUrl: `${PORTAL_URL}#/brief`,
      briefId: row.id,
    });

    await sql`
      UPDATE client_briefs
         SET submitted_at = NOW(), completed_at = COALESCE(completed_at, NOW()),
             quote_request_id = ${quoteRequestId}, updated_at = NOW()
       WHERE id = ${row.id}`;
    await logPortalActivity({ req, portalUserId: user.puid, eventKey: 'brief.submitted' })
      .catch(() => {});

    // They've done the thing the brief series exists to nudge, so stop it now
    // rather than letting one more "your brief is still unfinished" go out
    // before the next sweep. Course nudges are left alone — sending us a brief
    // doesn't mean they've watched the videos.
    //
    // Best-effort: the cron re-checks this gate anyway, so a failure here costs
    // at most one badly-timed email, never the submission itself.
    await sql`
      SELECT id FROM course_signups WHERE portal_user_id = ${user.puid} LIMIT 1
    `.then(([s]) => (s ? cancelCourseEmails(s.id, kindsInFamily('brief')) : null))
      .catch(() => {});

    return res.status(201).json({ ok: true, id: row.id, quoteRequestId });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ═════════════════════════ video credit ═════════════════════════
// The client's current credit balance (minutes) + the pricing params the buy
// stepper renders. Balance reuses the partner-credit ledger, resolved from the
// company the same way the CRM company mirror does.
async function videoCreditRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;
  const company = user.companies.find((c) => c.id === companyId) || { id: companyId };
  // Credit any of this company's invoice orders whose Xero invoice has been paid
  // since last look, so the balance below is up to date.
  await reconcileVideoCreditOrders([companyId]).catch(() => {});
  const [balance, pricing] = await Promise.all([
    companyCreditBalance(company).catch(() => ({ issued: 0, used: 0, remaining: 0 })),
    videoCreditPricingParams(companyId),
  ]);
  return res.status(200).json({
    balance: {
      issued: Math.round(balance.issued * 100) / 100,
      used: Math.round(balance.used * 100) / 100,
      remaining: Math.round(balance.remaining * 100) / 100,
    },
    pricing,
  });
}

// Buy credit by card. Server recomputes the authoritative amount (never trusts a
// client-sent price) and opens a Stripe Checkout session; the webhook credits
// the minutes on payment (kind='video_credit_topup').
async function videoCreditCheckoutRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = await readJsonBody(req);
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;
  const company = user.companies.find((c) => c.id === companyId) || null;
  const minutes = Math.floor(Number(body.minutes) || 0);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
    return res.status(400).json({ error: 'Choose between 1 and 120 minutes of credit.' });
  }
  // Per-company rate, so the amount charged matches the price the stepper
  // showed -- both go through videoCreditRatePerMin(companyId).
  const ratePerMin = await videoCreditRatePerMin(companyId);
  const quote = videoCreditQuote(minutes, ratePerMin);
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const returnTo = (flag) => `${PORTAL_URL}/?${flag}=1#/video-credit`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: user.email || undefined,
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: { name: `${minutes} minute${minutes === 1 ? '' : 's'} of video credit` },
          unit_amount: Math.round(quote.totalIncVat * 100),
        },
        quantity: 1,
      }],
      metadata: {
        kind: 'video_credit_topup',
        companyId,
        minutes: String(minutes),
        amountIncVat: quote.totalIncVat.toFixed(2),
        portalUserId: user.puid || '',
        portalUserEmail: user.email || '',
      },
      success_url: returnTo('credit_paid'),
      cancel_url: returnTo('credit_cancelled'),
    });
    return res.status(200).json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('[portal] video-credit checkout failed', err.message);
    return res.status(502).json({ error: 'Could not start payment — please try again.' });
  }
}

// Request an invoice for credit instead of paying by card: notify the team (who
// raise the Xero invoice and add the credit on payment). Nothing is credited
// here — credit only lands once the invoice is settled.
async function videoCreditInvoiceRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = await readJsonBody(req);
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;
  const company = user.companies.find((c) => c.id === companyId) || null;
  const minutes = Math.floor(Number(body.minutes) || 0);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
    return res.status(400).json({ error: 'Choose between 1 and 120 minutes of credit.' });
  }
  // Per-company rate, so the amount charged matches the price the stepper
  // showed -- both go through videoCreditRatePerMin(companyId).
  const ratePerMin = await videoCreditRatePerMin(companyId);
  const quote = videoCreditQuote(minutes, ratePerMin);
  const money = (n) => '£' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Record the request as a credit order so staff can raise the invoice with one
  // click (it then lands on Pending Payments + counts as a sale) and the minutes
  // auto-credit when it's paid.
  let order;
  try {
    order = await createVideoCreditInvoiceOrder({ company: { id: companyId }, minutes, ratePerMin, requestedBy: user.email });
  } catch (err) {
    console.error('[portal] video-credit order create failed', err.message);
    return res.status(502).json({ error: 'Could not log your request — try again shortly.' });
  }

  try {
    await ensurePortalNotificationDefaults();
    await sendNotification('portal.video_credit_request', {
      subject: `🎬 Video credit invoice request — ${company?.name || user.email}`,
      text: `${user.name || user.email} (${company?.name || 'client portal'}) asked to buy ${minutes} minute${minutes === 1 ? '' : 's'} of video credit by INVOICE.\n\n`
        + `${money(quote.subtotalExVat)} ex VAT + ${money(quote.vat)} VAT = ${money(quote.totalIncVat)} inc VAT `
        + `(${Math.round(quote.discount * 100)}% credit discount).\n\nRaise the invoice from their company page — the credit is added automatically once it's paid.`,
      inApp: {
        title: 'Video credit — invoice requested',
        body: `${company?.name || ''} · ${minutes} min · ${money(quote.totalIncVat)} inc VAT`,
        link: `#/company/${companyId}`,
      },
    });
  } catch (err) {
    console.warn('[portal] video-credit invoice request notify failed', err.message);
    // The order is logged; a failed notification shouldn't fail the request.
  }
  return res.status(200).json({ ok: true, orderId: order.id });
}

// ═════════════════════════ po-number ═════════════════════════
async function poNumberRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = await readJsonBody(req);
  const deal = await requireDealInOrg(res, trimOrNull(body.dealId), user.companyIds);
  if (!deal) return;
  const poNumber = trimOrNull(body.poNumber);
  if (!poNumber) return res.status(400).json({ error: 'PO number required' });
  if (poNumber.length > 60) return res.status(400).json({ error: 'PO number looks too long' });
  if (deal.po_number) return res.status(409).json({ error: 'A PO number is already on file for this project — contact your producer to change it.' });

  await sql`UPDATE deals SET po_number = ${poNumber}, updated_at = NOW() WHERE id = ${deal.id}`;

  try {
    await ensurePortalNotificationDefaults();
    await sendNotification('portal.po_provided', {
      subject: `📋 PO number received — ${deal.title}`,
      text: `${user.name || user.email} submitted PO number ${poNumber} for ${deal.title} via the client portal.`,
      inApp: {
        title: `PO number received: ${poNumber}`,
        body: `${user.name || user.email} · ${deal.title}`,
        link: `#/deal/${deal.id}`,
      },
    });
  } catch (err) {
    console.warn('[portal] po_provided notify failed', err.message);
  }
  return res.status(200).json({ ok: true });
}

// ═════════════════════════ team ═════════════════════════
async function teamRoutes(req, res, user) {
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;

  if (req.method === 'GET') {
    const members = await sql`
      SELECT pu.id, pu.email, pu.name, pu.job_title, pu.last_login_at, pu.disabled_at,
             m.created_at AS member_since, m.disabled_at AS membership_disabled_at
        FROM portal_memberships m
        JOIN portal_users pu ON pu.id = m.portal_user_id
       WHERE m.company_id = ${companyId}
       ORDER BY m.created_at ASC
    `;
    const invites = await sql`
      SELECT id, email, invited_by, expires_at, created_at
        FROM portal_invites
       WHERE company_id = ${companyId}
         AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC
    `;
    // Everyone else we already hold at this organisation. Showing them (rather
    // than an empty invite box) is what lets a client see at a glance who's
    // missing and invite them in one click — no re-typing addresses we have.
    await ensureContactCompanies().catch(() => {});
    const contacts = await sql`
      SELECT c.id, c.name, c.email, c.title
        FROM contacts c
       WHERE c.email IS NOT NULL
         AND (c.company_id = ${companyId}
              OR EXISTS (SELECT 1 FROM contact_companies cc
                          WHERE cc.contact_id = c.id AND cc.company_id = ${companyId}))
       ORDER BY c.name ASC NULLS LAST, c.email ASC
    `.catch(() => []);

    const activeMembers = members.filter((m) => !m.disabled_at && !m.membership_disabled_at);
    // Anyone with an account (even a disabled one) or a live invite is already
    // represented above — don't offer to invite them twice.
    const covered = new Set([
      ...members.map((m) => String(m.email || '').toLowerCase()),
      ...invites.map((i) => String(i.email || '').toLowerCase()),
    ]);
    const others = contacts
      .filter((c) => !covered.has(String(c.email).toLowerCase()))
      .map((c) => ({ id: c.id, name: c.name || null, email: c.email, jobTitle: c.title || null }));

    return res.status(200).json({
      members: activeMembers.map(serialisePortalMember),
      invites: invites.map(serialisePortalInvite),
      contacts: others,
    });
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const email = lowerOrNull(body.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    // Already a member?
    const existing = await sql`
      SELECT 1 FROM portal_memberships m JOIN portal_users pu ON pu.id = m.portal_user_id
       WHERE m.company_id = ${companyId} AND pu.email = ${email} AND m.disabled_at IS NULL
    `;
    if (existing.length) return res.status(409).json({ error: 'That person is already a member of your portal' });

    const [invitesToday] = await sql`
      SELECT COUNT(*)::int AS n FROM portal_invites
       WHERE company_id = ${companyId} AND created_at > NOW() - INTERVAL '24 hours'
    `;
    if ((invitesToday?.n || 0) >= INVITES_PER_DAY_PER_ORG) {
      return res.status(429).json({ error: 'Invite limit reached for today — try again tomorrow' });
    }

    const company = user.companies.find((c) => c.id === companyId) || null;
    try {
      await sendTeamInvite({
        email,
        companyId,
        companyName: company?.name,
        // A manage-mode session has the staff member's email as its name, which
        // would put a raw address in the subject line ("adam@squideo.co.uk
        // invited you to…"). Clients see the Squideo team instead.
        inviterName: user.isPreview ? 'The Squideo team' : (user.name || user.email),
        invitedBy: user.puid,
        prefill: { name: trimOrNull(body.name) },
      });
    } catch (err) {
      console.error('[portal] team invite send failed', err.message);
      return res.status(502).json({ error: 'Could not send the invite email — try again shortly' });
    }
    return res.status(201).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ═══════════ team-contact: fill in the team from the CRM (manage mode) ═══════════
// Staff-only. The team list can only show people we actually hold at the
// organisation, so this is how the gaps get closed from inside the portal:
// find someone already in the contact book and attach them to this org, or add
// a new person outright. Either way it writes a real CRM contact linked to the
// organisation — the same record the org page shows — never a portal-only copy.
//
// GETs skip the router's preview gate (it only guards writes), so the manage
// check lives in here and covers both methods: the contact book is ours to
// search, never the client's.
async function teamContactRoute(req, res, user) {
  if (!requireManage(res, user, 'Only Squideo staff can add contacts.')) return;
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;
  await ensureContactCompanies().catch(() => {});

  // ── Search: who could we attach? ──
  if (req.method === 'GET') {
    const q = trimOrNull(req.query.q);
    if (!q || q.length < 2) return res.status(200).json({ results: [] });
    // Escape the LIKE wildcards so a typed % or _ matches itself (Postgres
    // treats backslash as the escape character by default).
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = await sql`
      SELECT c.id, c.name, c.email, c.title, co.name AS company_name
        FROM contacts c
        LEFT JOIN companies co ON co.id = c.company_id
       WHERE c.provisional = FALSE
         AND c.email IS NOT NULL
         AND (c.name ILIKE ${like} OR c.email ILIKE ${like})
         AND c.company_id IS DISTINCT FROM ${companyId}
         AND NOT EXISTS (SELECT 1 FROM contact_companies cc
                          WHERE cc.contact_id = c.id AND cc.company_id = ${companyId})
       ORDER BY c.name ASC NULLS LAST, c.email ASC
       LIMIT 10
    `.catch(() => []);
    return res.status(200).json({
      results: rows.map((c) => ({
        id: c.id,
        name: c.name || null,
        email: c.email,
        jobTitle: c.title || null,
        companyName: c.company_name || null,
      })),
    });
  }

  // ── Attach: an existing contact by id, or a new one by email ──
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const contactId = trimOrNull(body.contactId);
    const name = trimOrNull(body.name);
    const title = trimOrNull(body.title);
    let row = null;

    if (contactId) {
      [row] = await sql`SELECT id, email, name, title, company_id FROM contacts WHERE id = ${contactId}`;
      if (!row) return res.status(404).json({ error: 'That contact no longer exists' });
    } else {
      const email = lowerOrNull(body.email);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'A valid email address is required' });
      }
      [row] = await sql`
        SELECT id, email, name, title, company_id FROM contacts
         WHERE LOWER(email) = ${email} ORDER BY created_at ASC LIMIT 1
      `;
      if (row) {
        // We already hold this address — attach that person rather than making a
        // second record for them. Fill in anything we were missing, and promote
        // a provisional stub (an unreviewed quote-request contact, which would
        // otherwise be purged) now that someone has deliberately added them.
        await sql`
          UPDATE contacts
             SET provisional = FALSE,
                 name = COALESCE(name, ${name}),
                 title = COALESCE(title, ${title}),
                 updated_at = NOW()
           WHERE id = ${row.id}
        `;
        row = { ...row, name: row.name || name, title: row.title || title };
      } else {
        const id = makeId('ct');
        await sql`
          INSERT INTO contacts (id, email, name, title, company_id, provisional, source)
          VALUES (${id}, ${email}, ${name}, ${title}, ${companyId}, FALSE, 'portal_team')
        `;
        row = { id, email, name, title, company_id: companyId };
      }
    }

    await sql`
      INSERT INTO contact_companies (contact_id, company_id)
      VALUES (${row.id}, ${companyId}) ON CONFLICT DO NOTHING
    `;
    // The first organisation a contact gets becomes its primary, so deals and
    // Xero always have one to point at. Someone who already belongs elsewhere
    // keeps their primary and simply gains this org (mirrors the CRM's own
    // contact → organisation linking).
    if (!row.company_id) {
      await sql`UPDATE contacts SET company_id = ${companyId}, updated_at = NOW() WHERE id = ${row.id}`;
    }
    return res.status(200).json({
      contact: { id: row.id, name: row.name || null, email: row.email, jobTitle: row.title || null },
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function teamRevokeInviteRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = await readJsonBody(req);
  const inviteId = trimOrNull(body.inviteId);
  if (!inviteId) return res.status(400).json({ error: 'inviteId required' });
  const rows = await sql`
    UPDATE portal_invites SET revoked_at = NOW()
     WHERE id = ${inviteId} AND company_id = ANY(${user.companyIds})
       AND accepted_at IS NULL AND revoked_at IS NULL
    RETURNING id
  `;
  if (!rows.length) return res.status(404).json({ error: 'Invite not found' });
  return res.status(200).json({ ok: true });
}

// ═════════════════════════ partner programme ═════════════════════════
// The Partner Programme, explained inside the portal and ending in an enquiry
// rather than a trip to squideo.com.
//
// This deliberately does NOT book a real calendar slot the way the kick-off
// call does. That machinery is right there — the project is sold, the producer
// is known, and their diary is the constraint — but wrong here. It needs a host
// with a connected Google Calendar and free time in the next fortnight, and
// when either is missing the client is told "there's nothing open": a dead end
// at the exact moment they were ready to talk. Two questions and a date they
// choose can never be empty, and a human confirms it.
//
// There is no notification for reading the page. The old dashboard card pinged
// the team the moment anyone clicked it, so "interest" meant "curious enough to
// click once" — not a lead, and after a few of those the alert stops being read.
//
// No price on the page either, for the same reason the brief builder has none:
// the programme is scoped on the call, and a rate seen beforehand becomes the
// anchor every later conversation argues against.

// What they can ask for. Text, not a number, because "not sure yet" is a real
// and common answer and forcing a figure would either lose it or invent one.
const PARTNER_MINUTES = new Set(['1-2', '3-4', '5-9', '10+', 'unsure']);
const PARTNER_TIMES = new Set(['morning', 'afternoon', 'either']);

const MINUTES_LABEL = {
  '1-2': '1–2 minutes a month',
  '3-4': '3–4 minutes a month',
  '5-9': '5–9 minutes a month',
  '10+': '10+ minutes a month',
  unsure: 'Not sure yet',
};

// GET partner — the video, plus any enquiry already in with us.
async function partnerRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;
  await ensurePortalTables();

  const [[enquiry], [cfg]] = await Promise.all([
    sql`
      SELECT id, minutes_per_month, preferred_date, preferred_time, created_at
        FROM partner_enquiries
       WHERE company_id = ${companyId} AND handled_at IS NULL
       ORDER BY created_at DESC LIMIT 1
    `.catch(() => []),
    sql`SELECT partner_video FROM settings WHERE id = 1`.catch(() => []),
  ]);

  // Set in Admin → Video guide. Null until then, and the page simply omits the
  // player rather than showing a broken frame.
  const video = cfg?.partner_video?.url
    ? { url: cfg.partner_video.url, title: cfg.partner_video.title || null }
    : null;

  return res.status(200).json({
    video,
    enquiry: enquiry ? {
      minutesPerMonth: enquiry.minutes_per_month || null,
      minutesLabel: MINUTES_LABEL[enquiry.minutes_per_month] || null,
      preferredDate: enquiry.preferred_date || null,
      preferredTime: enquiry.preferred_time || null,
      createdAt: enquiry.created_at,
    } : null,
  });
}

// POST partner-enquire { minutesPerMonth, preferredDate, preferredTime, note }
async function partnerEnquireRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = await readJsonBody(req);
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;
  await ensurePortalTables();
  const company = user.companies.find((c) => c.id === companyId) || null;

  const minutes = PARTNER_MINUTES.has(String(body.minutesPerMonth)) ? String(body.minutesPerMonth) : null;
  if (!minutes) return res.status(400).json({ error: 'Tell us roughly how much video you need each month.' });

  // A date only, no time — the client picks the day, we confirm the hour. Must
  // be today or later: a request for last Tuesday is a typo, not a preference.
  const rawDate = trimOrNull(body.preferredDate);
  let preferredDate = null;
  if (rawDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return res.status(400).json({ error: 'That date didn\'t look right — pick one from the calendar.' });
    const today = new Date().toISOString().slice(0, 10);
    if (rawDate < today) return res.status(400).json({ error: 'Pick a date from today onwards.' });
    preferredDate = rawDate;
  }
  const preferredTime = PARTNER_TIMES.has(String(body.preferredTime)) ? String(body.preferredTime) : 'either';
  const note = trimOrNull(body.note)?.slice(0, 2000) || null;

  // One open enquiry per organisation. A second submission updates the first
  // rather than stacking duplicates in front of whoever picks these up.
  const [open] = await sql`
    SELECT id FROM partner_enquiries
     WHERE company_id = ${companyId} AND handled_at IS NULL
     ORDER BY created_at DESC LIMIT 1
  `.catch(() => []);

  if (open) {
    await sql`
      UPDATE partner_enquiries
         SET minutes_per_month = ${minutes}, preferred_date = ${preferredDate},
             preferred_time = ${preferredTime}, note = ${note},
             portal_user_id = ${user.puid || null}, created_at = NOW()
       WHERE id = ${open.id}`;
  } else {
    await sql`
      INSERT INTO partner_enquiries
        (id, company_id, portal_user_id, minutes_per_month, preferred_date, preferred_time, note)
      VALUES (${makeId('pen')}, ${companyId}, ${user.puid || null}, ${minutes},
              ${preferredDate}, ${preferredTime}, ${note})`;
  }

  // NOW the team hears about it — a real ask with a size and a date on it.
  const when = preferredDate
    ? `${preferredDate}${preferredTime !== 'either' ? ` (${preferredTime})` : ''}`
    : 'no date given';
  try {
    await ensurePortalNotificationDefaults();
    await sendNotification('portal.partner_interest', {
      subject: `🤝 Partner Programme enquiry — ${company?.name || user.email}`,
      text: [
        `${user.name || user.email} (${company?.name || 'client portal'}) asked about the Partner Programme.`,
        '',
        `Volume: ${MINUTES_LABEL[minutes]}`,
        `Preferred call: ${when}`,
        note ? `\nThey added:\n${note}` : '',
      ].join('\n'),
      inApp: {
        title: 'Partner Programme enquiry',
        body: `${company?.name || user.email} · ${MINUTES_LABEL[minutes]} · ${when}`,
        link: `#/company/${companyId}`,
      },
    });
  } catch (err) {
    // The enquiry is saved either way — never fail it over an alert.
    console.warn('[portal] partner enquiry notify failed', err.message);
  }

  return res.status(200).json({
    ok: true,
    enquiry: {
      minutesPerMonth: minutes,
      minutesLabel: MINUTES_LABEL[minutes],
      preferredDate,
      preferredTime,
      createdAt: new Date().toISOString(),
    },
  });
}
