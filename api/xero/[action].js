// One-off OAuth bootstrap for the Xero Web App integration. Visit
// /api/xero/connect once (logged in as Adam in your browser is fine — Xero
// will gate access via its own login), consent in Xero, and the callback
// stores the refresh token + tenant ID in the xero_tokens table. From then
// on, api/_lib/xero.js uses the refresh-token flow automatically.

import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';
import { APP_URL } from '../_lib/email.js';
import { getOrCreateContact, createInvoice, emailInvoice, getInvoicePdf, getQuotePdf, getInvoiceNumber, getNextInvoiceNumber } from '../_lib/xero.js';
import { xeroContactIdForProposal, dealIdForProposal } from '../_lib/dealStage.js';
import { sendNotification } from '../_lib/notifications.js';
import {
  lineItemsForProject,
  lineItemsForDiscountedProject,
  lineItemsForPartnerFirstMonth,
  depositLineItems,
  formatProposalNumber,
} from '../_lib/xeroMappers.js';

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

function billingToContact(billing, fallbackEmail) {
  if (!billing) return null;
  return {
    name: billing.companyName?.trim(),
    email: billing.accountsEmail?.trim() || fallbackEmail || undefined,
    vatNumber: billing.vatNumber?.trim() || undefined,
    address: {
      line1: billing.addressLine1 || '',
      line2: billing.addressLine2 || '',
      city: billing.city || '',
      postcode: billing.postcode || '',
      country: billing.country || 'United Kingdom',
    },
  };
}

const SCOPES = [
  'offline_access',
  'accounting.contacts',
  'accounting.invoices',
  'accounting.payments',
  // Quotes power the PO route — the "Pending PO" quote raised on PO-route
  // proposals/extras and the quote→invoice conversion in the Purchase Orders
  // section. Reconnect Xero (/api/xero/connect) after deploying so the grant
  // includes this; existing tokens keep working but won't carry the new scope
  // until re-consented.
  'accounting.transactions',
].join(' ');

