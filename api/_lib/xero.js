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

// Resolves a Xero ContactID. Caller can pass `xeroContactId` to bypass the
// name-search entirely — that's the duplicate-prevention path used once the
// local company has been linked to a Xero contact. If `xeroContactId` is
// supplied and refers to an archived contact, it's auto-unarchived so the
// invoice push doesn't 400.
export async function getOrCreateContact({ xeroContactId, name, email, address, vatNumber }) {
  if (xeroContactId) {
    try {
      const ok = await ensureActiveContact(xeroContactId);
      if (ok) return xeroContactId;
    } catch (err) {
      console.warn('[xero] ensureActiveContact failed, falling back to name search', err.message);
    }
  }

  const trimmedName = (name || '').trim();
  if (!trimmedName) throw new Error('[xero] contact name is required');

  const where = `Name=="${escapeWhere(trimmedName)}"`;
  const search = await xeroFetch(`/api.xro/2.0/Contacts?where=${encodeURIComponent(where)}`);
  if (search?.Contacts?.length) {
    return search.Contacts[0].ContactID;
  }

  const addresses = address ? buildAddresses(address) : undefined;

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

// Confirms a Xero contact exists and is not archived. If archived, flips it
// back to ACTIVE so the invoice push doesn't 400. Returns true on success.
async function ensureActiveContact(contactId) {
  const res = await xeroFetch(`/api.xro/2.0/Contacts/${encodeURIComponent(contactId)}`);
  const c = res?.Contacts?.[0];
  if (!c) return false;
  if (c.ContactStatus === 'ARCHIVED') {
    await xeroFetch(`/api.xro/2.0/Contacts/${encodeURIComponent(contactId)}`, {
      method: 'POST',
      body: JSON.stringify({ ContactStatus: 'ACTIVE' }),
    });
  }
  return true;
}

// Builds the Xero Addresses array for a contact. Xero prints the contact's
// POBOX (postal) address as the "to" address on invoices, so we set POBOX —
// and mirror the same values to STREET — to make sure it shows.
function buildAddresses(address) {
  const fields = {
    AddressLine1: address.line1 || '',
    AddressLine2: address.line2 || '',
    City: address.city || '',
    PostalCode: address.postcode || '',
    Country: address.country || 'United Kingdom',
  };
  return [
    { AddressType: 'POBOX', ...fields },
    { AddressType: 'STREET', ...fields },
  ];
}

// Pushes a postal address onto an existing Xero contact. Reads the contact
// first so we merge into its existing Addresses array — replacing the POBOX +
// STREET entries while preserving any other types (e.g. DELIVERY). POBOX is the
// one Xero prints on invoices. Xero updates contacts via POST to /Contacts/{id}.
export async function updateContactAddress(contactId, address) {
  let existing = [];
  try {
    const res = await xeroFetch(`/api.xro/2.0/Contacts/${encodeURIComponent(contactId)}`);
    existing = res?.Contacts?.[0]?.Addresses || [];
  } catch (err) {
    console.warn('[xero] could not read contact addresses, sending fresh set', err.message);
  }

  const others = existing.filter(a => a.AddressType !== 'STREET' && a.AddressType !== 'POBOX');
  const addresses = [...buildAddresses(address), ...others];

  await xeroFetch(`/api.xro/2.0/Contacts/${encodeURIComponent(contactId)}`, {
    method: 'POST',
    body: JSON.stringify({ ContactID: contactId, Addresses: addresses }),
  });
}

// Paginates through every Xero contact and returns them. Includes archived
// contacts so the mirror reflects everything. Optionally pass an ISO date
// string to `modifiedSince` for incremental pulls (uses Xero's
// If-Modified-Since header). Each page returns up to 100 contacts.
export async function listAllContacts({ modifiedSince = null } = {}) {
  const all = [];
  let page = 1;
  while (true) {
    const headers = modifiedSince ? { 'If-Modified-Since': new Date(modifiedSince).toUTCString() } : {};
    const json = await xeroFetch(
      `/api.xro/2.0/Contacts?page=${page}&includeArchived=true`,
      { headers },
    );
    const batch = json?.Contacts || [];
    all.push(...batch);
    if (batch.length < 100) break;
    page += 1;
    // Safety net — Xero would never return more than a few hundred pages for
    // a normal org, but cap to avoid runaway loops.
    if (page > 200) break;
  }
  return all;
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
      DiscountAmount: li.discountAmount || undefined,
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
      subTotal: inv.SubTotal != null ? Number(inv.SubTotal) : null,
      totalTax: inv.TotalTax != null ? Number(inv.TotalTax) : null,
      amountDue: inv.AmountDue != null ? Number(inv.AmountDue) : null,
      currency: inv.CurrencyCode || null,
      // Xero's exchange rate from invoice currency to the org's base currency.
      // For a GBP-base org, a EUR invoice with rate 0.86 means 1 EUR = 0.86 GBP.
      currencyRate: inv.CurrencyRate != null ? Number(inv.CurrencyRate) : null,
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
          contactId: inv.Contact?.ContactID || null,
          contactName: inv.Contact?.Name || null,
          reference: inv.Reference || null,
          total: inv.Total != null ? Number(inv.Total) : null,
          subTotal: inv.SubTotal != null ? Number(inv.SubTotal) : null,
          totalTax: inv.TotalTax != null ? Number(inv.TotalTax) : null,
          amountDue: inv.AmountDue != null ? Number(inv.AmountDue) : null,
          fullyPaidOn: parseXeroDate(inv.FullyPaidOnDate),
          currency: inv.CurrencyCode || null,
          currencyRate: inv.CurrencyRate != null ? Number(inv.CurrencyRate) : null,
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

// ── Profit & Loss: monthly total operating costs ────────────────────────────
// Returns a Map of 'YYYY-MM' -> total operating cost (£, base currency, positive)
// = Cost of Sales + Operating Expenses for that month, taken from one multi-period
// P&L report call. Columns are matched to months by parsing each period header,
// so column order doesn't matter; unparseable columns are skipped. Cached briefly
// per end-month. Throws on a hard failure (e.g. missing the reports scope) — the
// caller falls back to its own figures. Needs the accounting.reports.read scope.
const PL_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parsePlPeriod(label) {
  const m = String(label || '').match(/([A-Za-z]{3,})[\s-]*(\d{2,4})/);
  if (!m) return null;
  const mi = PL_MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mi) return null;
  let y = Number(m[2]);
  if (y < 100) y += 2000;
  return `${y}-${String(mi).padStart(2, '0')}`;
}

const plCache = new Map(); // `${endMonth}|${periods}` -> { at, map }
const PL_TTL = 6 * 60 * 60 * 1000;

export async function getMonthlyOperatingCosts({ endMonth, periods = 11 }) {
  if (!/^\d{4}-\d{2}$/.test(endMonth || '')) throw new Error('[xero] endMonth (YYYY-MM) required');
  const cacheKey = `${endMonth}|${periods}`;
  const hit = plCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PL_TTL) return hit.map;

  const [y, mo] = endMonth.split('-').map(Number);
  const date = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); // last day of endMonth
  const qs = new URLSearchParams({ date, periods: String(periods), timeframe: 'MONTH' }).toString();
  const json = await xeroFetch(`/api.xro/2.0/Reports/ProfitAndLoss?${qs}`);
  const report = json?.Reports?.[0];

  const map = new Map();
  if (report) {
    const header = (report.Rows || []).find((r) => r.RowType === 'Header');
    const colMonth = {};
    (header?.Cells || []).forEach((c, i) => { if (i > 0) { const mk = parsePlPeriod(c?.Value); if (mk) colMonth[i] = mk; } });

    const walk = (rows) => {
      for (const row of rows || []) {
        if (Array.isArray(row.Rows)) walk(row.Rows);
        if (row.RowType === 'SummaryRow') {
          const label = String(row.Cells?.[0]?.Value || '').toLowerCase();
          if (label.includes('operating expense') || label.includes('cost of sales')) {
            (row.Cells || []).forEach((c, i) => {
              const mk = colMonth[i];
              if (!mk) return;
              const v = Math.abs(Number(c?.Value) || 0);
              map.set(mk, Math.round(((map.get(mk) || 0) + v) * 100) / 100);
            });
          }
        }
      }
    };
    walk(report.Rows);
  }

  plCache.set(cacheKey, { at: Date.now(), map });
  return map;
}

