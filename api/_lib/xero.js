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
  const inv = res.Invoices[0];
  return { invoiceId: inv.InvoiceID, invoiceNumber: inv.InvoiceNumber || null };
}

// Returns the predicted next invoice number based on the most recent ACCREC
// invoice in Xero. Includes all statuses (DRAFT, AUTHORISED, PAID, VOIDED)
// so the latest paid invoices are counted. Parses "INV-6058" → "INV-6059".
export async function getNextInvoiceNumber() {
  try {
    // Must include all statuses — default only returns DRAFT+AUTHORISED, missing PAID.
    // Sort by Date DESC and fetch 100 so we span any non-standard-format invoices
    // (e.g. INV-C-2026-..., ZRUSFYBT-...) that sort ahead of INV-NNNN alphabetically.
    // Filter client-side to the exact INV-<digits> pattern and pick the numeric max.
    // Sort by Date DESC (same order as the Xero UI list). Old outlier invoices
    // (INV-28883219 etc.) have old dates and sink out of the top 50. No WHERE date
    // filter needed — the sort does the work. Take the numeric max of what comes back.
    const json = await xeroFetch(
      `/api.xro/2.0/Invoices?Type=ACCREC&order=Date+DESC&page=1&pageSize=50&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID`
    );
    // Accept only INV-NNNNN (up to 5 digits). INV-28883219 is 8 digits — a legacy
    // manually-assigned number that persists across every sort strategy we've tried.
    const nums = (json?.Invoices || [])
      .map(i => i.InvoiceNumber || '')
      .filter(n => /^INV-\d{1,5}$/.test(n))
      .map(n => parseInt(n.slice(4), 10));
    if (!nums.length) return null;
    const maxNum = Math.max(...nums);
    const padLen = Math.max(String(maxNum).length, 4);
    return `INV-${String(maxNum + 1).padStart(padLen, '0')}`;
  } catch (err) {
    console.warn('[xero] getNextInvoiceNumber failed', err.message);
    return null;
  }
}

export async function voidInvoice(invoiceId) {
  await xeroFetch(`/api.xro/2.0/Invoices/${encodeURIComponent(invoiceId)}`, {
    method: 'POST',
    body: JSON.stringify({ Status: 'VOIDED' }),
  });
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

// Looks up an invoice in Xero by its InvoiceNumber (e.g. "INV-6049"). Returns
// the full Xero invoice object or null if not found. Used to log uploaded PDFs
// against an invoice that already exists in Xero, without pushing a duplicate.
export async function getInvoiceByNumber(invoiceNumber) {
  const trimmed = String(invoiceNumber || '').trim();
  if (!trimmed) return null;
  try {
    const json = await xeroFetch(
      `/api.xro/2.0/Invoices?InvoiceNumbers=${encodeURIComponent(trimmed)}`,
    );
    const inv = json?.Invoices?.[0];
    if (!inv) return null;
    return {
      invoiceId: inv.InvoiceID,
      invoiceNumber: inv.InvoiceNumber,
      status: inv.Status,
      contactId: inv.Contact?.ContactID || null,
      contactName: inv.Contact?.Name || null,
      issueDate: parseXeroDate(inv.DateString || inv.Date),
      dueDate: parseXeroDate(inv.DueDateString || inv.DueDate),
      total: inv.Total != null ? Number(inv.Total) : null,
      amountDue: inv.AmountDue != null ? Number(inv.AmountDue) : null,
      currency: inv.CurrencyCode || null,
    };
  } catch (err) {
    console.warn('[xero] getInvoiceByNumber failed', err.message);
    return null;
  }
}

// Batch lookup of Xero invoices by their InvoiceID. Used to refresh status of
// linked manual_invoices on dashboard load — Xero's Stripe integration pays
// invoices directly with no webhook, so polling on read is how we catch it.
// Returns a Map keyed by InvoiceID; missing/errored ids are simply absent.
export async function getInvoicesByIds(invoiceIds) {
  const ids = (invoiceIds || []).filter(Boolean);
  if (!ids.length) return new Map();
  try {
    // Xero supports up to 40 IDs per call; chunk to be safe.
    const out = new Map();
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const json = await xeroFetch(
        `/api.xro/2.0/Invoices?IDs=${encodeURIComponent(chunk.join(','))}`,
      );
      for (const inv of json?.Invoices || []) {
        out.set(inv.InvoiceID, {
          invoiceId: inv.InvoiceID,
          invoiceNumber: inv.InvoiceNumber,
          status: inv.Status,
          total: inv.Total != null ? Number(inv.Total) : null,
          amountDue: inv.AmountDue != null ? Number(inv.AmountDue) : null,
          fullyPaidOn: parseXeroDate(inv.FullyPaidOnDate),
        });
      }
    }
    return out;
  } catch (err) {
    console.warn('[xero] getInvoicesByIds failed', err.message);
    return new Map();
  }
}

// Xero dates come either as ISO ("2026-05-14T00:00:00") or as
// /Date(1736899200000+0000)/. Returns YYYY-MM-DD or null.
function parseXeroDate(value) {
  if (!value) return null;
  const m = String(value).match(/\/Date\((\d+)/);
  const d = m ? new Date(Number(m[1])) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
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