function redirectUri() {
  return process.env.XERO_REDIRECT_URI
    || (process.env.APP_URL || 'https://app.squideo.com') + '/api/xero/callback';
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // --- /api/xero/connect ---
  // Kicks off the OAuth flow. We rely on Xero's own login to gate access —
  // only someone who can authenticate to the Squideo Xero org can finish
  // the consent step.
  if (action === 'connect') {
    if (!process.env.XERO_CLIENT_ID) {
      return res.status(500).send('XERO_CLIENT_ID not set');
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.XERO_CLIENT_ID,
      redirect_uri: redirectUri(),
      scope: SCOPES,
      state: 'bootstrap',
    });
    res.writeHead(302, { Location: `${AUTHORIZE_URL}?${params.toString()}` });
    return res.end();
  }

  // --- /api/xero/callback ---
  if (action === 'callback') {
    const { code, error } = req.query;
    if (error) return res.status(400).send(`Xero error: ${error}`);
    if (!code) return res.status(400).send('Missing code');

    try {
      const basic = Buffer
        .from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`)
        .toString('base64');

      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(),
        }).toString(),
      });
      if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => '');
        return res.status(502).send(`Token exchange failed: ${tokenRes.status} ${text}`);
      }
      const tokens = await tokenRes.json();

      // Look up which tenants this access token can see, pick the first.
      // For Custom-Connection-style single-org integrations there's only
      // ever one — if you've consented multiple orgs, the picker UI in Xero
      // already restricted to one.
      const connRes = await fetch(CONNECTIONS_URL, {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Accept': 'application/json',
        },
      });
      if (!connRes.ok) {
        const text = await connRes.text().catch(() => '');
        return res.status(502).send(`Connections fetch failed: ${connRes.status} ${text}`);
      }
      const connections = await connRes.json();
      if (!Array.isArray(connections) || !connections.length) {
        return res.status(502).send('No Xero tenants returned for this connection.');
      }
      const tenantId = connections[0].tenantId;
      const tenantName = connections[0].tenantName || '(unknown)';

      await sql`
        INSERT INTO xero_tokens (id, refresh_token, tenant_id, updated_at)
        VALUES ('singleton', ${tokens.refresh_token}, ${tenantId}, NOW())
        ON CONFLICT (id) DO UPDATE
          SET refresh_token = EXCLUDED.refresh_token,
              tenant_id = EXCLUDED.tenant_id,
              updated_at = NOW()
      `;

      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(`
        <html><body style="font-family:system-ui;padding:40px;max-width:600px;margin:0 auto;">
          <h1>Xero connected ✓</h1>
          <p>Connected to <strong>${tenantName}</strong>.</p>
          <p>Tenant ID: <code>${tenantId}</code></p>
          <p>You can close this tab. The integration is now active.</p>
        </body></html>
      `);
    } catch (err) {
      console.error('[xero callback] failed', err);
      return res.status(500).send('Callback failed: ' + err.message);
    }
  }

  // --- /api/xero/next-invoice-number ---
  // Returns the predicted next invoice number so the CRM can pre-fill it.
  if (action === 'next-invoice-number') {
    if (req.method !== 'GET') return res.status(405).end();
    const user = await requireAuth(req, res);
    if (!user) return;
    const nextNumber = await getNextInvoiceNumber();
    return res.status(200).json({ nextNumber });
  }

  // --- /api/xero/invoice-pdf?invoiceId=... ---
  // Auth-gated passthrough that streams the rendered Xero invoice PDF back
  // to the team. The invoice ID is allowlisted against our own payments /
  // partner_invoices / proposal_billing tables so we never proxy arbitrary
  // Xero IDs even if a request leaked.
  if (action === 'invoice-pdf') {
    if (req.method !== 'GET') return res.status(405).end();
    const user = await requireAuth(req, res);
    if (!user) return;
    const invoiceId = (req.query.invoiceId || '').trim();
    if (!invoiceId) return res.status(400).json({ error: 'invoiceId required' });

    const allowed = await sql`
      SELECT 1 AS ok FROM payments WHERE xero_invoice_id = ${invoiceId}
      UNION ALL
      SELECT 1 AS ok FROM partner_invoices WHERE xero_invoice_id = ${invoiceId}
      UNION ALL
      SELECT 1 AS ok FROM proposal_billing WHERE xero_invoice_id = ${invoiceId}
      UNION ALL
      SELECT 1 AS ok FROM manual_invoices WHERE xero_invoice_id = ${invoiceId}
      LIMIT 1
    `;
    if (!allowed.length) return res.status(404).json({ error: 'Unknown invoice' });

    try {
      const [pdf, number] = await Promise.all([
        getInvoicePdf(invoiceId),
        getInvoiceNumber(invoiceId),
      ]);
      const filename = `${number || 'Invoice-' + invoiceId}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.status(200).send(pdf);
    } catch (err) {
      console.error('[xero invoice-pdf] failed', err);
      return res.status(502).json({ error: 'Could not fetch invoice from Xero' });
    }
  }

  // --- /api/xero/quote-pdf?quoteId=... ---
  // Same auth-gated passthrough for a Xero quote PDF (the PO-route "Pending PO"
  // quote). The id is allowlisted against our own deal_extras / proposal_billing
  // tables so we never proxy arbitrary Xero quote IDs.
  if (action === 'quote-pdf') {
    if (req.method !== 'GET') return res.status(405).end();
    const user = await requireAuth(req, res);
    if (!user) return;
    const quoteId = (req.query.quoteId || '').trim();
    if (!quoteId) return res.status(400).json({ error: 'quoteId required' });

    const allowed = await sql`
      SELECT quote_number AS num FROM deal_extras WHERE xero_quote_id = ${quoteId}
      UNION ALL
      SELECT NULL AS num FROM proposal_billing WHERE xero_quote_id = ${quoteId}
      LIMIT 1
    `;
    if (!allowed.length) return res.status(404).json({ error: 'Unknown quote' });

    try {
      const pdf = await getQuotePdf(quoteId);
      const filename = `${allowed[0].num || 'Quote-' + quoteId}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.status(200).send(pdf);
    } catch (err) {
      console.error('[xero quote-pdf] failed', err);
      return res.status(502).json({ error: 'Could not fetch quote from Xero' });
    }
  }

  // --- /api/xero/invoice-intent ---
  // Fired the moment a signed client clicks "Send me an invoice instead",
  // BEFORE they fill in billing / actually issue anything. Lets the team know
  // a client wants to be invoiced (they may not finish). Client-facing, so no
  // auth — but it only ever notifies, never mutates billing, and is deduped to
  // one alert per proposal via invoice_route_intents.
  if (action === 'invoice-intent') {
    if (req.method !== 'POST') return res.status(405).end();
    const { proposalId } = req.body || {};
    if (!proposalId) return res.status(400).json({ error: 'proposalId required' });

    // Claim the "first click" atomically: the INSERT only returns a row the
    // first time this proposal is seen; later clicks hit the conflict and
    // return nothing, so we notify exactly once.
    let claimed;
    try {
      claimed = await sql`
        INSERT INTO invoice_route_intents (proposal_id)
        VALUES (${proposalId})
        ON CONFLICT (proposal_id) DO NOTHING
        RETURNING proposal_id
      `;
    } catch (err) {
      console.error('[invoice-intent] claim failed', err);
      return res.status(200).json({ ok: true }); // never block the client UI
    }
    if (!claimed.length) return res.status(200).json({ ok: true, deduped: true });

    try {
      const [proposalRows, sigRows] = await Promise.all([
        sql`SELECT data FROM proposals WHERE id = ${proposalId}`,
        sql`SELECT name, email FROM signatures WHERE proposal_id = ${proposalId}`,
      ]);
      const proposal = proposalRows[0]?.data;
      // Only a signed proposal exposes the invoice route; if it's not signed,
      // someone's poking the endpoint — drop the intent so a later genuine
      // click can still notify.
      if (!proposal || !sigRows[0]) {
        await sql`DELETE FROM invoice_route_intents WHERE proposal_id = ${proposalId}`;
        return res.status(200).json({ ok: true });
      }
      const sig = sigRows[0];
      const title = proposal.proposalTitle || proposal.clientName || proposalId;
      const link = `${APP_URL}/?proposal=${proposalId}`;
      const dealId = await dealIdForProposal(proposalId);
      await sendNotification('invoice.client_requested', {
        subject: `🧾 Invoice requested: ${title}`,
        html: `<p>${sig.name || 'A client'} (${sig.email || ''}) chose <strong>"Send me an invoice"</strong> on the signed proposal <strong>${title}</strong>.</p>
               <p>They haven't issued it yet — they still need to confirm their billing details. This is a heads-up that they want to be invoiced rather than pay by card.</p>
               <p style="margin:16px 0;"><a href="${link}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Open the proposal</a></p>`,
        text: `${sig.name || 'A client'} chose "Send me an invoice" for "${title}". They haven't issued it yet. ${link}`,
        inApp: {
          title: `🧾 Invoice requested: ${title}`,
          body: `${sig.name || 'A client'} wants to be invoiced rather than pay by card`,
          link: dealId ? `#/deal/${dealId}` : null,
        },
      });
      await sql`UPDATE invoice_route_intents SET notified_at = NOW() WHERE proposal_id = ${proposalId}`;
    } catch (err) {
      console.error('[invoice-intent] notify failed', err);
    }
    return res.status(200).json({ ok: true });
  }

  // --- /api/xero/invoice ---
  // Client signed but doesn't want to pay by card today — they want an
  // emailed invoice. Mirrors the Stripe-paid path's invoice creation but is
  // triggered directly here (no Stripe involved). Issues an AUTHORISED Xero
  // invoice and emails it. Idempotent on proposal_billing.xero_invoice_id.
  if (action === 'invoice') {
    if (req.method !== 'POST') return res.status(405).end();
    const { proposalId, billing } = req.body || {};
    if (!proposalId) return res.status(400).json({ error: 'proposalId required' });
    if (!billing?.companyName?.trim() || !billing?.addressLine1?.trim() || !billing?.accountsEmail?.trim()) {
      return res.status(400).json({ error: 'billing.companyName, addressLine1 and accountsEmail are required' });
    }

    const [proposalRows, sigRows] = await Promise.all([
      sql`SELECT data, number_year, number_seq FROM proposals WHERE id = ${proposalId}`,
      sql`SELECT name, email, data FROM signatures WHERE proposal_id = ${proposalId}`,
    ]);
    const proposalRow = proposalRows[0];
    const proposal = proposalRow?.data;
    const proposalNumber = formatProposalNumber(proposalRow?.number_year, proposalRow?.number_seq);
    const sigRow = sigRows[0];
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (!sigRow) return res.status(409).json({ error: 'Proposal must be signed first' });
    const signed = { name: sigRow.name, email: sigRow.email, ...(sigRow.data || {}) };
    if (signed.paymentOption === 'po') {
      return res.status(409).json({ error: 'Use the PO route for purchase orders' });
    }

    await sql`
      INSERT INTO proposal_billing (proposal_id, billing)
      VALUES (${proposalId}, ${JSON.stringify(billing)})
      ON CONFLICT (proposal_id) DO UPDATE
        SET billing = EXCLUDED.billing, updated_at = NOW()
    `;

    const [existing] = await sql`SELECT xero_invoice_id FROM proposal_billing WHERE proposal_id = ${proposalId}`;
    if (existing?.xero_invoice_id) {
      return res.status(200).json({ ok: true, invoiceId: existing.xero_invoice_id, deduped: true });
    }

    const isDeposit = signed.paymentOption === '5050';
    const isPartner = !!signed.partnerSelected && !!signed.amountBreakdown;

    let invoiceId;
    try {
      const linkedXeroContactId = await xeroContactIdForProposal(proposalId);
      const contactId = await getOrCreateContact({
        ...billingToContact(billing, signed.email),
        xeroContactId: linkedXeroContactId || undefined,
      });

      let lineItems;
      if (isPartner) {
        lineItems = [
          ...lineItemsForDiscountedProject(proposal, signed, proposalNumber),
          ...lineItemsForPartnerFirstMonth(proposal, signed, proposalNumber),
        ];
      } else if (isDeposit) {
        lineItems = depositLineItems(proposal, signed, 0.5, proposalNumber);
      } else {
        lineItems = lineItemsForProject(proposal, signed, proposalNumber);
      }

      const dueDate = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
      const paymentLabel = isDeposit ? '50% deposit' : (isPartner ? 'Project + Partner first month' : 'Full payment');
      const referenceBase = proposalNumber || (proposal.proposalTitle || proposal.clientName || proposalId);
      const reference = `${referenceBase} — ${paymentLabel}`.slice(0, 80);
      ({ invoiceId } = await createInvoice({
        contactId,
        lineItems,
        reference,
        dueDate,
        status: 'AUTHORISED',
      }));

      await sql`UPDATE proposal_billing SET xero_invoice_id = ${invoiceId} WHERE proposal_id = ${proposalId}`;

      try { await emailInvoice(invoiceId); }
      catch (err) { console.error('[xero] emailInvoice failed (invoice still authorised)', err); }
    } catch (err) {
      console.error('[xero] invoice action failed', err);
      return res.status(502).json({ error: 'Could not create invoice: ' + (err.message || 'unknown') });
    }

    try {
      const title = proposal.proposalTitle || proposal.clientName || proposalId;
      const link = `${APP_URL}/?proposal=${proposalId}`;
      const invoiceLink = `${APP_URL}/api/xero/invoice-pdf?invoiceId=${encodeURIComponent(invoiceId)}`;
      const dealId = await dealIdForProposal(proposalId);
      await sendNotification('invoice.issued', {
        subject: `📄 Invoice issued: ${title}`,
        html: `<p>${signed.name || 'A client'} (${signed.email || ''}) chose the email-me-an-invoice route for <strong>${title}</strong>.</p>
               <p>Billing company: <strong>${billing.companyName}</strong> (${billing.accountsEmail || ''})</p>
               <p>An invoice ${isDeposit ? '(50% deposit)' : '(full payment)'} has been issued from Xero and emailed to the client.</p>
               <p style="margin:16px 0;"><a href="${invoiceLink}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">View invoice</a></p>
               <p><a href="${link}">Open the proposal</a></p>`,
        text: `${signed.name || 'A client'} chose invoice route for "${title}". Xero invoice issued. View invoice: ${invoiceLink} — Proposal: ${link}`,
        inApp: {
          title: `📄 Invoice issued: ${title}`,
          body: `${signed.name || 'A client'} was invoiced ${isDeposit ? '(50% deposit)' : '(full payment)'} · ${billing.companyName}`,
          link: dealId ? `#/deal/${dealId}` : null,
        },
      });
    } catch (err) {
      console.error('[invoice] issued notification failed', err);
    }

    return res.status(200).json({ ok: true, invoiceId });
  }

  return res.status(404).send('Not found');
}
