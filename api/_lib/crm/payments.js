// CRM payments handler. Two responsibilities:
//
//  1) Read rollups across the three payment sources (Stripe initial,
//     Partner Programme monthly, manually-recorded) scoped by deal /
//     contact / company.
//  2) CRUD for manually-recorded payments (BACS today, payment_method is
//     free text so cheque/cash can be added later without a migration).
//
// Stripe-initiated rows stay untouched in their existing tables — this
// module only writes to manual_payments.

import sql from '../db.js';
import { advanceStage, dealIdForProposal } from '../dealStage.js';
import { sendMail, paidHtml, APP_URL, adminEmailsExcluding } from '../email.js';
import { sendNotification } from '../notifications.js';
import { makeId, trimOrNull, lowerOrNull, numberOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { ensureManualPaymentLink, outstandingProposalInvoices } from './manualPaymentLink.js';

// ── Payment balance guard ────────────────────────────────────────────────────
// What a deal committed to (its signed inc-VAT total) versus what's already been
// recorded against it. Reads exactly the sources annotateDeals' saleStatus and
// the income reports use, so the guard, the "Paid"/"Deposit paid" pill and the
// cash figures can never disagree.
//
// This exists because recording a payment and marking an invoice paid are two
// separate actions with nothing tying them together, so the same money can be
// booked twice — enough to tip a 50% deposit to "paid in full". Never throws: a
// failure degrades to "no guard" rather than blocking a legitimate payment.
export async function dealPaymentBalance(dealId) {
  const empty = { dealId, committed: 0, paid: 0, remaining: null, known: false };
  if (!dealId) return empty;
  try {
    const [sigRows, payRows] = await Promise.all([
      sql`
        SELECT COALESCE(SUM((s.data->>'total')::numeric), 0) AS v
          FROM signatures s JOIN proposals p ON p.id = s.proposal_id
         WHERE p.deal_id = ${dealId}
           AND (s.data->>'total') ~ '^[0-9]+(\.[0-9]+)?$'`,
      sql`
        SELECT COALESCE(SUM(v), 0) AS v FROM (
          SELECT COALESCE(SUM(pay.amount), 0) AS v
            FROM payments pay JOIN proposals p ON p.id = pay.proposal_id
           WHERE p.deal_id = ${dealId}
          UNION ALL
          SELECT COALESCE(SUM(pi.amount), 0)
            FROM partner_invoices pi JOIN proposals p ON p.id = pi.proposal_id
           WHERE p.deal_id = ${dealId}
          UNION ALL
          SELECT COALESCE(SUM(mp.amount), 0)
            FROM manual_payments_counted mp JOIN proposals p ON p.id = mp.proposal_id
           WHERE mp.manual_invoice_id IS NULL AND p.deal_id = ${dealId}
          UNION ALL
          SELECT COALESCE(SUM(mi.amount), 0)
            FROM manual_invoices mi LEFT JOIN proposals pr ON pr.id = mi.proposal_id
           WHERE mi.status = 'paid' AND COALESCE(mi.deal_id, pr.deal_id) = ${dealId}
          UNION ALL
          SELECT COALESCE(SUM(pb.paid_amount), 0)
            FROM proposal_billing pb JOIN proposals p ON p.id = pb.proposal_id
           WHERE pb.paid_amount IS NOT NULL AND p.deal_id = ${dealId}
        ) q`,
    ]);
    const committed = Number(sigRows[0]?.v) || 0;
    const paid = Number(payRows[0]?.v) || 0;
    return {
      dealId,
      committed,
      paid,
      remaining: committed > 0 ? Math.max(0, committed - paid) : null,
      known: committed > 0,
    };
  } catch (err) {
    console.warn('[payments] balance lookup failed', err.message);
    return empty;
  }
}

// Manual invoices on a deal that a payment can be attached to, so the modal can
// offer a real list instead of asking for an invoice ID by hand — an unattached
// payment against an invoice that's separately marked paid is what double-books.
// Unpaid first: those are what a new payment usually settles.
async function invoicesForDeal(dealId) {
  if (!dealId) return [];
  try {
    const rows = await sql`
      SELECT mi.id, mi.invoice_number, mi.amount, mi.status, mi.issued_at,
             EXISTS (SELECT 1 FROM manual_payments mp WHERE mp.manual_invoice_id = mi.id) AS has_payment
        FROM manual_invoices mi
        LEFT JOIN proposals pr ON pr.id = mi.proposal_id
       WHERE COALESCE(mi.deal_id, pr.deal_id) = ${dealId} AND mi.status <> 'void'
       ORDER BY (mi.status = 'paid') ASC, mi.issued_at DESC NULLS LAST`;
    return rows.map((r) => ({
      id: r.id,
      invoiceNumber: r.invoice_number || null,
      amount: r.amount != null ? Number(r.amount) : null,
      status: r.status,
      issuedAt: r.issued_at || null,
      hasPayment: !!r.has_payment,
    }));
  } catch (err) {
    console.warn('[payments] invoice list failed', err.message);
    return [];
  }
}

export async function paymentsRoute(req, res, id, action, user) {
  // --- GET /api/crm/payments/balance?dealId= — what's committed vs already
  // recorded on a deal, plus the invoices a payment can attach to. Feeds the
  // "Record a payment" modal so it can warn before money is double-booked.
  if (id === 'balance' && req.method === 'GET') {
    const dealId = trimOrNull(req.query.dealId);
    if (!dealId) return res.status(400).json({ error: 'dealId required' });
    const [balance, invoices] = await Promise.all([
      dealPaymentBalance(dealId),
      invoicesForDeal(dealId),
    ]);
    return res.status(200).json({ ...balance, invoices });
  }

  // --- GET /api/crm/payments?dealId|contactId|companyId
  if (!id && req.method === 'GET') {
    const dealId    = trimOrNull(req.query.dealId);
    const contactId = trimOrNull(req.query.contactId);
    const companyId = trimOrNull(req.query.companyId);
    if (!dealId && !contactId && !companyId) {
      return res.status(400).json({ error: 'dealId, contactId, or companyId required' });
    }

    // Build the proposal-id whitelist once, then read from each source.
    let proposalIds;
    if (dealId) {
      const rows = await sql`SELECT id FROM proposals WHERE deal_id = ${dealId}`;
      proposalIds = rows.map(r => r.id);
    } else if (contactId) {
      const rows = await sql`
        SELECT pr.id FROM proposals pr
        JOIN deals d ON d.id = pr.deal_id
        WHERE d.primary_contact_id = ${contactId}
      `;
      proposalIds = rows.map(r => r.id);
    } else {
      const rows = await sql`
        SELECT pr.id FROM proposals pr
        JOIN deals d ON d.id = pr.deal_id
        WHERE d.company_id = ${companyId}
      `;
      proposalIds = rows.map(r => r.id);
    }

    if (!proposalIds.length) {
      return res.status(200).json([]);
    }

    const proposalRows = await sql`
      SELECT id, data, deal_id, number_year, number_seq FROM proposals WHERE id = ANY(${proposalIds})
    `;
    const proposalMap = new Map(proposalRows.map(p => [p.id, p]));

    const [stripeRows, partnerRows, manualRows] = await Promise.all([
      sql`SELECT proposal_id, amount, payment_type, paid_at, stripe_session_id,
                 customer_email, receipt_url, xero_invoice_id, xero_payment_id
            FROM payments WHERE proposal_id = ANY(${proposalIds})`,
      sql`SELECT stripe_invoice_id, proposal_id, amount, paid_at,
                 xero_invoice_id, xero_payment_id
            FROM partner_invoices WHERE proposal_id = ANY(${proposalIds})
            ORDER BY paid_at ASC`,
      sql`SELECT id, proposal_id, amount, payment_method, payment_type, paid_at,
                 notes, manual_invoice_id, xero_invoice_id, recorded_by
            FROM manual_payments WHERE proposal_id = ANY(${proposalIds})
            ORDER BY paid_at DESC`,
    ]);

    const proposalTitle = (p) => p?.data?.proposalTitle || p?.data?.clientName || p?.id || null;

    const out = [];
    for (const r of stripeRows) {
      const p = proposalMap.get(r.proposal_id);
      out.push({
        id: 'stripe:' + r.proposal_id,
        source: 'stripe',
        proposalId: r.proposal_id,
        proposalTitle: proposalTitle(p),
        dealId: p?.deal_id || null,
        amount: r.amount != null ? Number(r.amount) : null,
        paymentMethod: 'stripe',
        paymentType: r.payment_type,
        paidAt: r.paid_at,
        receiptUrl: r.receipt_url || null,
        xeroInvoiceId: r.xero_invoice_id || null,
        manualInvoiceId: null,
        notes: null,
      });
    }
    // Number partner months per proposal so the UI can label "month N".
    const partnerCounts = new Map();
    for (const r of partnerRows) {
      const n = (partnerCounts.get(r.proposal_id) || 0) + 1;
      partnerCounts.set(r.proposal_id, n);
      const p = proposalMap.get(r.proposal_id);
      out.push({
        id: 'partner:' + r.stripe_invoice_id,
        source: 'partner',
        proposalId: r.proposal_id,
        proposalTitle: proposalTitle(p),
        dealId: p?.deal_id || null,
        amount: r.amount != null ? Number(r.amount) : null,
        paymentMethod: 'stripe',
        paymentType: 'partner_month_' + (n + 1),
        paidAt: r.paid_at,
        receiptUrl: null,
        xeroInvoiceId: r.xero_invoice_id || null,
        manualInvoiceId: null,
        notes: null,
      });
    }
    for (const r of manualRows) {
      const p = proposalMap.get(r.proposal_id);
      out.push({
        id: 'manual:' + r.id,
        source: 'manual',
        proposalId: r.proposal_id,
        proposalTitle: proposalTitle(p),
        dealId: p?.deal_id || null,
        amount: r.amount != null ? Number(r.amount) : null,
        paymentMethod: r.payment_method,
        paymentType: r.payment_type,
        paidAt: r.paid_at,
        receiptUrl: null,
        xeroInvoiceId: r.xero_invoice_id || null,
        manualInvoiceId: r.manual_invoice_id || null,
        notes: r.notes || null,
        recordedBy: r.recorded_by || null,
      });
    }

    out.sort((a, b) => new Date(b.paidAt || 0) - new Date(a.paidAt || 0));
    return res.status(200).json(out);
  }

  // --- GET /api/crm/payments/outstanding-invoices?proposalId=… ---------------
  // What the "record a payment" form offers to link to. Kept a separate read
  // rather than folded into the payments list: the form needs it before there
  // is a payment to list.
  if (id === 'outstanding-invoices' && req.method === 'GET') {
    const proposalId = trimOrNull(req.query.proposalId);
    return res.status(200).json(await outstandingProposalInvoices(proposalId));
  }

  // --- POST /api/crm/payments — create a manual payment
  if (!id && req.method === 'POST') {
    const body = req.body || {};
    const proposalId    = trimOrNull(body.proposalId);
    const amount        = numberOrNull(body.amount);
    const paymentMethod = lowerOrNull(body.paymentMethod);
    const paymentType   = trimOrNull(body.paymentType);
    const paidAt        = trimOrNull(body.paidAt);
    const notes         = trimOrNull(body.notes);
    const manualInvoiceId = trimOrNull(body.manualInvoiceId);
    // Which Xero invoice this settles, when it settles one. Recording a BACS
    // payment by hand is the fast path — the bank tells the CRM nothing — and
    // naming the invoice is what stops it being counted a second time when
    // Xero reconciles days later. See manualPaymentLink.js.
    const xeroInvoiceId = trimOrNull(body.xeroInvoiceId);

    if (!proposalId) return res.status(400).json({ error: 'proposalId required' });
    if (amount == null || amount <= 0) return res.status(400).json({ error: 'amount must be positive' });
    if (!paymentMethod) return res.status(400).json({ error: 'paymentMethod required' });

    // Guard: would this take the deal past what it actually committed to? That's
    // how a 50% deposit ends up reading as "paid in full" — either the amount is
    // the whole project value rather than what landed, or the matching invoice is
    // separately marked paid so the money is counted twice. Extras can
    // legitimately push a deal over, so it's a confirmable warning, not a block.
    const guardDealId = await dealIdForProposal(proposalId).catch(() => null);
    if (guardDealId && body.confirmOverpay !== true) {
      const bal = await dealPaymentBalance(guardDealId);
      if (bal.known && bal.paid + amount > bal.committed + 0.005) {
        return res.status(409).json({
          error: 'This payment would take the deal past its signed total.',
          code: 'exceeds_committed',
          committed: bal.committed,
          alreadyPaid: bal.paid,
          remaining: bal.remaining,
          amount,
        });
      }
    }

    const newId = makeId('mp');
    await ensureManualPaymentLink();
    await sql`
      INSERT INTO manual_payments (
        id, proposal_id, amount, payment_method, payment_type,
        paid_at, notes, manual_invoice_id, xero_invoice_id, recorded_by
      ) VALUES (
        ${newId}, ${proposalId}, ${amount}, ${paymentMethod}, ${paymentType},
        ${paidAt || new Date().toISOString()}, ${notes}, ${manualInvoiceId},
        ${xeroInvoiceId}, ${user.email || null}
      )
    `;

    // Best-effort: advance the deal to 'paid' and notify admins.
    let dealId = null;
    try {
      dealId = await dealIdForProposal(proposalId);
      if (dealId) {
        await advanceStage(dealId, 'paid', {
          actorEmail: user.email || null,
          payload: { proposalId, amount, paymentType, paymentMethod, source: 'manual' },
        });
        // Payment no longer opens production — a person marks the deal "Good to
        // go" once it's ready (see the deals route's good-to-go action).
      }
    } catch (err) {
      console.error('[payments] advanceStage failed', err);
    }

    try {
      // The signature names the CLIENT. Without it the email had nobody to
      // credit the payment to but the person who entered it.
      const [[proposalRow], [sigRow]] = await Promise.all([
        sql`SELECT data FROM proposals WHERE id = ${proposalId}`,
        sql`SELECT name, email FROM signatures WHERE proposal_id = ${proposalId}`.catch(() => []),
      ]);
      const proposal = proposalRow?.data || {};
      const title = proposal.proposalTitle || proposal.clientName || proposalId;
      const link = `${APP_URL}/?proposal=${proposalId}`;
      await sendNotification('payment.received', {
        subject: `💰 Payment received: ${title}`,
        html: paidHtml({
          proposal,
          // The payer is the client, or nobody — never the colleague at the
          // keyboard. Their name goes on the "Recorded by" line instead.
          signerName: sigRow?.name || null,
          signerEmail: sigRow?.email || null,
          amount,
          paymentType: paymentType || 'manual',
          paidAt: paidAt || new Date().toISOString(),
          receiptUrl: null,
          link,
          recordedBy: user.name || user.email || null,
          paymentMethod,
        }),
        text: `${paymentMethod.toUpperCase()} payment of £${Number(amount).toFixed(2)} recorded for "${title}". ${link}`,
      });
    } catch (err) {
      console.error('[payments] notify failed', err);
    }

    return res.status(201).json({
      id: 'manual:' + newId,
      source: 'manual',
      proposalId,
      dealId,
      amount,
      paymentMethod,
      paymentType,
      paidAt: paidAt || new Date().toISOString(),
      notes,
      manualInvoiceId,
      recordedBy: user.email || null,
    });
  }

  // --- PATCH /api/crm/payments/:id — update a manual payment
  if (id && req.method === 'PATCH') {
    const manualId = stripManualPrefix(id);
    const body = req.body || {};
    const cur = (await sql`SELECT * FROM manual_payments WHERE id = ${manualId}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (cur.recorded_by !== user.email && !hasPermission(await getRole(user.role), 'payments.manage')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const next = {
      amount:         'amount'         in body ? numberOrNull(body.amount)         : cur.amount,
      payment_method: 'paymentMethod'  in body ? lowerOrNull(body.paymentMethod)   : cur.payment_method,
      payment_type:   'paymentType'    in body ? trimOrNull(body.paymentType)      : cur.payment_type,
      paid_at:        'paidAt'         in body ? trimOrNull(body.paidAt)           : cur.paid_at,
      notes:          'notes'          in body ? trimOrNull(body.notes)            : cur.notes,
      manual_invoice_id: 'manualInvoiceId' in body ? trimOrNull(body.manualInvoiceId) : cur.manual_invoice_id,
    };
    await sql`
      UPDATE manual_payments
         SET amount = ${next.amount},
             payment_method = ${next.payment_method},
             payment_type = ${next.payment_type},
             paid_at = ${next.paid_at},
             notes = ${next.notes},
             manual_invoice_id = ${next.manual_invoice_id},
             updated_at = NOW()
       WHERE id = ${manualId}
    `;
    return res.status(200).json({ ok: true });
  }

  // --- DELETE /api/crm/payments/:id — delete a manual payment
  if (id && req.method === 'DELETE') {
    const manualId = stripManualPrefix(id);
    const cur = (await sql`SELECT recorded_by FROM manual_payments WHERE id = ${manualId}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (cur.recorded_by !== user.email && !hasPermission(await getRole(user.role), 'payments.manage')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await sql`DELETE FROM manual_payments WHERE id = ${manualId}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

// The frontend rollup tags rows with `manual:<id>` so they can be told apart
// from stripe/partner rows that share the same id space. Edit/delete URLs
// accept either form for convenience.
function stripManualPrefix(id) {
  return id.startsWith('manual:') ? id.slice('manual:'.length) : id;
}
