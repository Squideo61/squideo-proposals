// Consolidated proposals endpoint. Handles:
//   GET    /api/proposals                 — list (auth)
//   GET    /api/proposals/:id             — public single read
//   PUT    /api/proposals/:id             — save + auto-create-deal (auth)
//   DELETE /api/proposals/:id             — delete (auth)
import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';
import { getRole } from '../_lib/userRoles.js';
import { hasPermission } from '../_lib/permissions.js';
import { ensureDealForProposal, advanceStage } from '../_lib/dealStage.js';

// Allowlist of fields the public client view (ClientView + ThankYouView +
// SignedBlock + printProposal) actually consumes. The full `data` JSONB on
// `proposals` is auth-only — anything not enumerated here must not leak to the
// unauthenticated GET. Add new fields explicitly as the client viewer evolves.
const PUBLIC_PROPOSAL_FIELDS = [
  'clientName', 'contactBusinessName', 'clientLogo',
  'proposalTitle', 'date', 'expiryDate', 'validityDays',
  'preparedBy', 'preparedByTitle', 'preparedByEmail',
  'showIntro', 'introHeading', 'intro', 'team', 'requirement', 'requirementSummary', 'projectVision',
  'basePrice', 'videoOptions', 'baseInclusions', 'optionalExtras',
  'partnerProgramme',
  'processVideoUrl', 'showProcessVideo',
  'notableExamples', 'showNotableExamples',
  'vatRate', 'paymentOptions', 'paymentOptionDescs',
];

