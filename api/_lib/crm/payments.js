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
import { makeId, trimOrNull, lowerOrNull, numberOrNull } from './shared.js';

export async function paymentsRoute(req, res, id, action, user) {
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
      sql`SELECT id, stripe_invoice_id, proposal_id, amount, paid_at,
                 xero_invoice_id, xero_payment_id
            FROM partner_invoices WHERE proposal_id = ANY(${proposalIds})
            ORDER BY paid_at ASC`,
      sql`SELECT id, proposal_id, amount, payment_method, payment_type, paid_at,
                 notes, manual_invoice_id, recorded_by
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
        id: 'partner:' + r.id,
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
        xeroInvoiceId: null,
        manualInvoiceId: r.manual_invoice_id || null,
        notes: r.notes || null,
        recordedBy: r.recorded_by || null,
      });
    }

    out.sort((a, b) => new Date(b.paidAt || 0) - new Date(a.paidAt || 0));
    return res.status(200).json(out);
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

    if (!proposalId) return res.status(400).json({ error: 'proposalId required' });
    if (amount == null || amount <= 0) return res.status(400).json({ error: 'amount must be positive' });
    if (!paymentMethod) return res.status(400).json({ error: 'paymentMethod required' });

    const newId = makeId('mp');
    await sql`
      INSERT INTO manual_payments (
        id, proposal_id, amount, payment_method, payment_type,
        paid_at, notes, manual_invoice_id, recorded_by
      ) VALUES (
        ${newId}, ${proposalId}, ${amount}, ${paymentMethod}, ${paymentType},
        ${paidAt || new Date().toISOString()}, ${notes}, ${manualInvoiceId},
        ${user.email || null}
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
      }
    } catch (err) {
      console.error('[payments] advanceStage failed', err);
    }

    try {
      const [proposalRow] = await sql`SELECT data FROM proposals WHERE id = ${proposalId}`;
      const proposal = proposalRow?.data || {};
      const ownerEmail = proposal.preparedByEmail || null;
      const title = proposal.proposalTitle || proposal.clientName || proposalId;
      const link = `${APP_URL}/?proposal=${proposalId}`;
      const recipients = await adminEmailsExcluding(ownerEmail);
      // Include the owner too — same as the Stripe path which emails them first.
      const all = ownerEmail ? [ownerEmail, ...recipients] : recipients;
      if (all.length) {
        await sendMail({
          to: all,
          subject: `💰 Payment received: ${title}`,
          html: paidHtml({
            proposal,
            signerName: user.name || user.email || 'Team',
            signerEmail: null,
            amount,
            paymentType: paymentType || 'manual',
            paidAt: paidAt || new Date().toISOString(),
            receiptUrl: null,
            link,
          }),
          text: `${paymentMethod.toUpperCase()} payment of £${Number(amount).toFixed(2)} recorded for "${title}". ${link}`,
        });
      }
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
    if (user.role !== 'admin' && cur.recorded_by !== user.email) {
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
    if (user.role !== 'admin' && cur.recorded_by !== user.email) {
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
