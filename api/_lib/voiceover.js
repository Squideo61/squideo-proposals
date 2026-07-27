// Voiceover artist catalogue — shared by the staff admin CRUD (api/_lib/crm/
// voiceovers.js) and the customer portal (api/portal.js). The catalogue is
// GLOBAL: the same artists for every project, split into two sections
// (category 'ai' | 'human') matching squideo.com/squideo-voiceovers. One sample
// clip per artist lives in private Vercel Blob and is streamed back through the
// API (the store is private — its raw URL 403s; see [[project_blob_private]]).

import { put, del, get as blobGet } from '@vercel/blob';
import sql from './db.js';
import { loadDealProposalState } from './portal/extrasOffers.js';
import { voiceoverProposalContext } from './proposalPricing.js';
import { makeId } from './crm/shared.js';
import { ensureDealExtrasTable } from './crm/extras.js';
import { sendMail } from './email.js';
import { sendNotification, ensurePortalNotificationDefaults } from './notifications.js';
import { emailLogoUrl } from './portal/logo.js';
import { portalVoiceoverConfirmHtml } from './portal/emails.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const sectionName = (cat) => (cat === 'ai' ? 'AI' : cat === 'premium' ? 'Premium' : 'Professional');

export const VOICEOVER_CATEGORIES = ['ai', 'human', 'premium'];
// Audio the browser's <audio> element can play, mapped to a content type.
export const VOICEOVER_MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
};
const BLOB_PREFIX = 'voiceover-samples';

// ── Self-heal (db/migrations/20260727_voiceover_catalogue.sql) ───────────────
// Module-cached; a successful first call short-circuits for the instance's
// lifetime. Never rejects into callers permanently — resets the cache on error
// so a later request retries, per [[feedback_selfheal_nonfatal]].
let catalogueEnsured = null;
export function ensureVoiceoverCatalogue() {
  if (catalogueEnsured) return catalogueEnsured;
  catalogueEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS voiceover_artists (
        id            TEXT        PRIMARY KEY,
        category      TEXT        NOT NULL DEFAULT 'human',
        name          TEXT        NOT NULL,
        description   TEXT,
        blob_url      TEXT,
        blob_pathname TEXT,
        mime_type     TEXT,
        size_bytes    BIGINT,
        sort_order    INTEGER     NOT NULL DEFAULT 0,
        archived_at   TIMESTAMPTZ,
        created_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS voiceover_artists_list_idx
                ON voiceover_artists (category, sort_order, created_at)`;
    // Per-video selection columns. Mirrored in ensureProductionSchema() on the
    // CRM side; added here too so the portal (a separate function) self-heals
    // even if no CRM request has run on this instance. A non-null artist id =
    // locked. See [[feedback_selfheal_nonfatal]].
    await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS voiceover_artist_id TEXT`;
    await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS voiceover_selected_at TIMESTAMPTZ`;
    await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS voiceover_selected_by TEXT`;
  })().catch((err) => { catalogueEnsured = null; throw err; });
  return catalogueEnsured;
}

export function serialiseArtist(a) {
  return {
    id: a.id,
    category: a.category || 'human',
    name: a.name,
    description: a.description || null,
    hasSample: !!(a.blob_url || a.blob_pathname),
    mimeType: a.mime_type || null,
    sizeBytes: a.size_bytes == null ? null : Number(a.size_bytes),
    sortOrder: a.sort_order ?? 0,
    archivedAt: a.archived_at || null,
    createdAt: a.created_at,
  };
}

// One artist row by id, or null.
export async function getArtist(id) {
  if (!id) return null;
  const [row] = await sql`SELECT * FROM voiceover_artists WHERE id = ${id}`;
  return row || null;
}

