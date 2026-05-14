// Xero API client backed by a Web App OAuth integration with offline_access.
// The one-off bootstrap (api/xero/connect → /callback) writes a refresh
// token + tenant ID into the xero_tokens table; from then on every API call
// silently refreshes when the access token expires. Refresh tokens rotate
// on each refresh — we persist the new one immediately.

import sql from './db.js';

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const API_BASE = 'https://api.xero.com';

let cached = null; // { accessToken, expiresAt, tenantId }

function isConfigured() {
  return Boolean(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET);
}

async function loadStoredToken() {
  const rows = await sql`SELECT refresh_token, tenant_id FROM xero_tokens WHERE id = 'singleton' LIMIT 1`;
  if (!rows.length) {
    throw new Error('[xero] no stored refresh token — visit /api/xero/connect to bootstrap');
  }
  return { refreshToken: rows[0].refresh_token, tenantId: rows[0].tenant_id };
}

async function refreshAccessToken() {
  if (!isConfigured()) {
    throw new Error('[xero] missing XERO_CLIENT_ID / XERO_CLIENT_SECRET');
  }
  const { refreshToken, tenantId } = await loadStoredToken();
  const basic = Buffer
    .from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`)
    .toString('base64');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[xero] refresh failed ${res.status}: ${text}`);
  }
  const json = await res.json();

  // Xero rotates the refresh token on each refresh — persist the new one
  // before doing anything else, otherwise we lock ourselves out on next call.
  await sql`
    UPDATE xero_tokens
      SET refresh_token = ${json.refresh_token},
          updated_at = NOW()
      WHERE id = 'singleton'
  `;

  cached = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in * 1000),
    tenantId,
  };
  return cached;
}

export async function getAccessToken() {
  if (cached && cached.expiresAt - 30_000 > Date.now()) {
    return cached;
  }
  return refreshAccessToken();
}

