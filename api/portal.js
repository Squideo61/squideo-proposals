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
//   library         — finished files from each deal's Drive "4. Signed Off"
//   download        — org-checked file bytes / signed URLs
//   files           — brand + per-project documents (list/upload/delete)
//   extras          — discounted extras offers (GET) — accept via extras-accept
//   extras-accept   — server-priced accept → deal_extras row
//   request-video   — prefilled quote request with the 10% portal discount
//   po-number       — submit a purchase-order number
//   team            — members + invites (GET/POST), revoke via team-revoke-invite
//   partner-interest— "I'm interested" ping to the team

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { put, del, getDownloadUrl } from '@vercel/blob';
import sql from './_lib/db.js';
import { sendMail, APP_URL } from './_lib/email.js';
import {
  sendNotification,
  resolveRecipients,
  persistInApp,
  ensurePortalNotificationDefaults,
} from './_lib/notifications.js';
import { signQuoteRequestActionToken } from './_lib/auth.js';
import { getRoleForUser } from './_lib/userRoles.js';
import { hasPermission } from './_lib/permissions.js';
import { makeId, trimOrNull, lowerOrNull } from './_lib/crm/shared.js';
import { ensureDealExtrasTable } from './_lib/crm/extras.js';
import { buildNotificationEmail } from './quote-requests.js';
import { ensurePortalTables } from './_lib/portal/db.js';
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
import {
  computePortalOffers,
  resolveOfferForAccept,
  extrasWindowOpen,
} from './_lib/portal/extrasOffers.js';
import { sendTeamInvite } from './_lib/portal/onboarding.js';
import {
  PORTAL_URL,
  portalMagicLinkHtml,
  portalResetHtml,
  portalExtraConfirmHtml,
} from './_lib/portal/emails.js';
import { anyDriveAccessToken, listSignedOffFiles, streamDriveFile } from './_lib/portal/drive.js';
import {
  serialisePortalDeal,
  serialisePortalVideo,
  serialisePortalCompanyFile,
  serialisePortalDealFile,
  serialisePortalExtra,
  serialisePortalMember,
  serialisePortalInvite,
} from './_lib/portal/serialisers.js';

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

async function issuePortalSession(res, user) {
  const jwt = await signPortalToken({ puid: user.id, email: user.email, tv: user.token_version ?? 0 });
  appendSetCookie(res, portalCookieHeader(jwt));
  await sql`UPDATE portal_users SET last_login_at = NOW() WHERE id = ${user.id}`;
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
  const empty = { proposals: new Map(), videos: new Map(), revPending: new Map(), sbPending: new Map(), revLinks: new Map(), sbLinks: new Map() };
  if (!dealIds.length) return empty;

  const [proposalRows, videoRows, revRows, sbRows] = await Promise.all([
    sql`
      SELECT p.id, p.deal_id, p.created_at, s.data AS signature_data, s.signed_at
        FROM proposals p
        LEFT JOIN signatures s ON s.proposal_id = p.id
       WHERE p.deal_id = ANY(${dealIds})
       ORDER BY (s.signed_at IS NOT NULL) DESC, p.created_at DESC
    `,
    sql`
      SELECT id, deal_id, title, status, sort_order, production_phase, production_stage, video_length
        FROM project_videos WHERE deal_id = ANY(${dealIds})
       ORDER BY sort_order ASC, created_at ASC
    `,
    sql`
      SELECT rp.deal_id, rp.share_token, rp.approved_at AS project_approved_at,
             rv.id AS video_id, rv.title AS video_title, rv.approved_at, rv.feedback_submitted_at,
             EXISTS (SELECT 1 FROM revision_versions vv WHERE vv.video_id = rv.id) AS has_version
        FROM revision_projects rp
        JOIN revision_videos rv ON rv.project_id = rp.id
       WHERE rp.deal_id = ANY(${dealIds})
    `.catch(() => []),
    sql`
      SELECT sp.deal_id, sp.share_token, sb.id AS storyboard_id, sb.title AS storyboard_title,
             sb.approved_at, sb.feedback_submitted_at,
             EXISTS (SELECT 1 FROM storyboard_versions sv WHERE sv.storyboard_id = sb.id) AS has_version
        FROM storyboard_projects sp
        JOIN storyboards sb ON sb.project_id = sp.id
       WHERE sp.deal_id = ANY(${dealIds})
    `.catch(() => []),
  ]);

  const proposals = new Map(); // dealId -> { id, signature }
  for (const p of proposalRows) {
    if (!proposals.has(p.deal_id)) {
      proposals.set(p.deal_id, {
        id: p.id,
        signature: p.signed_at ? { data: p.signature_data, signedAt: p.signed_at } : null,
      });
    }
  }

  const videos = new Map(); // dealId -> rows[]
  for (const v of videoRows) {
    if (!videos.has(v.deal_id)) videos.set(v.deal_id, []);
    videos.get(v.deal_id).push(v);
  }

  const revPending = new Map(); // dealId -> { shareToken, videoTitle }
  const revLinks = new Map();   // dealId -> [{ shareToken, title, approved, feedbackSubmitted }]
  for (const r of revRows) {
    if (!revLinks.has(r.deal_id)) revLinks.set(r.deal_id, []);
    if (r.has_version) {
      revLinks.get(r.deal_id).push({
        shareToken: r.share_token,
        title: r.video_title,
        approved: !!r.approved_at,
        feedbackSubmitted: !!r.feedback_submitted_at,
      });
      if (!r.approved_at && !r.feedback_submitted_at && !revPending.has(r.deal_id)) {
        revPending.set(r.deal_id, { shareToken: r.share_token, videoTitle: r.video_title });
      }
    }
  }

  const sbPending = new Map();
  const sbLinks = new Map();
  for (const r of sbRows) {
    if (!sbLinks.has(r.deal_id)) sbLinks.set(r.deal_id, []);
    if (r.has_version) {
      sbLinks.get(r.deal_id).push({
        shareToken: r.share_token,
        title: r.storyboard_title,
        approved: !!r.approved_at,
        feedbackSubmitted: !!r.feedback_submitted_at,
      });
      if (!r.approved_at && !r.feedback_submitted_at && !sbPending.has(r.deal_id)) {
        sbPending.set(r.deal_id, { shareToken: r.share_token, storyboardTitle: r.storyboard_title });
      }
    }
  }

  return { proposals, videos, revPending, sbPending, revLinks, sbLinks };
}