// Store (or replace) an artist's sample clip in private Blob. Deletes the old
// blob first so we don't leak orphans. Returns the updated row.
export async function putArtistSample(artistId, buffer, { filename, ext }) {
  const mime = VOICEOVER_MIME[ext] || 'application/octet-stream';
  const existing = await getArtist(artistId);
  if (existing?.blob_url) {
    try { await del(existing.blob_url); } catch (err) { console.error('[voiceover] old sample delete failed', err.message); }
  }
  const safeName = String(filename || `sample.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const blob = await put(`${BLOB_PREFIX}/${artistId}/${safeName}`, buffer, { access: 'private', contentType: mime });
  const [row] = await sql`
    UPDATE voiceover_artists
       SET blob_url = ${blob.url}, blob_pathname = ${blob.pathname},
           mime_type = ${mime}, size_bytes = ${buffer.length}, updated_at = NOW()
     WHERE id = ${artistId}
     RETURNING *`;
  return row;
}

// ── Eligibility + pricing ────────────────────────────────────────────────────
// The catalogue is one thing; WHICH sections a client sees and what each pick
// COSTS depends on their signed proposal:
//   • A project always includes an AI voice as standard — unless that inclusion
//     was removed from the proposal, in which case there's no voiceover at all.
//   • AI-standard client: sees AI (free), Human (proposal's VO extra price),
//     Premium (flat premium price).
//   • Client who bought the Human VO extra: sees Human (included) + Premium
//     (premium price minus what they already paid) — not AI.
// The charge for a tier is always the DIFFERENCE from what they already have.
// Server is the pricing authority — the client never sends an amount.

async function premiumPriceFromSettings() {
  try {
    const [row] = await sql`SELECT voiceover_pricing FROM settings WHERE id = 1`;
    const n = Number(row?.voiceover_pricing?.premiumPrice);
    return Number.isFinite(n) && n > 0 ? round2(n) : null;
  } catch { return null; }
}

// Returns:
//   { hasVo, entitlement:'ai'|'human', sections:[...], charges:{ai,human,premium},
//     paymentMode:'now'|'final', humanPrice, premiumPrice }
// charges are ex-VAT £, or null when a tier can't be priced (→ not selectable).
export async function resolveVoiceoverContext(deal) {
  const state = await loadDealProposalState(deal.id);
  const ctx = voiceoverProposalContext(state?.data, state?.signature_data);
  const premiumPrice = await premiumPriceFromSettings();

  const hasVo = ctx.aiIncluded || ctx.humanPurchased;
  const entitlement = ctx.humanPurchased ? 'human' : 'ai';
  const entitlementPrice = ctx.humanPurchased ? (ctx.humanPaid ?? ctx.humanPrice ?? 0) : 0;
  const humanPrice = ctx.humanPrice ?? ctx.humanPaid ?? null;
  const tierPrice = { ai: 0, human: humanPrice, premium: premiumPrice };

  const sections = [];
  if (entitlement === 'ai' && ctx.aiIncluded) sections.push('ai');
  if (ctx.humanPurchased || humanPrice != null) sections.push('human');
  if (premiumPrice != null) sections.push('premium');

  const chargeFor = (cat) => {
    const p = tierPrice[cat];
    if (p == null) return null;
    return round2(Math.max(0, p - entitlementPrice));
  };
  const charges = { ai: chargeFor('ai'), human: chargeFor('human'), premium: chargeFor('premium') };

  // PO rides the final invoice; full / 50-50 pay now by card.
  const paymentMode = ctx.paymentOption === 'po' ? 'final' : 'now';

  return { hasVo, entitlement, sections, charges, paymentMode, humanPrice, premiumPrice };
}

// The portal shape for a video + its voiceover pick (shared by every route that
// returns the video list).
export function shapePortalVoiceoverVideo(v) {
  return {
    id: v.id,
    title: v.title,
    videoNumber: v.video_number ?? null,
    voiceover: v.voiceover_artist_id
      ? { artistId: v.voiceover_artist_id, artistName: v.voiceover_artist_name || 'Selected artist', category: v.voiceover_category || null, locked: true }
      : null,
  };
}

// Set the pick on one video (or every not-yet-locked video when applyToAll).
// Returns the refreshed, portal-shaped video list. Used by the immediate select
// path AND the Stripe webhook (after a paid upgrade).
export async function applyVoiceoverSelection({ dealId, videoId, artistId, applyToAll, portalUserId = null }) {
  if (applyToAll) {
    await sql`
      UPDATE project_videos
         SET voiceover_artist_id = ${artistId}, voiceover_selected_at = NOW(),
             voiceover_selected_by = ${portalUserId}, updated_at = NOW()
       WHERE deal_id = ${dealId} AND voiceover_artist_id IS NULL`;
  } else {
    await sql`
      UPDATE project_videos
         SET voiceover_artist_id = ${artistId}, voiceover_selected_at = NOW(),
             voiceover_selected_by = ${portalUserId}, updated_at = NOW()
       WHERE id = ${videoId} AND deal_id = ${dealId} AND voiceover_artist_id IS NULL`;
  }
  const videos = await sql`
    SELECT v.id, v.title, v.video_number,
           v.voiceover_artist_id, va.name AS voiceover_artist_name, va.category AS voiceover_category
      FROM project_videos v
      LEFT JOIN voiceover_artists va ON va.id = v.voiceover_artist_id
     WHERE v.deal_id = ${dealId}
     ORDER BY v.sort_order ASC, v.created_at ASC`;
  return videos.map(shapePortalVoiceoverVideo);
}

// Record a voiceover-upgrade charge on the deal's extras. `paid` distinguishes a
// PO / final-invoice charge (pending, rides the final bill) from a card-paid one
// (paid, logged from the Stripe webhook).
export async function recordVoiceoverExtra({ dealId, artist, videoLabel, applyToAll, amount, paid, portalUserId = null }) {
  await ensureDealExtrasTable();
  const scope = applyToAll ? 'all videos' : videoLabel;
  const description = `${sectionName(artist.category)} voiceover — ${artist.name} (${scope})${paid ? ' — paid by card' : ''}`;
  await sql`
    INSERT INTO deal_extras (id, deal_id, description, amount, vat_rate, status, payment_type, created_by, source, portal_user_id, paid_at)
    VALUES (${makeId('xtr')}, ${dealId}, ${description}, ${amount}, NULL, ${paid ? 'paid' : 'pending'}, ${paid ? 'invoice_now' : 'final'}, NULL, 'portal', ${portalUserId}, ${paid ? new Date().toISOString() : null})
  `;
}

// Team alert when a client picks a voice (with any charge).
export async function notifyVoiceoverChosen({ deal, actorName, artist, videoLabel, applyToAll, charge, paidNow }) {
  try {
    await ensurePortalNotificationDefaults();
    const money = charge > 0 ? ` — ${paidNow ? 'paid' : 'to bill'} £${Number(charge).toFixed(2)}` : '';
    await sendNotification('portal.voiceover_selected', {
      subject: `🎙️ Voiceover chosen: ${artist.name} — ${deal.title}`,
      text: `${actorName} chose ${artist.name} (${sectionName(artist.category)}) for ${applyToAll ? 'all videos' : videoLabel} on ${deal.title}${money}.`,
      inApp: {
        title: `Voiceover: ${artist.name}${charge > 0 ? ` (£${Number(charge).toFixed(2)}${paidNow ? ' paid' : ''})` : ''}`,
        body: `${actorName} · ${applyToAll ? 'all videos' : videoLabel} · ${deal.title}`,
        link: `#/deal/${deal.id}`,
      },
      inAppOnly: true,
    });
  } catch (err) {
    console.warn('[voiceover] selected notify failed', err.message);
  }
}