async function xeroFetch(path, opts = {}, retried = false) {
  const { accessToken, tenantId } = await getAccessToken();
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 && !retried) {
    cached = null;
    return xeroFetch(path, opts, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[xero] ${opts.method || 'GET'} ${path} failed ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Variant of xeroFetch that returns the raw bytes — used for the PDF
// passthrough where Xero returns application/pdf, not JSON.
async function xeroFetchBytes(path, opts = {}, retried = false) {
  const { accessToken, tenantId } = await getAccessToken();
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Accept': 'application/pdf',
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 && !retried) {
    cached = null;
    return xeroFetchBytes(path, opts, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[xero] ${opts.method || 'GET'} ${path} failed ${res.status}: ${text}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function escapeWhere(s) {
  return String(s || '').replace(/"/g, '\\"');
}

export async function getOrCreateContact({ name, email, address, vatNumber }) {
  const trimmedName = (name || '').trim();
  if (!trimmedName) throw new Error('[xero] contact name is required');

  const where = `Name=="${escapeWhere(trimmedName)}"`;
  const search = await xeroFetch(`/api.xro/2.0/Contacts?where=${encodeURIComponent(where)}`);
  if (search?.Contacts?.length) {
    return search.Contacts[0].ContactID;
  }

  const addresses = address ? [{
    AddressType: 'STREET',
    AddressLine1: address.line1 || '',
    AddressLine2: address.line2 || '',
    City: address.city || '',
    PostalCode: address.postcode || '',
    Country: address.country || 'United Kingdom',
  }] : undefined;

  const payload = {
    Name: trimmedName,
    EmailAddress: email || undefined,
    TaxNumber: vatNumber || undefined,
    Addresses: addresses,
  };
  const created = await xeroFetch('/api.xro/2.0/Contacts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return created.Contacts[0].ContactID;
}

export async function createInvoice({ contactId, lineItems, reference, invoiceNumber, issueDate, dueDate, status = 'AUTHORISED' }) {
  const payload = {
    Type: 'ACCREC',
    Contact: { ContactID: contactId },
    LineAmountTypes: 'Exclusive',
    Status: status,
    InvoiceNumber: invoiceNumber || undefined,
    Reference: reference || undefined,
    Date: issueDate || undefined,
    DueDate: dueDate || undefined,
    LineItems: lineItems.map(li => ({
      Description: li.description,
      Quantity: li.quantity,
      UnitAmount: li.unitAmount,
      TaxType: li.taxType,
      AccountCode: li.accountCode,
      DiscountRate: li.discountRate || undefined,
    })),
  };
  const res = await xeroFetch('/api.xro/2.0/Invoices', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return res.Invoices[0].InvoiceID;
}

// Returns the predicted next invoice number based on the most recent ACCREC
// invoice in Xero. Includes all statuses (DRAFT, AUTHORISED, PAID, VOIDED)
// so the latest paid invoices are counted. Parses "INV-6058" → "INV-6059".
export async function getNextInvoiceNumber() {
  try {
    // Must include all statuses — the default only returns DRAFT+AUTHORISED,
    // which would miss PAID invoices and produce a stale/duplicate number.
    const json = await xeroFetch(
      '/api.xro/2.0/Invoices?Type=ACCREC&order=InvoiceNumber+DESC&page=1&pageSize=1&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED'
    );
    const inv = json?.Invoices?.[0];
    if (!inv?.InvoiceNumber) return null;
    const match = inv.InvoiceNumber.match(/^(.+?)(\d+)$/);
    if (!match) return null;
    const prefix = match[1];   // "INV-"
    const digits = match[2];   // "6058"
    const nextNum = String(parseInt(digits, 10) + 1).padStart(digits.length, '0');
    return `${prefix}${nextNum}`; // "INV-6059"
  } catch (err) {
    console.warn('[xero] getNextInvoiceNumber failed', err.message);
    return null;
  }
}

export async function emailInvoice(invoiceId) {
  await xeroFetch(`/api.xro/2.0/Invoices/${invoiceId}/Email`, {
    method: 'POST',
    body: '{}',
  });
}

// Records a payment against an invoice via Xero's /Payments endpoint. When the
// amount matches the invoice total, Xero transitions the invoice to PAID.
// Callers must round Amount themselves to avoid floating-point drift —
// Xero rejects payments that don't match the invoice total to the penny.
// Fetches the rendered PDF for an invoice. Returns a Buffer.
export async function getInvoicePdf(invoiceId) {
  return xeroFetchBytes(`/api.xro/2.0/Invoices/${encodeURIComponent(invoiceId)}`);
}

// Looks up the invoice number (e.g. INV-0042) for a given Xero invoice id.
// Used to name the downloaded PDF; never throws — returns null on failure.
export async function getInvoiceNumber(invoiceId) {
  try {
    const json = await xeroFetch(`/api.xro/2.0/Invoices/${encodeURIComponent(invoiceId)}`);
    return json?.Invoices?.[0]?.InvoiceNumber || null;
  } catch (err) {
    console.warn('[xero] getInvoiceNumber failed', err.message);
    return null;
  }
}

export async function createPayment({ invoiceId, accountCode, amount, date, reference }) {
  const payload = {
    Invoice: { InvoiceID: invoiceId },
    Account: { Code: accountCode },
    Date: date,
    Amount: Number(amount.toFixed(2)),
    Reference: reference || undefined,
  };
  const res = await xeroFetch('/api.xro/2.0/Payments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return res.Payments[0].PaymentID;
}

export async function createQuote({ contactId, lineItems, reference, status = 'SENT' }) {
  const payload = {
    Contact: { ContactID: contactId },
    LineAmountTypes: 'Exclusive',
    Status: status,
    Reference: reference || undefined,
    LineItems: lineItems.map(li => ({
      Description: li.description,
      Quantity: li.quantity,
      UnitAmount: li.unitAmount,
      TaxType: li.taxType,
      AccountCode: li.accountCode,
    })),
  };
  const res = await xeroFetch('/api.xro/2.0/Quotes', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return res.Quotes[0].QuoteID;
}