// Fallback for when the reports scope isn't granted: monthly supplier-bill
// (ACCPAY) totals, summed net (SubTotal, ex-VAT) by bill date. Uses the existing
// accounting.invoices scope — no reconnect needed. Less complete than the P&L
// report (misses spend not entered as a bill, e.g. some direct debits / card
// payments), but a reasonable stand-in. Returns a Map of 'YYYY-MM' -> net total.
export async function getMonthlyBillCosts({ endMonth, periods = 11 }) {
  if (!/^\d{4}-\d{2}$/.test(endMonth || '')) throw new Error('[xero] endMonth (YYYY-MM) required');
  const cacheKey = `bills|${endMonth}|${periods}`;
  const hit = plCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PL_TTL) return hit.map;

  const [ey, em] = endMonth.split('-').map(Number); // em is 1-based
  const from = new Date(Date.UTC(ey, em - 1 - periods, 1)); // first day of the oldest month
  const until = new Date(Date.UTC(ey, em, 1));              // first day of the month after endMonth
  const dt = (d) => `DateTime(${d.getUTCFullYear()},${d.getUTCMonth() + 1},${d.getUTCDate()})`;
  const where = `Type=="ACCPAY" AND Date>=${dt(from)} AND Date<${dt(until)}`;

  const map = new Map();
  let page = 1;
  while (true) {
    const qs = new URLSearchParams({ where, page: String(page), Statuses: 'AUTHORISED,PAID' }).toString();
    const json = await xeroFetch(`/api.xro/2.0/Invoices?${qs}`);
    const invs = json?.Invoices || [];
    for (const inv of invs) {
      const ymd = parseXeroDate(inv.DateString || inv.Date);
      if (!ymd) continue;
      const mk = ymd.slice(0, 7);
      const net = Number(inv.SubTotal) || 0;
      map.set(mk, Math.round(((map.get(mk) || 0) + net) * 100) / 100);
    }
    if (invs.length < 100) break;
    page += 1;
    if (page > 100) break; // safety net
  }
  plCache.set(cacheKey, { at: Date.now(), map });
  return map;
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