function nextStepFor(deal, states) {
  const prop = states.proposals.get(deal.id) || null;
  return deriveNextStep({
    deal,
    proposalId: prop?.id || null,
    signature: prop?.signature || null,
    revisionPending: states.revPending.get(deal.id) || null,
    storyboardPending: states.sbPending.get(deal.id) || null,
    videos: states.videos.get(deal.id) || [],
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

    // Everything else requires a portal session.
    const user = await requirePortalAuth(req, res);
    if (!user) return;

    switch (action) {
      case 'me': return meRoutes(req, res, user);
      case 'overview': return overviewRoute(req, res, user);
      case 'project': return projectRoute(req, res, user);
      case 'library': return libraryRoute(req, res, user);
      case 'download': return downloadRoute(req, res, user);
      case 'files': return filesRoutes(req, res, user);
      case 'extras': return extrasRoute(req, res, user);
      case 'extras-accept': return extrasAcceptRoute(req, res, user);
      case 'request-video': return requestVideoRoute(req, res, user);
      case 'po-number': return poNumberRoute(req, res, user);
      case 'team': return teamRoutes(req, res, user);
      case 'team-revoke-invite': return teamRevokeInviteRoute(req, res, user);
      case 'partner-interest': return partnerInterestRoute(req, res, user);
      default: return res.status(404).json({ error: 'Not found' });
    }
  } catch (err) {
    console.error('[portal] error', err);
    return res.status(500).json({ error: 'Request failed' });
  }
}

// ═════════════════════════ auth ═════════════════════════
async function authRoutes(req, res) {
  const op = req.query.op || null;

  // GET auth?op=invite-info&token= — minimal prefill for the accept screen.
  if (req.method === 'GET' && op === 'invite-info') {
    const raw = req.query.token ? String(req.query.token) : '';
    if (!raw) return res.status(400).json({ error: 'token required' });
    const rows = await sql`
      SELECT i.email, i.prefill, i.expires_at, i.accepted_at, i.revoked_at, c.name AS company_name
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
    await issuePortalSession(res, user);

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
        inAppOnly: true,
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
    await issuePortalSession(res, user);
    return res.status(200).json({ user: publicPortalUser(user) });
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
    await sendMail({
      to: email,
      subject: 'Your Squideo portal sign-in link',
      html: portalMagicLinkHtml({ loginUrl }),
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
    await issuePortalSession(res, user);
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
    await sendMail({
      to: email,
      subject: 'Reset your Squideo portal password',
      html: portalResetHtml({ resetUrl }),
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
    await issuePortalSession(res, user);
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
    return res.status(200).json({ user: publicPortalUser(user, user.companies) });
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
    const nextStep = nextStepFor(deal, states);
    const videos = (states.videos.get(deal.id) || []).map(serialisePortalVideo);
    const offers = extrasWindowOpen(deal) ? await computePortalOffers(deal) : [];
    projects.push(serialisePortalDeal(deal, {
      nextStep,
      videos,
      extrasAvailable: offers.length,
    }));
  }

  const [brandCount] = await sql`
    SELECT COUNT(*)::int AS n FROM portal_company_files WHERE company_id = ${companyId}
  `;
  const actionNeeded = projects.filter((p) => p.nextStep?.court === 'you').length;

  return res.status(200).json({
    company: user.companies.find((c) => c.id === companyId) || { id: companyId },
    companies: user.companies,
    projects,
    actionNeeded,
    brandFileCount: brandCount?.n || 0,
  });
}

// ═════════════════════════ project ═════════════════════════
async function projectRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const deal = await requireDealInOrg(res, req.query.dealId ? String(req.query.dealId) : null, user.companyIds);
  if (!deal) return;

  const states = await gatherDealStates([deal.id]);
  const nextStep = nextStepFor(deal, states);
  const prop = states.proposals.get(deal.id) || null;

  const files = await sql`
    SELECT id, filename, mime_type, size_bytes, portal_user_id, created_at
      FROM deal_files
     WHERE deal_id = ${deal.id} AND source = 'portal'
     ORDER BY created_at DESC
  `.catch(() => []);

  await ensureDealExtrasTable();
  const extras = await sql`
    SELECT id, description, amount, status, created_at
      FROM deal_extras WHERE deal_id = ${deal.id} AND source = 'portal'
     ORDER BY created_at DESC
  `;
  const offers = extrasWindowOpen(deal) ? await computePortalOffers(deal) : [];

  return res.status(200).json({
    project: serialisePortalDeal(deal, {
      nextStep,
      videos: (states.videos.get(deal.id) || []).map(serialisePortalVideo),
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
  const withDrive = deals.filter((d) => d.drive_folder_id);
  if (!withDrive.length) return res.status(200).json({ projects: [] });

  const token = await anyDriveAccessToken();
  if (!token) return res.status(200).json({ projects: [], unavailable: true });

  const projects = await Promise.all(withDrive.map(async (d) => {
    const files = await listSignedOffFiles(token, d.drive_folder_id);
    return {
      dealId: d.id,
      title: d.title,
      createdAt: d.created_at,
      files: files.map((f) => ({
        // Opaque per-request id; re-validated against a fresh org-scoped
        // listing at download time (never trusted as a raw Drive capability).
        fileId: f.driveFileId,
        name: f.name,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        createdTime: f.createdTime,
      })),
    };
  }));

  return res.status(200).json({ projects: projects.filter((p) => p.files.length > 0) });
}

// ═════════════════════════ download ═════════════════════════
async function downloadRoute(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const scope = req.query.scope ? String(req.query.scope) : null;
  const id = req.query.id ? String(req.query.id) : null;
  if (!scope || !id) return res.status(400).json({ error: 'scope and id required' });

  // Org/brand documents — signed private-blob URL, 302 redirect.
  if (scope === 'company') {
    const rows = await sql`
      SELECT blob_url, filename, company_id FROM portal_company_files WHERE id = ${id}
    `;
    const f = rows[0];
    if (!f || !user.companyIds.includes(f.company_id)) return res.status(404).json({ error: 'File not found' });
    const url = await getDownloadUrl(f.blob_url);
    res.setHeader('Location', url);
    return res.status(302).end();
  }

  // Per-project documents (portal uploads on deal_files).
  if (scope === 'deal') {
    const rows = await sql`
      SELECT f.blob_url, f.filename, d.company_id
        FROM deal_files f JOIN deals d ON d.id = f.deal_id
       WHERE f.id = ${id} AND f.source = 'portal'
    `;
    const f = rows[0];
    if (!f || !f.blob_url || !user.companyIds.includes(f.company_id)) return res.status(404).json({ error: 'File not found' });
    const url = await getDownloadUrl(f.blob_url);
    res.setHeader('Location', url);
    return res.status(302).end();
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
    return streamDriveFile(res, token, file.driveFileId, {
      filename: file.name,
      mimeType: file.mimeType,
      download: !inline,
    });
  }

  return res.status(400).json({ error: 'Unknown scope' });
}

// ═════════════════════════ files ═════════════════════════
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
    const companyId = resolveCompanyId(req, res, user);
    if (!companyId) return;
    const rows = await sql`
      SELECT f.id, f.category, f.filename, f.mime_type, f.size_bytes,
             f.uploaded_by_portal_user, f.created_at, pu.name AS uploaded_by_name
        FROM portal_company_files f
        LEFT JOIN portal_users pu ON pu.id = f.uploaded_by_portal_user
       WHERE f.company_id = ${companyId}
       ORDER BY f.created_at DESC
    `;
    return res.status(200).json({ files: rows.map(serialisePortalCompanyFile) });
  }

  if (req.method === 'POST') {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'File storage not configured' });
    const filename = decodeURIComponent(req.headers['x-filename'] || 'upload');
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (!UPLOAD_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: `That file type isn't supported (.${ext}). Try a PDF, doc, image or zip.` });
    }
    const mimeType = req.headers['content-type'] || 'application/octet-stream';
    const buf = await readRawBody(req);
    if (!buf.length) return res.status(400).json({ error: 'No file data received' });
    if (buf.length > MAX_FILE_SIZE) return res.status(413).json({ error: 'File too large (max 20 MB)' });

    // Deal-scoped documents land on deal_files (source='portal') so they show
    // in the CRM Files card automatically; brand/org docs live on their own table.
    let companyId, dealId = null;
    if (scope === 'deal') {
      const deal = await requireDealInOrg(res, req.query.dealId ? String(req.query.dealId) : null, user.companyIds);
      if (!deal) return;
      companyId = deal.company_id;
      dealId = deal.id;
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

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    let stored;
    if (dealId) {
      const fileId = crypto.randomUUID();
      const blob = await put(`deal-files/${dealId}/${fileId}/${safeName}`, buf, { access: 'private', contentType: mimeType });
      await sql`
        INSERT INTO deal_files (id, deal_id, filename, mime_type, size_bytes, blob_url, blob_pathname, uploaded_by, source, portal_user_id)
        VALUES (${fileId}, ${dealId}, ${filename}, ${mimeType}, ${buf.length}, ${blob.url}, ${blob.pathname}, NULL, 'portal', ${user.puid})
      `;
      stored = { id: fileId, filename, mimeType, sizeBytes: buf.length, createdAt: new Date().toISOString() };
    } else {
      const id = makeId('pcf');
      const category = req.query.category === 'document' ? 'document' : 'brand';
      const blob = await put(`portal-files/${companyId}/${id}/${safeName}`, buf, { access: 'private', contentType: mimeType });
      await sql`
        INSERT INTO portal_company_files (id, company_id, category, filename, mime_type, size_bytes, blob_url, blob_pathname, uploaded_by_portal_user)
        VALUES (${id}, ${companyId}, ${category}, ${filename}, ${mimeType}, ${buf.length}, ${blob.url}, ${blob.pathname}, ${user.puid})
      `;
      stored = { id, category, filename, mimeType, sizeBytes: buf.length, createdAt: new Date().toISOString() };
    }

    // Best-effort team ping (in-app only — uploads can be frequent).
    try {
      await ensurePortalNotificationDefaults();
      const [co] = await sql`SELECT name FROM companies WHERE id = ${companyId}`;
      await sendNotification('portal.doc_uploaded', {
        subject: `📎 ${user.name || user.email} uploaded ${filename}`,
        text: `${user.name || user.email} uploaded ${filename} via the client portal (${co?.name || companyId}).`,
        inApp: {
          title: `Client file: ${filename}`,
          body: `${user.name || user.email} · ${co?.name || ''}`,
          link: dealId ? `#/deal/${dealId}` : `#/company/${companyId}`,
        },
        inAppOnly: true,
      });
    } catch (err) {
      console.warn('[portal] doc_uploaded notify failed', err.message);
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
      if (f.portal_user_id !== user.puid) return res.status(403).json({ error: 'You can only remove files you uploaded' });
      if (f.blob_url) { try { await del(f.blob_url); } catch (err) { console.warn('[portal] blob delete failed', err.message); } }
      await sql`DELETE FROM deal_files WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }
    const rows = await sql`
      SELECT id, blob_url, uploaded_by_portal_user, company_id FROM portal_company_files WHERE id = ${id}
    `;
    const f = rows[0];
    if (!f || !user.companyIds.includes(f.company_id)) return res.status(404).json({ error: 'File not found' });
    if (f.uploaded_by_portal_user && f.uploaded_by_portal_user !== user.puid) {
      return res.status(403).json({ error: 'You can only remove files you uploaded' });
    }
    if (f.blob_url) { try { await del(f.blob_url); } catch (err) { console.warn('[portal] blob delete failed', err.message); } }
    await sql`DELETE FROM portal_company_files WHERE id = ${id}`;
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

// ═════════════════════════ request-video ═════════════════════════
async function requestVideoRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = await readJsonBody(req);
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;
  const projectDetails = trimOrNull(body.projectDetails);
  if (!projectDetails) return res.status(400).json({ error: 'Tell us a little about the video you need' });

  const company = user.companies.find((c) => c.id === companyId) || null;
  const id = crypto.randomUUID();
  const createdAt = new Date();

  // Identity comes from the SESSION, never the request body — the CRM sees
  // exactly who asked, and the row is pre-linked to the org.
  const qr = {
    id,
    name: user.name || user.email,
    email: user.email,
    phone: user.phone || null,
    company: company?.name || null,
    project_details: projectDetails,
    timeline: trimOrNull(body.timeline),
    budget: trimOrNull(body.budget),
    opt_in: false,
    source_url: `${PORTAL_URL}#/request`,
    created_at: createdAt,
    country_code: null,
    country_name: null,
  };
  await sql`
    INSERT INTO quote_requests (
      id, name, email, phone, company, project_details, timeline, budget,
      opt_in, source_url, created_at, source, portal_user_id, portal_discount, company_id
    ) VALUES (
      ${qr.id}, ${qr.name}, ${qr.email}, ${qr.phone}, ${qr.company},
      ${qr.project_details}, ${qr.timeline}, ${qr.budget}, ${qr.opt_in},
      ${qr.source_url}, ${qr.created_at}, 'portal', ${user.puid}, TRUE, ${companyId}
    )
  `;

  // Attach any files already uploaded via the public quote upload endpoint.
  const storedFiles = [];
  const files = Array.isArray(body.files) ? body.files.slice(0, 5) : [];
  for (const f of files) {
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
  const subject = `New portal quote request (10% discount) from ${qr.name}${qr.company ? ` — ${qr.company}` : ''}`;
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
      html: buildNotificationEmail(qr, storedFiles, { qualifyUrl, disqualifyUrl, crmUrl, leadLabel: 'portal quote request (10% discount)' }),
    });
  }));
  if (subscribed.length) {
    await persistInApp('quote_request.new', subscribed, {
      subject,
      inApp: {
        title: subject,
        body: [qr.company, qr.budget, qr.timeline, 'Portal · 10% discount'].filter(Boolean).join(' · '),
        link: '#/quote-requests',
      },
    });
  }

  return res.status(201).json({ ok: true, id });
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
    return res.status(200).json({
      members: members.filter((m) => !m.disabled_at && !m.membership_disabled_at).map(serialisePortalMember),
      invites: invites.map(serialisePortalInvite),
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
        inviterName: user.name || user.email,
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

// ═════════════════════════ partner-interest ═════════════════════════
async function partnerInterestRoute(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const companyId = resolveCompanyId(req, res, user);
  if (!companyId) return;
  const company = user.companies.find((c) => c.id === companyId) || null;
  try {
    await ensurePortalNotificationDefaults();
    await sendNotification('portal.partner_interest', {
      subject: `🤝 Partner Programme interest — ${company?.name || user.email}`,
      text: `${user.name || user.email} (${company?.name || 'client portal'}) clicked "I'm interested" on the Partner Programme card in the client portal. Reach out!`,
      inApp: {
        title: 'Partner Programme interest',
        body: `${user.name || user.email} · ${company?.name || ''}`,
        link: `#/company/${companyId}`,
      },
    });
  } catch (err) {
    console.warn('[portal] partner_interest notify failed', err.message);
    return res.status(502).json({ error: 'Could not send — try again shortly' });
  }
  return res.status(200).json({ ok: true });
}
