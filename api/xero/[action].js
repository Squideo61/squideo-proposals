// One-off OAuth bootstrap for the Xero Web App integration. Visit
// /api/xero/connect once (logged in as Adam in your browser is fine — Xero
// will gate access via its own login), consent in Xero, and the callback
// stores the refresh token + tenant ID in the xero_tokens table. From then
// on, api/_lib/xero.js uses the refresh-token flow automatically.

import sql from '../_lib/db.js';
import { cors } from '../_lib/middleware.js';
import { sendMail, APP_URL } from '../_lib/email.js';
import { getOrCreateContact, createInvoice, emailInvoice } from '../_lib/xero.js';
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
].join(' ');

function redirectUri() {
  return process.env.XERO_REDIRECT_URI
    || (process.env.APP_URL || 'https://squideo-proposals-tu96.vercel.app') + '/api/xero/callback';
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
      const contactId = await getOrCreateContact(billingToContact(billing, signed.email));

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
      invoiceId = await createInvoice({
        contactId,
        lineItems,
        reference,
        dueDate,
        status: 'AUTHORISED',
      });

      await sql`UPDATE proposal_billing SET xero_invoice_id = ${invoiceId} WHERE proposal_id = ${proposalId}`;

      try { await emailInvoice(invoiceId); }
      catch (err) { console.error('[xero] emailInvoice failed (invoice still authorised)', err); }
    } catch (err) {
      console.error('[xero] invoice action failed', err);
      return res.status(502).json({ error: 'Could not create invoice: ' + (err.message || 'unknown') });
    }

    try {
      const users = await sql`SELECT email FROM users`;
      const recipients = users.map(u => u.email).filter(Boolean);
      const ownerEmail = proposal.preparedByEmail || null;
      const to = ownerEmail ? [ownerEmail, ...recipients.filter(e => e !== ownerEmail)] : recipients;
      const title = proposal.proposalTitle || proposal.clientName || proposalId;
      const link = `${APP_URL}/?proposal=${proposalId}`;
      if (to.length) {
        await sendMail({
          to,
          subject: `📄 Invoice issued: ${title}`,
          html: `<p>${signed.name || 'A client'} (${signed.email || ''}) chose the email-me-an-invoice route for <strong>${title}</strong>.</p>
                 <p>Billing company: <strong>${billing.companyName}</strong> (${billing.accountsEmail || ''})</p>
                 <p>An invoice ${isDeposit ? '(50% deposit)' : '(full payment)'} has been issued from Xero and emailed to the client.</p>
                 <p><a href="${link}">Open the proposal</a></p>`,
          text: `${signed.name || 'A client'} chose invoice route for "${title}". Xero invoice issued. ${link}`,
        });
      }
    } catch (err) {
      console.error('[invoice] notification email failed', err);
    }

    return res.status(200).json({ ok: true, invoiceId });
  }

  return res.status(404).send('Not found');
}