// Client confirmation email (best-effort).
export async function emailVoiceoverConfirm({ deal, clientEmail, clientName, artist, videoLabel, applyToAll }) {
  if (!clientEmail) return;
  try {
    await sendMail({
      to: clientEmail,
      subject: `Voiceover locked in for ${deal.title}`,
      html: portalVoiceoverConfirmHtml({
        logoUrl: await emailLogoUrl(deal.company_id),
        clientName,
        projectTitle: deal.title,
        artistName: artist.name,
        videoLabel,
        appliedToAll: applyToAll,
      }),
      text: `You chose ${artist.name} for ${applyToAll ? 'all videos in' : videoLabel + ' on'} ${deal.title}.`,
    });
  } catch (err) {
    console.warn('[voiceover] confirm email failed', err.message);
  }
}

// Called by the Stripe webhook after a paid voiceover upgrade completes: apply
// the pick, log the paid extra, notify the team + client. Idempotent-ish — if
// the target video is already locked, applyVoiceoverSelection no-ops it.
export async function completeVoiceoverUpgrade(meta) {
  const dealId = meta.dealId;
  const artistId = meta.artistId;
  const videoId = meta.videoId;
  const applyToAll = meta.applyToAll === 'true' || meta.applyToAll === true;
  const amount = round2(meta.amount);
  if (!dealId || !artistId || !videoId) return;

  const [deal] = await sql`SELECT id, title, company_id, reference FROM deals WHERE id = ${dealId}`;
  const artist = await getArtist(artistId);
  const [video] = await sql`SELECT id, title, video_number, voiceover_artist_id FROM project_videos WHERE id = ${videoId} AND deal_id = ${dealId}`;
  if (!deal || !artist || !video) { console.warn('[voiceover] upgrade webhook: missing deal/artist/video'); return; }
  // Idempotency: Stripe may retry the webhook. If this pick is already locked in
  // (first delivery processed it), don't re-apply or double-record the charge.
  if (video.voiceover_artist_id) return;

  const videoLabel = deal.reference && video.video_number
    ? `${deal.reference}-${String(video.video_number).padStart(2, '0')}`
    : (video.title || 'your video');

  await applyVoiceoverSelection({ dealId, videoId, artistId, applyToAll, portalUserId: meta.portalUserId || null });
  if (amount > 0) {
    await recordVoiceoverExtra({ dealId, artist, videoLabel, applyToAll, amount, paid: true, portalUserId: meta.portalUserId || null });
  }
  // Look up the payer's email/name for the confirmation.
  let clientEmail = null, clientName = null;
  if (meta.portalUserId) {
    const [pu] = await sql`SELECT email, name FROM portal_users WHERE id = ${meta.portalUserId}`;
    clientEmail = pu?.email || null; clientName = pu?.name || null;
  }
  await notifyVoiceoverChosen({ deal, actorName: clientName || clientEmail || 'The client', artist, videoLabel, applyToAll, charge: amount, paidNow: true });
  await emailVoiceoverConfirm({ deal, clientEmail, clientName, artist, videoLabel, applyToAll });
}

// Stream an artist's sample back to the browser for an <audio> element. Honours
// a Range request so the scrubber can seek (the plain proxies elsewhere don't).
// Reads the whole (small) clip once, then slices — samples are a few seconds.
export async function streamVoiceoverSample(req, res, artist) {
  if (!artist || (!artist.blob_url && !artist.blob_pathname)) {
    return res.status(404).json({ error: 'No sample for this artist' });
  }
  const result = await blobGet(artist.blob_url || artist.blob_pathname, { access: 'private' });
  if (!result || !result.stream) return res.status(404).json({ error: 'Sample not found' });
  const full = Buffer.from(await new Response(result.stream).arrayBuffer());
  const type = artist.mime_type || 'audio/mpeg';
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=300');

  const range = req.headers?.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    const total = full.length;
    let start = m[1] === '' ? null : parseInt(m[1], 10);
    let end = m[2] === '' ? null : parseInt(m[2], 10);
    if (start === null) { start = total - end; end = total - 1; }   // suffix range
    else if (end === null) { end = total - 1; }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= total) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    const chunk = full.subarray(start, end + 1);
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', String(chunk.length));
    return res.end(chunk);
  }
  res.setHeader('Content-Length', String(full.length));
  return res.status(200).end(full);
}