function publicProposalView(data) {
  const src = data || {};
  const out = {};
  for (const k of PUBLIC_PROPOSAL_FIELDS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse the proposal id from req.url directly (Vercel's req.query.path has
  // proven unreliable for non-optional catch-all routes). The parent route
  // /api/proposals is rewritten in vercel.json to /api/proposals/_root, which
  // we treat as the no-id collection request.
  const urlPath = (req.url || '').split('?')[0];
  const segs = urlPath.split('/').filter(Boolean).slice(2); // strip 'api', 'proposals'
  const first = segs[0] || null;
  const id = first === '_root' ? null : first;

  // --- Collection routes (no id) ---
  if (!id) {
    if (req.method !== 'GET') return res.status(405).end();
    const user = await requireAuth(req, res);
    if (!user) return;
    return list(req, res);
  }

  // --- Item routes (with id) ---

  if (req.method === 'GET') {
    // Public — clients read their proposal without auth.
    const rows = await sql`
      SELECT data, number_year, number_seq, deal_id
      FROM proposals WHERE id = ${id}
    `;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    return res.status(200).json({
      ...publicProposalView(r.data),
      _number: r.number_year && r.number_seq ? { year: r.number_year, seq: r.number_seq } : null,
      _dealId: r.deal_id || null,
    });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  if (req.method === 'PUT') {
    const body = req.body || {};
    // `_dealId` is a side-channel pre-link from the caller (e.g. the CRM
    // "create proposal from deal" button). It's not part of the proposal's
    // own data — pull it out before we persist.
    const presetDealId = typeof body._dealId === 'string' && body._dealId ? body._dealId : null;
    const presetContactId = typeof body._contactId === 'string' && body._contactId ? body._contactId : null;
    const presetCompanyId = typeof body._companyId === 'string' && body._companyId ? body._companyId : null;
    const data = { ...body };
    delete data._dealId;
    // Keep _contactId / _companyId IN the persisted data so refreshing the
    // proposal rehydrates the link; the auto-deal sync below uses the
    // hoisted local copies for INSERT/UPDATE column values.
    data._contactId = presetContactId;
    data._companyId = presetCompanyId;
    const y = new Date().getFullYear();
    await sql`
      INSERT INTO proposals (id, data, updated_at, number_year, number_seq)
      VALUES (
        ${id}, ${JSON.stringify(data)}, NOW(), ${y},
        COALESCE(
          (SELECT MAX(number_seq) + 1 FROM proposals WHERE number_year = ${y}),
          1
        )
      )
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `;
    // If the caller pre-linked a deal, set deal_id BEFORE the auto-create
    // block below runs — that's what suppresses the auto-deal creation.
    if (presetDealId) {
      await sql`
        UPDATE proposals SET deal_id = ${presetDealId}
        WHERE id = ${id} AND deal_id IS NULL
      `;
    }

    // Auto-create-deal on first save, then keep the deal's value + title in
    // sync with the proposal on every subsequent save so editing basePrice
    // doesn't leave a stale £1,250 (the DEFAULT_PROPOSAL price) on the deal.
    // We only sync when the deal id matches the auto-created form
    // (`deal_<proposalId>`) so a manually-created deal that someone later
    // linked to this proposal keeps its hand-set value.
    let createdDealId = null;
    try {
      const meta = await sql`SELECT deal_id FROM proposals WHERE id = ${id}`;
      const hasDeal = !!meta[0]?.deal_id;
      const expectedAutoDealId = 'deal_' + id;
      const title = (data.contactBusinessName || data.clientName || 'Untitled deal').toString().slice(0, 200);
      const ownerEmail = data.preparedByEmail || user.email || null;
      const value = Number.isFinite(Number(data.basePrice)) ? Number(data.basePrice) : null;

      if (!hasDeal) {
        const inserted = await sql`
          INSERT INTO deals (id, title, primary_contact_id, company_id, owner_email, stage, value, last_activity_at)
          VALUES (${expectedAutoDealId}, ${title}, ${presetContactId}, ${presetCompanyId}, ${ownerEmail}, 'proposal_sent', ${value}, NOW())
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `;
        if (inserted.length) {
          await sql`
            INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
            VALUES (${expectedAutoDealId}, 'deal_created', ${JSON.stringify({ source: 'proposal', proposalId: id, title })}, ${user.email || null})
          `;
          createdDealId = expectedAutoDealId;
        }
        await sql`UPDATE proposals SET deal_id = ${expectedAutoDealId} WHERE id = ${id} AND deal_id IS NULL`;
      } else if (meta[0].deal_id === expectedAutoDealId) {
        // Don't clobber the signed total ex-VAT that the sign flow wrote onto
        // deals.value — only sync from basePrice while the proposal is still
        // unsigned. Once signed, the value reflects extras/partner discount,
        // which we don't want to lose on every subsequent edit.
        const isSigned = (await sql`SELECT 1 FROM signatures WHERE proposal_id = ${id} LIMIT 1`).length > 0;
        if (isSigned) {
          await sql`
            UPDATE deals
               SET title = ${title},
                   primary_contact_id = COALESCE(primary_contact_id, ${presetContactId}),
                   company_id = COALESCE(company_id, ${presetCompanyId}),
                   updated_at = NOW()
             WHERE id = ${expectedAutoDealId}
          `;
        } else {
          await sql`
            UPDATE deals
               SET title = ${title},
                   value = ${value},
                   primary_contact_id = COALESCE(primary_contact_id, ${presetContactId}),
                   company_id = COALESCE(company_id, ${presetCompanyId}),
                   updated_at = NOW()
             WHERE id = ${expectedAutoDealId}
          `;
        }
      }
    } catch (err) {
      console.error('[proposals] auto-create deal failed', err);
    }

    const rows = await sql`SELECT number_year, number_seq, deal_id FROM proposals WHERE id = ${id}`;
    const n = rows[0];
    return res.status(200).json({
      ok: true,
      number: n && n.number_year && n.number_seq ? { year: n.number_year, seq: n.number_seq } : null,
      dealId: n?.deal_id || null,
      dealCreated: !!createdDealId,
    });
  }

  if (req.method === 'PATCH') {
    // Link (or unlink) this proposal to an existing CRM deal. Linking sets
    // proposals.deal_id and ratchets the deal forward to mirror the proposal's
    // current lifecycle point — after that the regular view/sign/pay hooks
    // (which key off proposal.deal_id) drive the remaining stages automatically.
    const body = req.body || {};
    if (!('dealId' in body)) return res.status(400).json({ error: 'dealId required' });
    const newDealId = body.dealId ? String(body.dealId) : null;

    const beforeRows = await sql`SELECT deal_id FROM proposals WHERE id = ${id}`;
    if (!beforeRows.length) return res.status(404).json({ error: 'Proposal not found' });
    const oldDealId = beforeRows[0].deal_id || null;

    if (newDealId) {
      const dealRows = await sql`SELECT id FROM deals WHERE id = ${newDealId}`;
      if (!dealRows.length) return res.status(404).json({ error: 'Deal not found' });
    }
    await sql`UPDATE proposals SET deal_id = ${newDealId}, updated_at = NOW() WHERE id = ${id}`;

    // If the proposal was attached only to its own auto-created shadow deal
    // (deterministic id `deal_<proposalId>`), re-linking it to a real deal
    // leaves that shadow orphaned — delete it, mirroring the DELETE cleanup, so
    // the pipeline doesn't show a duplicate "Untitled deal".
    if (oldDealId && oldDealId !== newDealId && oldDealId === 'deal_' + id) {
      try {
        const stillLinked = await sql`SELECT 1 FROM proposals WHERE deal_id = ${oldDealId} LIMIT 1`;
        if (!stillLinked.length) await sql`DELETE FROM deals WHERE id = ${oldDealId}`;
      } catch (err) {
        console.error('[proposals] orphan auto-deal cleanup failed', err.message);
      }
    }

    let advanced = null;
    if (newDealId) {
      // Work out the furthest point the proposal already reached so the deal
      // jumps straight to it (advanceStage only ever moves forward).
      let target = 'proposal_sent';
      try {
        const viewed = (await sql`SELECT 1 FROM proposal_views WHERE proposal_id = ${id} LIMIT 1`).length > 0;
        const signed = (await sql`SELECT 1 FROM signatures WHERE proposal_id = ${id} LIMIT 1`).length > 0;
        let paid = false;
        try {
          await ensurePbPaidColumn();
          const paidRows = await sql`
            SELECT (
                (SELECT COALESCE(SUM(amount),0) FROM payments WHERE proposal_id = ${id} AND paid_at IS NOT NULL)
              + COALESCE((SELECT paid_amount FROM proposal_billing WHERE proposal_id = ${id}), 0)
              + (SELECT COALESCE(SUM(amount),0) FROM manual_payments WHERE proposal_id = ${id} AND manual_invoice_id IS NULL)
              + (SELECT COALESCE(SUM(amount),0) FROM manual_invoices WHERE proposal_id = ${id} AND status = 'paid')
              + (SELECT COALESCE(SUM(amount),0) FROM partner_invoices WHERE proposal_id = ${id})
            ) AS paid_total
          `;
          paid = Number(paidRows[0]?.paid_total || 0) > 0;
        } catch (err) {
          console.error('[proposals] link paid-check failed', err.message);
        }
        if (viewed) target = 'viewed';
        if (signed) target = 'signed';
        if (paid) target = 'paid';
      } catch (err) {
        console.error('[proposals] link state-check failed', err.message);
      }
      try {
        advanced = await advanceStage(newDealId, target, {
          actorEmail: user.email || null,
          payload: { proposalId: id, source: 'link' },
        });
        await sql`
          INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
          VALUES (${newDealId}, 'proposal_linked', ${JSON.stringify({ proposalId: id })}, ${user.email || null})
        `;
      } catch (err) {
        console.error('[proposals] link advanceStage failed', err);
      }
    }
    return res.status(200).json({ ok: true, dealId: newDealId, advanced });
  }

  if (req.method === 'DELETE') {
    // Users with proposals.manage_all can delete anything. Others can
    // delete proposals they own (preparedByEmail matches their login).
    const role = await getRole(user.role);
    if (!hasPermission(role, 'proposals.manage_all')) {
      const rows = await sql`SELECT data->>'preparedByEmail' AS owner FROM proposals WHERE id = ${id}`;
      const owner = rows[0]?.owner || null;
      if (!owner || !user.email || owner.toLowerCase() !== user.email.toLowerCase()) {
        return res.status(403).json({ error: 'You can only delete proposals you created' });
      }
    }
    // Cascade-clean the auto-created `deal_<proposalId>`. We only delete it
    // when it still has the deterministic id (i.e. nobody manually re-linked
    // the proposal to a hand-made deal) and the deal has no other proposals
    // hanging off it. Without this, deleted proposals leave behind orphan
    // "Untitled deal" rows that show up in the CRM list and the Gmail
    // extension's deal nav.
    const autoDealId = 'deal_' + id;
    await sql`DELETE FROM proposals WHERE id = ${id}`;
    const stillLinked = await sql`SELECT 1 FROM proposals WHERE deal_id = ${autoDealId} LIMIT 1`;
    if (!stillLinked.length) {
      await sql`DELETE FROM deals WHERE id = ${autoDealId}`;
    }
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
}

// Self-heal: proposal_billing.paid_amount (db/migrations/20260603_proposal_billing_paid.sql)
// is referenced below to surface Xero-paid deposits on the list.
// Signed project value ex-VAT (mirrors computeProposalTotalExVat without pulling
// in the heavy crm/deals module). Used to set a backfilled deal's value.
function signedValueExVat(data, sig) {
  const projectExVat = sig?.amountBreakdown?.projectExVat;
  if (projectExVat != null && Number.isFinite(Number(projectExVat))) return Number(projectExVat);
  if (sig?.total != null && Number.isFinite(Number(sig.total))) {
    return Number(sig.total) / (1 + (Number(data?.vatRate) || 0));
  }
  return Number.isFinite(Number(data?.basePrice)) ? Number(data.basePrice) : null;
}

let pbPaidColEnsured = null;
function ensurePbPaidColumn() {
  if (pbPaidColEnsured) return pbPaidColEnsured;
  pbPaidColEnsured = sql`ALTER TABLE proposal_billing ADD COLUMN IF NOT EXISTS paid_amount NUMERIC`
    .then(() => {}).catch((err) => { pbPaidColEnsured = null; throw err; });
  return pbPaidColEnsured;
}

async function list(req, res) {
  await ensurePbPaidColumn();
  const rows = await sql`
    SELECT p.id, p.data, p.created_at, p.updated_at,
           p.number_year, p.number_seq, p.deal_id,
           COALESCE(v.opens, 0)    AS view_opens,
           COALESCE(v.duration, 0) AS view_duration,
           v.last_active_at        AS view_last_active,
           pb.xero_invoice_id      AS billing_invoice_id,
           pb.xero_quote_id        AS billing_quote_id,
           s.name                  AS sig_name,
           s.email                 AS sig_email,
           s.signed_at             AS sig_signed_at,
           s.data                  AS sig_data,
           pay.amount              AS pay_amount,
           pay.payment_type        AS pay_type,
           pay.paid_at             AS pay_paid_at,
           pay.stripe_session_id   AS pay_session_id,
           pay.customer_email      AS pay_customer_email,
           pay.receipt_url         AS pay_receipt_url,
           pay.xero_invoice_id     AS pay_xero_invoice_id,
           -- Total paid across every source, so a Xero/manual deposit shows up
           -- on the card even when there is no Stripe payments row.
           ( (SELECT COALESCE(SUM(amount),0) FROM payments WHERE proposal_id = p.id AND paid_at IS NOT NULL)
           + COALESCE(pb.paid_amount, 0)
           + (SELECT COALESCE(SUM(amount),0) FROM manual_payments WHERE proposal_id = p.id AND manual_invoice_id IS NULL)
           + (SELECT COALESCE(SUM(amount),0) FROM manual_invoices WHERE proposal_id = p.id AND status = 'paid')
           + (SELECT COALESCE(SUM(amount),0) FROM partner_invoices WHERE proposal_id = p.id)
           ) AS paid_total
    FROM proposals p
    LEFT JOIN (
      SELECT proposal_id,
             COUNT(*)               AS opens,
             SUM(duration_seconds)  AS duration,
             MAX(last_active_at)    AS last_active_at
      FROM proposal_views
      GROUP BY proposal_id
    ) v ON v.proposal_id = p.id
    LEFT JOIN proposal_billing pb ON pb.proposal_id = p.id
    LEFT JOIN signatures s ON s.proposal_id = p.id
    LEFT JOIN payments pay ON pay.proposal_id = p.id
    ORDER BY p.created_at DESC
  `;
  // Backfill: a signed proposal must have a deal card. If the save-time auto-
  // create never ran, create the deal now and move it to 'signed'. Idempotent
  // and rare — only touches signed proposals that still have no deal.
  const orphanRows = rows.filter((r) => r.sig_signed_at && !r.deal_id);
  const backfilled = new Set();
  for (const r of orphanRows) {
    try {
      const dealId = await ensureDealForProposal(r.id);
      if (dealId) {
        await advanceStage(dealId, 'signed', { payload: { proposalId: r.id, source: 'backfill' } });
        const v = signedValueExVat(r.data, r.sig_data);
        if (v != null && Number.isFinite(Number(v))) {
          await sql`UPDATE deals SET value = ${Number(v)} WHERE id = ${dealId}`;
        }
        backfilled.add(r.id);
      }
    } catch (err) {
      console.error('[proposals] backfill deal failed', r.id, err.message);
    }
  }

  const proposals = {};
  for (const row of rows) {
    proposals[row.id] = {
      ...row.data,
      _createdAt: row.created_at,
      _number: row.number_year && row.number_seq
        ? { year: row.number_year, seq: row.number_seq }
        : null,
      _dealId: row.deal_id || (backfilled.has(row.id) ? 'deal_' + row.id : null),
      _views: {
        opens: Number(row.view_opens) || 0,
        duration: Number(row.view_duration) || 0,
        lastActiveAt: row.view_last_active || null,
      },
      _paidAmount: Number(row.paid_total) || 0,
      _xeroInvoiceId: row.billing_invoice_id || row.pay_xero_invoice_id || null,
      _hasXeroInvoice: !!(row.billing_invoice_id || row.pay_xero_invoice_id),
      _hasXeroQuote: !!row.billing_quote_id,
      _signature: row.sig_signed_at
        ? { name: row.sig_name, email: row.sig_email, signedAt: row.sig_signed_at, ...(row.sig_data || {}) }
        : null,
      _payment: row.pay_paid_at
        ? {
            amount: row.pay_amount,
            paymentType: row.pay_type,
            paidAt: row.pay_paid_at,
            stripeSessionId: row.pay_session_id,
            customerEmail: row.pay_customer_email,
            receiptUrl: row.pay_receipt_url,
          }
        : null,
    };
  }
  return res.status(200).json(proposals);
}
