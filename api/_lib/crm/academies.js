// Academies: Squideo Academy subscriptions, in the CRM.
//
// The academy platform (squideo-lms) works out what each academy is entitled
// to (plan, trial, usage, the statement for extra people) and hands it over its
// private API (../lms.js). The CRM owns the money and the client relationship:
// which company an academy belongs to, the invoices for it, the orders signed on
// proposals, and who to tell when something needs doing. The pure rules are in
// ./academyBilling.js.
//
// Invoices go through the same path as every other company invoice
// (createXeroInvoiceForDeal), so an academy invoice is a real Xero invoice: it
// shows in Pending Payments, and once Xero says it is paid it counts in the
// Income ledger, Finance and Cash Flow with nothing ticked by hand.
//
//   GET  /api/crm/academies                         the Academies page
//   GET  /api/crm/academies/plans                   the price list, for the proposal builder
//   GET  /api/crm/academies/options                 academies to offer on a proposal
//   GET  /api/crm/academies/:id                     one academy
//   POST /api/crm/academies/:id/link                { companyId | null }
//   POST /api/crm/academies/:id/invoice             { lines: [{ kind, periodKey } | { kind: 'custom', label, amount }], email?, issuedAt?, dueAt? }
//   POST /api/crm/academies/:id/mark-invoiced       { kind, periodKey, note? }   billed some other way
//   POST /api/crm/academies/:id/unmark              { rowId }                    undo a mark, or a stuck claim
//   POST /api/crm/academies/:id/settings            { autoInvoice }
//   POST /api/crm/academies/:id/apply-order         { orderId }   a signed order, onto this academy
//   GET  /api/crm/companies/:id/academy             the company page card (companies.js routes it here)
//   cron academy-alerts                             daily: alerts, automatic invoices, statuses from Xero
//   recordAcademyOrder()                            called when a proposal with an academy is signed

import sql from '../db.js';
import { makeId, trimOrNull, escapeHtml } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { isFreelancer } from './access.js';
import { APP_URL } from '../email.js';
import { emailInvoice } from '../xero.js';
import { sendNotification, ensureAcademyNotificationDefaults } from '../notifications.js';
import { getAcademy, linkAcademy, listAcademies, listPlans, setAcademyPlan } from '../lms.js';
import { createXeroInvoiceForDeal, syncManualInvoicesFromXero } from './invoices.js';
import {
  academyFlags, academyTotals, alertsFor, billingDue, fmtDay, isBilled, pounds,
} from './academyBilling.js';

const VIEW_PERMS = ['finance.manage', 'finance.pending_payments', 'invoices.manage'];
const LINK_PERMS = ['companies.manage_all', 'finance.manage', 'invoices.manage'];
const INVOICE_PERMS = ['invoices.manage'];
const VAT_RATE = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const gbp = (pounds) => `£${Number(pounds || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function can(user, perms) {
  const role = await getRole(user?.role);
  return perms.some((p) => hasPermission(role, p));
}

// ── Tables ──────────────────────────────────────────────────────────────────

// academy_invoices: what has been billed for which academy period, one row per
// line, so a period can never be invoiced twice (the unique index) and each row
// knows the CRM invoice it went on. A row with no invoice is either a period
// marked as billed some other way (source 'elsewhere') or a claim taken just
// before Xero was asked (source 'invoice'), which the unmark action can clear if
// the request died in between. academy_alerts: which alert has gone out, once.
// academy_settings: per academy, whether its invoices raise themselves.
// academy_orders: an academy sold on a proposal, waiting for (or applied to) the
// academy it is for; a set-up fee on it is billed once it is applied.
//
// Never rejects: a self-heal that throws once took the whole CRM down with it.
let tablesReady = null;
export function ensureAcademyTables() {
  if (tablesReady) return tablesReady;
  tablesReady = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS academy_invoices (
        id                TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        company_id        TEXT,
        kind              TEXT NOT NULL,
        period_key        TEXT NOT NULL,
        label             TEXT,
        amount_ex_vat     NUMERIC NOT NULL DEFAULT 0,
        manual_invoice_id TEXT,
        source            TEXT NOT NULL DEFAULT 'invoice',
        note              TEXT,
        created_by        TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS academy_invoices_period_uniq ON academy_invoices (tenant_id, kind, period_key)`;
    await sql`CREATE INDEX IF NOT EXISTS academy_invoices_manual_idx ON academy_invoices (manual_invoice_id)`;
    await sql`
      CREATE TABLE IF NOT EXISTS academy_alerts (
        tenant_id  TEXT NOT NULL,
        kind       TEXT NOT NULL,
        period_key TEXT NOT NULL,
        sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, kind, period_key)
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS academy_settings (
        tenant_id    TEXT PRIMARY KEY,
        auto_invoice BOOLEAN NOT NULL DEFAULT FALSE,
        updated_by   TEXT,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS academy_orders (
        id             TEXT PRIMARY KEY,
        proposal_id    TEXT UNIQUE,
        deal_id        TEXT,
        company_id     TEXT,
        tenant_id      TEXT,
        plan           TEXT NOT NULL,
        plan_name      TEXT,
        billing_period TEXT,
        setup_fee      NUMERIC NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'waiting',
        signer_name    TEXT,
        signer_email   TEXT,
        applied_at     TIMESTAMPTZ,
        applied_by     TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
  })().catch((err) => {
    tablesReady = null;
    console.warn('[academies] ensureAcademyTables failed', err?.message || err);
  });
  return tablesReady;
}

// ── Reading ─────────────────────────────────────────────────────────────────

// Academy invoices still waiting on Xero, refreshed from it: the same poll the
// company invoices card runs, so a paid academy invoice turns paid here too.
// Best-effort and bounded; a Xero hiccup must not stop the page loading.
async function syncAcademyInvoices(tenantIds = null) {
  try {
    const rows = tenantIds
      ? await sql`
          SELECT DISTINCT ai.manual_invoice_id AS id FROM academy_invoices ai
            JOIN manual_invoices mi ON mi.id = ai.manual_invoice_id
           WHERE mi.status = 'issued' AND mi.xero_invoice_id IS NOT NULL
             AND ai.tenant_id = ANY(${tenantIds})`
      : await sql`
          SELECT DISTINCT ai.manual_invoice_id AS id FROM academy_invoices ai
            JOIN manual_invoices mi ON mi.id = ai.manual_invoice_id
           WHERE mi.status = 'issued' AND mi.xero_invoice_id IS NOT NULL`;
    if (rows.length) await syncManualInvoicesFromXero(rows.map((r) => r.id).slice(0, 50));
  } catch (err) {
    console.warn('[academies] invoice sync failed', err?.message || err);
  }
}

// Rows grouped by academy, each query guarded: a missing table is an empty map.
async function groupedByTenant(query) {
  try {
    const out = new Map();
    for (const r of await query) {
      if (!out.has(r.tenant_id)) out.set(r.tenant_id, []);
      out.get(r.tenant_id).push(r);
    }
    return out;
  } catch (err) {
    console.warn('[academies] read failed', err?.message || err);
    return new Map();
  }
}

const invoiceRows = (tenantIds) => (tenantIds.length ? groupedByTenant(sql`
  SELECT ai.*, mi.invoice_number, mi.status AS invoice_status, mi.amount AS invoice_amount,
         mi.paid_at AS invoice_paid_at, mi.issued_at AS invoice_issued_at, mi.xero_invoice_id
    FROM academy_invoices ai
    LEFT JOIN manual_invoices mi ON mi.id = ai.manual_invoice_id
   WHERE ai.tenant_id = ANY(${tenantIds})
   ORDER BY ai.created_at DESC`) : Promise.resolve(new Map()));

const orderRows = (tenantIds) => (tenantIds.length ? groupedByTenant(sql`
  SELECT * FROM academy_orders WHERE tenant_id = ANY(${tenantIds}) ORDER BY created_at DESC`)
  : Promise.resolve(new Map()));

async function settingsFor(tenantIds) {
  if (!tenantIds.length) return new Map();
  try {
    const rows = await sql`SELECT tenant_id, auto_invoice FROM academy_settings WHERE tenant_id = ANY(${tenantIds})`;
    return new Map(rows.map((r) => [r.tenant_id, { autoInvoice: r.auto_invoice === true }]));
  } catch {
    return new Map();
  }
}

function serialiseInvoiceRow(r) {
  return {
    id: r.id,
    kind: r.kind,
    periodKey: r.period_key,
    label: r.label || null,
    amountExVat: Number(r.amount_ex_vat) || 0,
    source: r.source,
    note: r.note || null,
    createdAt: r.created_at,
    createdBy: r.created_by || null,
    invoice: r.manual_invoice_id ? {
      id: r.manual_invoice_id,
      number: r.invoice_number || null,
      status: r.invoice_status || null,
      amount: r.invoice_amount === null || r.invoice_amount === undefined ? null : Number(r.invoice_amount),
      issuedAt: r.invoice_issued_at || null,
      paidAt: r.invoice_paid_at || null,
      pdfUrl: r.xero_invoice_id ? '/api/xero/invoice-pdf?invoiceId=' + encodeURIComponent(r.xero_invoice_id) : null,
    } : null,
  };
}

function serialiseOrder(r) {
  return {
    id: r.id,
    proposalId: r.proposal_id || null,
    dealId: r.deal_id || null,
    companyId: r.company_id || null,
    tenantId: r.tenant_id || null,
    plan: r.plan,
    planName: r.plan_name || null,
    billingPeriod: r.billing_period || null,
    setupFee: Number(r.setup_fee) || 0,
    status: r.status,
    signerName: r.signer_name || null,
    signerEmail: r.signer_email || null,
    appliedAt: r.applied_at || null,
    createdAt: r.created_at,
  };
}

// Each academy from the platform, with what the CRM knows about it: its
// company, what is due to invoice, what needs attention, what was billed, its
// signed orders and whether its invoices raise themselves.
async function composeAcademies(academies, now = new Date()) {
  const ids = academies.map((a) => a.id);
  const companyIds = [...new Set(academies.map((a) => a.crmCompanyId).filter(Boolean))];
  const [companies, invoices, orders, settings] = await Promise.all([
    companyIds.length ? sql`SELECT id, name FROM companies WHERE id = ANY(${companyIds})` : [],
    invoiceRows(ids),
    orderRows(ids),
    settingsFor(ids),
  ]);
  const byCompany = new Map(companies.map((c) => [c.id, c]));
  return academies.map((a) => {
    const rows = invoices.get(a.id) || [];
    const mine = (orders.get(a.id) || []).map(serialiseOrder);
    const due = billingDue(a, rows.map((r) => ({ kind: r.kind, periodKey: r.period_key })), now, mine);
    const company = a.crmCompanyId
      ? (byCompany.has(a.crmCompanyId)
        ? { id: a.crmCompanyId, name: byCompany.get(a.crmCompanyId).name }
        : { id: a.crmCompanyId, name: null, missing: true })
      : null;
    return {
      ...a,
      company,
      billed: isBilled(a),
      due,
      dueTotal: round2(due.reduce((sum, l) => sum + l.amount, 0)),
      flags: academyFlags(a, due, now),
      invoices: rows.map(serialiseInvoiceRow),
      orders: mine,
      autoInvoice: settings.get(a.id)?.autoInvoice === true,
    };
  });
}

async function composeOne(id) {
  const academy = await getAcademy(id);
  if (!academy) return null;
  const [row] = await composeAcademies([academy]);
  return row;
}

async function waitingOrders() {
  try {
    const rows = await sql`
      SELECT o.*, c.name AS company_name, d.title AS deal_title
        FROM academy_orders o
        LEFT JOIN companies c ON c.id = o.company_id
        LEFT JOIN deals d ON d.id = o.deal_id
       WHERE o.status = 'waiting'
       ORDER BY o.created_at`;
    return rows.map((r) => ({ ...serialiseOrder(r), companyName: r.company_name || null, dealTitle: r.deal_title || null }));
  } catch {
    return [];
  }
}

const lmsError = (res, err) => res.status(err?.status || 502).json({
  error: err?.message || 'The academy platform could not be reached.',
});

// ── Invoicing ───────────────────────────────────────────────────────────────

/**
 * Raise one Xero invoice for an academy's lines. Each line's period is claimed
 * before Xero is asked, so two people (or a person and the daily job) can never
 * bill the same period twice; a Xero failure releases the claims. With `email`,
 * Xero then sends the invoice to the client. Throws with a .status on failure.
 */
async function raiseAcademyInvoice(academy, company, lines, { user = null, email = false, issuedAt, dueAt } = {}) {
  const claimed = [];
  for (const line of lines) {
    const [row] = await sql`
      INSERT INTO academy_invoices (id, tenant_id, company_id, kind, period_key, label, amount_ex_vat, source, created_by)
      VALUES (${makeId('acinv')}, ${academy.id}, ${company.id}, ${line.kind}, ${line.periodKey}, ${line.label},
              ${line.amount}, 'invoice', ${user?.email || null})
      ON CONFLICT (tenant_id, kind, period_key) DO NOTHING
      RETURNING id`;
    if (!row) {
      if (claimed.length) await sql`DELETE FROM academy_invoices WHERE id = ANY(${claimed})`;
      const e = new Error('Somebody has just invoiced part of this. Refresh to see it.');
      e.status = 409;
      throw e;
    }
    claimed.push(row.id);
  }

  let invoice;
  try {
    invoice = await createXeroInvoiceForDeal({
      companyId: company.id,
      lineItems: lines.map((l) => ({ description: l.label, quantity: 1, unitAmount: l.amount, vatRate: VAT_RATE })),
      reference: `Squideo Academy: ${academy.name}`.slice(0, 250),
      issuedAt: issuedAt || undefined,
      dueAt: dueAt || undefined,
    }, user || {});
  } catch (err) {
    await sql`DELETE FROM academy_invoices WHERE id = ANY(${claimed})`;
    const e = new Error(err?.message || 'Xero did not accept the invoice.');
    e.status = err?.status || 502;
    throw e;
  }

  const manualId = String(invoice.id || '').replace(/^manual:/, '');
  await sql`UPDATE academy_invoices SET manual_invoice_id = ${manualId} WHERE id = ANY(${claimed})`;
  let emailed = false;
  if (email && invoice.xeroInvoiceId) {
    try {
      await emailInvoice(invoice.xeroInvoiceId);
      emailed = true;
    } catch (err) {
      // The invoice exists either way; the page says it was not sent.
      console.warn('[academies] Xero email failed', err?.message || err);
    }
  }
  return { ...invoice, emailed };
}

// The route's side: the lines that are due, worked out here rather than taken
// from the request, plus any custom lines (an upgrade for the rest of the year,
// a set-up fee not on a proposal).
async function raiseInvoiceRoute(req, res, id, user) {
  if (!(await can(user, INVOICE_PERMS))) {
    return res.status(403).json({ error: 'You do not have permission to raise invoices.' });
  }
  let academy;
  try { academy = await composeOne(id); } catch (err) { return lmsError(res, err); }
  if (!academy) return res.status(404).json({ error: 'Academy not found' });
  if (!academy.company) {
    return res.status(400).json({ error: 'Link this academy to a company first, so the invoice knows who it is for.' });
  }
  if (academy.company.missing) {
    return res.status(400).json({ error: 'The company this academy is linked to is no longer in the CRM. Link it again.' });
  }

  const lines = [];
  for (const wanted of Array.isArray(req.body?.lines) ? req.body.lines : []) {
    if (['plan', 'extras', 'setup'].includes(wanted?.kind)) {
      const line = academy.due.find((l) => l.kind === wanted.kind && l.periodKey === wanted.periodKey);
      if (!line) return res.status(409).json({ error: 'Part of that has already been invoiced, or is no longer due. Refresh and try again.' });
      lines.push(line);
    } else if (wanted?.kind === 'custom') {
      const label = trimOrNull(wanted.label);
      const amount = round2(wanted.amount);
      if (!label || !(amount > 0)) return res.status(400).json({ error: 'Give each extra line a description and an amount.' });
      lines.push({ kind: 'custom', periodKey: `custom:${makeId('line')}`, label: label.slice(0, 300), amount });
    }
  }
  if (!lines.length) return res.status(400).json({ error: 'Choose at least one line to invoice.' });

  let invoice;
  try {
    invoice = await raiseAcademyInvoice(academy, academy.company, lines, {
      user,
      email: req.body?.email !== false,
      issuedAt: trimOrNull(req.body?.issuedAt),
      dueAt: trimOrNull(req.body?.dueAt),
    });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
  let composed = null;
  try { composed = await composeOne(id); } catch { /* the invoice exists; the page refreshes */ }
  return res.status(200).json({ invoice, academy: composed });
}

// ── Orders ──────────────────────────────────────────────────────────────────

// Put a signed order onto the academy it is for: link the academy to the deal's
// company and set the plan on the platform (a trial keeps running, with this
// plan to follow). A set-up fee then shows as due.
async function applyOrder(order, tenantId, user = null) {
  if (order.company_id || order.companyId) await linkAcademy(tenantId, order.company_id || order.companyId);
  await setAcademyPlan(tenantId, order.plan, order.billing_period || order.billingPeriod);
  await sql`
    UPDATE academy_orders
       SET status = 'applied', tenant_id = ${tenantId}, applied_at = NOW(), applied_by = ${user?.email || null}
     WHERE id = ${order.id}`;
}

// Whoever looks after the account: the owner of the company's latest deal.
async function accountOwner(companyId) {
  if (!companyId) return null;
  const [deal] = await sql`
    SELECT id, owner_email FROM deals
     WHERE company_id = ${companyId} AND owner_email IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`;
  return deal ? { dealId: deal.id, email: deal.owner_email } : null;
}

async function leaveTask(owner, title, notes, dueInDays = 2) {
  if (!owner) return;
  const taskId = makeId('task');
  const dueAt = new Date(Date.now() + dueInDays * 86_400_000).toISOString();
  await sql`
    INSERT INTO tasks (id, deal_id, title, notes, due_at, assignee_email, created_by)
    VALUES (${taskId}, ${owner.dealId}, ${title}, ${notes}, ${dueAt}, ${owner.email}, NULL)`;
  await sql`INSERT INTO task_assignees (task_id, user_email) VALUES (${taskId}, ${owner.email}) ON CONFLICT DO NOTHING`;
}

/**
 * A proposal with a Squideo Academy on it has been signed. Record the order;
 * if the proposal named the academy, apply it now, otherwise tell whoever sets
 * academies up and leave the deal owner a task. Never throws: signing has
 * happened whatever happens here, and the Academies page can apply it later.
 */
export async function recordAcademyOrder({ proposalId, dealId, proposalData, signerName = null, signerEmail = null }) {
  const offer = proposalData?.academy;
  if (!offer?.enabled || !offer.plan?.slug) return null;
  try {
    await ensureAcademyTables();
    const [deal] = dealId ? await sql`SELECT id, title, company_id, owner_email FROM deals WHERE id = ${dealId}` : [];
    const [row] = await sql`
      INSERT INTO academy_orders (id, proposal_id, deal_id, company_id, plan, plan_name, billing_period,
                                  setup_fee, signer_name, signer_email)
      VALUES (${makeId('acord')}, ${proposalId}, ${dealId || null}, ${deal?.company_id || null},
              ${offer.plan.slug}, ${offer.plan.name || null},
              ${offer.billingPeriod === 'annual' ? 'annual' : 'monthly'},
              ${round2(offer.setupFee) > 0 ? round2(offer.setupFee) : 0}, ${signerName}, ${signerEmail})
      ON CONFLICT (proposal_id) DO UPDATE SET
        deal_id = EXCLUDED.deal_id, company_id = EXCLUDED.company_id, tenant_id = NULL,
        plan = EXCLUDED.plan, plan_name = EXCLUDED.plan_name, billing_period = EXCLUDED.billing_period,
        setup_fee = EXCLUDED.setup_fee, signer_name = EXCLUDED.signer_name, signer_email = EXCLUDED.signer_email,
        status = 'waiting', applied_at = NULL, applied_by = NULL, created_at = NOW()
        WHERE academy_orders.status = 'cancelled'
      RETURNING *`;
    if (!row) return null;

    let applyError = null;
    if (offer.tenantId && UUID_RE.test(String(offer.tenantId))) {
      try {
        await applyOrder(row, offer.tenantId, null);
        return { ...row, status: 'applied' };
      } catch (err) {
        applyError = err?.message || 'the academy platform did not answer';
        console.warn('[academies] could not apply order on signing', applyError);
      }
    }

    const who = deal?.title || offer.tenantName || 'a client';
    const subject = `Academy sold: ${who}, ${offer.plan.name || offer.plan.slug} (${row.billing_period})`;
    const body = `${who} signed a proposal with a Squideo Academy on it: ${offer.plan.name || offer.plan.slug}, billed ${row.billing_period}`
      + `${Number(row.setup_fee) > 0 ? `, with a ${gbp(row.setup_fee)} set-up fee` : ''}. `
      + (applyError
        ? `It names ${offer.tenantName || 'an academy'}, but putting that academy on the plan failed (${applyError}). Apply the order on the Academies page.`
        : 'Set the academy up in the staff CMS, then apply the order on the Academies page.');
    const link = `${APP_URL}/#/academies`;
    await ensureAcademyNotificationDefaults();
    await sendNotification('academy.order_waiting', {
      subject,
      text: `${body}\n\n${link}`,
      html: `<p>${escapeHtml(body)}</p><p><a href="${link}">Open Academies</a></p>`,
      inApp: { title: subject, body, link: '#/academies' },
    }).catch((err) => console.warn('[academies] order notification failed', err?.message || err));
    if (deal?.owner_email) {
      await leaveTask({ dealId: deal.id, email: deal.owner_email }, `Set up ${who}'s Squideo Academy`, body, 1)
        .catch((err) => console.warn('[academies] order task failed', err?.message || err));
    }
    return row;
  } catch (err) {
    console.warn('[academies] recordAcademyOrder failed', err?.message || err);
    return null;
  }
}

/**
 * The signature on a proposal was taken off: its order no longer stands. The
 * academy keeps whatever plan it was put on (change that in the staff CMS if it
 * should not), but a set-up fee not yet invoiced stops being due, and signing
 * again records the order afresh. Never throws.
 */
export async function cancelAcademyOrder(proposalId) {
  try {
    await ensureAcademyTables();
    await sql`
      UPDATE academy_orders SET status = 'cancelled'
       WHERE proposal_id = ${proposalId} AND status IN ('waiting', 'applied')`;
  } catch (err) {
    console.warn('[academies] cancelAcademyOrder failed', err?.message || err);
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

export async function academiesRoute(req, res, id, action, user) {
  await ensureAcademyTables();

  if (!id) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (!(await can(user, VIEW_PERMS))) {
      return res.status(403).json({ error: 'You do not have permission to see academy billing.' });
    }
    await syncAcademyInvoices();
    let academies;
    try { academies = await listAcademies(); } catch (err) { return lmsError(res, err); }
    const now = new Date();
    const rows = await composeAcademies(academies, now);
    return res.status(200).json({
      academies: rows,
      totals: academyTotals(rows, now),
      orders: await waitingOrders(),
      canLink: await can(user, LINK_PERMS),
      canInvoice: await can(user, INVOICE_PERMS),
    });
  }

  // For the proposal builder, open to anyone who can build a proposal: prices,
  // and academies by name, with no money attached. Not to freelancers, who
  // see only the projects they are on.
  if ((id === 'plans' || id === 'options') && req.method === 'GET' && isFreelancer(await getRole(user?.role))) {
    return res.status(403).json({ error: 'Your account cannot see academies.' });
  }
  if (id === 'plans' && req.method === 'GET') {
    try { return res.status(200).json({ plans: await listPlans() }); } catch (err) { return lmsError(res, err); }
  }
  if (id === 'options' && req.method === 'GET') {
    try {
      const academies = await listAcademies();
      return res.status(200).json({
        academies: academies.filter((a) => !a.demo).map((a) => ({
          id: a.id, name: a.name, subdomain: a.subdomain, crmCompanyId: a.crmCompanyId || null,
        })),
      });
    } catch (err) { return lmsError(res, err); }
  }

  if (!UUID_RE.test(String(id))) return res.status(404).json({ error: 'Academy not found' });

  if (!action && req.method === 'GET') {
    if (!(await can(user, VIEW_PERMS))) {
      return res.status(403).json({ error: 'You do not have permission to see academy billing.' });
    }
    await syncAcademyInvoices([id]);
    try {
      const academy = await composeOne(id);
      return academy ? res.status(200).json({ academy }) : res.status(404).json({ error: 'Academy not found' });
    } catch (err) { return lmsError(res, err); }
  }

  if (action === 'link' && req.method === 'POST') {
    if (!(await can(user, LINK_PERMS))) {
      return res.status(403).json({ error: 'You do not have permission to link academies to companies.' });
    }
    const companyId = trimOrNull(req.body?.companyId);
    if (companyId) {
      const [company] = await sql`SELECT id FROM companies WHERE id = ${companyId}`;
      if (!company) return res.status(400).json({ error: 'That company is not in the CRM.' });
    }
    try {
      await linkAcademy(id, companyId);
      return res.status(200).json({ academy: await composeOne(id) });
    } catch (err) { return lmsError(res, err); }
  }

  if (action === 'invoice' && req.method === 'POST') return raiseInvoiceRoute(req, res, id, user);

  if (action === 'mark-invoiced' && req.method === 'POST') {
    if (!(await can(user, INVOICE_PERMS))) {
      return res.status(403).json({ error: 'You do not have permission to manage invoices.' });
    }
    let academy;
    try { academy = await composeOne(id); } catch (err) { return lmsError(res, err); }
    if (!academy) return res.status(404).json({ error: 'Academy not found' });
    const line = academy.due.find((l) => l.kind === req.body?.kind && l.periodKey === req.body?.periodKey);
    if (!line) return res.status(409).json({ error: 'That has already been billed, or is not due.' });
    await sql`
      INSERT INTO academy_invoices (id, tenant_id, company_id, kind, period_key, label, amount_ex_vat, source, note, created_by)
      VALUES (${makeId('acinv')}, ${id}, ${academy.crmCompanyId || null}, ${line.kind}, ${line.periodKey},
              ${line.label}, ${line.amount}, 'elsewhere', ${trimOrNull(req.body?.note)}, ${user?.email || null})
      ON CONFLICT (tenant_id, kind, period_key) DO NOTHING`;
    try { return res.status(200).json({ academy: await composeOne(id) }); } catch (err) { return lmsError(res, err); }
  }

  if (action === 'unmark' && req.method === 'POST') {
    if (!(await can(user, INVOICE_PERMS))) {
      return res.status(403).json({ error: 'You do not have permission to manage invoices.' });
    }
    // Only a row with no invoice behind it: an invoice raised in Xero is voided
    // there, not forgotten here.
    await sql`
      DELETE FROM academy_invoices
       WHERE id = ${trimOrNull(req.body?.rowId)} AND tenant_id = ${id} AND manual_invoice_id IS NULL`;
    try { return res.status(200).json({ academy: await composeOne(id) }); } catch (err) { return lmsError(res, err); }
  }

  if (action === 'settings' && req.method === 'POST') {
    if (!(await can(user, INVOICE_PERMS))) {
      return res.status(403).json({ error: 'You do not have permission to manage invoices.' });
    }
    const autoInvoice = req.body?.autoInvoice === true;
    await sql`
      INSERT INTO academy_settings (tenant_id, auto_invoice, updated_by, updated_at)
      VALUES (${id}, ${autoInvoice}, ${user?.email || null}, NOW())
      ON CONFLICT (tenant_id) DO UPDATE SET auto_invoice = EXCLUDED.auto_invoice,
        updated_by = EXCLUDED.updated_by, updated_at = NOW()`;
    try { return res.status(200).json({ academy: await composeOne(id) }); } catch (err) { return lmsError(res, err); }
  }

  if (action === 'apply-order' && req.method === 'POST') {
    if (!(await can(user, LINK_PERMS))) {
      return res.status(403).json({ error: 'You do not have permission to set academies up.' });
    }
    const [order] = await sql`SELECT * FROM academy_orders WHERE id = ${trimOrNull(req.body?.orderId)}`;
    if (!order) return res.status(404).json({ error: 'That order is not in the CRM.' });
    if (order.status !== 'waiting') return res.status(409).json({ error: 'That order has already been applied.' });
    try {
      await applyOrder(order, id, user);
      return res.status(200).json({ academy: await composeOne(id), orders: await waitingOrders() });
    } catch (err) { return lmsError(res, err); }
  }

  return res.status(404).json({ error: 'Unknown action' });
}

// The Academy card on a company page. Never fails the page: with the platform
// unreachable it says so and shows nothing else.
export async function companyAcademyRoute(req, res, companyId, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  await ensureAcademyTables();
  const canLink = await can(user, LINK_PERMS);
  const canInvoice = await can(user, INVOICE_PERMS);
  let academies;
  try {
    academies = await listAcademies();
  } catch (err) {
    return res.status(200).json({ connected: false, error: err?.message || null, academies: [], unlinked: [], canLink, canInvoice });
  }
  const mine = academies.filter((a) => a.crmCompanyId === companyId);
  if (mine.length) await syncAcademyInvoices(mine.map((a) => a.id));
  return res.status(200).json({
    connected: true,
    academies: await composeAcademies(mine),
    // Academies not yet linked to anyone, for the "Link an academy" picker. The
    // demos are for prospects, not clients, so they are not offered.
    unlinked: canLink
      ? academies.filter((a) => !a.crmCompanyId && !a.demo).map((a) => ({ id: a.id, name: a.name, subdomain: a.subdomain }))
      : [],
    canLink,
    canInvoice,
  });
}

// ── For Finance ─────────────────────────────────────────────────────────────

/**
 * What academies are expected to pay: every linked academy's due lines, and
 * the CRM invoices that carry academy lines, for Pending Payments and the
 * Predicted tab. Best-effort: Finance must load even when the platform does not.
 */
export async function academyFinanceView() {
  await ensureAcademyTables();
  let invoiceIds = [];
  try {
    invoiceIds = (await sql`SELECT DISTINCT manual_invoice_id FROM academy_invoices WHERE manual_invoice_id IS NOT NULL`)
      .map((r) => r.manual_invoice_id);
  } catch { invoiceIds = []; }
  let academies = [];
  try { academies = await listAcademies(); } catch { return { due: [], invoiceIds, connected: false }; }
  const rows = await composeAcademies(academies.filter((a) => a.crmCompanyId && !a.demo));
  const due = [];
  for (const a of rows) {
    for (const line of a.due) {
      due.push({
        key: `academy:${a.id}:${line.periodKey}`,
        tenantId: a.id,
        academy: a.name,
        company: a.company?.name || a.name,
        companyId: a.company?.id || null,
        kind: line.kind,
        label: line.label,
        amountExVat: line.amount,
      });
    }
  }
  return { due, invoiceIds, connected: true };
}

// ── Alerts and the daily job ────────────────────────────────────────────────

const ALERT_KEYS = {
  trial_ending: 'academy.trial_ending',
  plan_requested: 'academy.plan_requested',
  over_allowance: 'academy.over_allowance',
  low_usage: 'academy.low_usage',
  renewal_due: 'academy.renewal_due',
};

const gbpPence = (pence) => gbp(pounds(pence));

// What each alert says, and the task it leaves for the account owner.
function alertMessage(a, alert, companyName) {
  const s = a.summary;
  const who = companyName ? `${a.name} (${companyName})` : a.name;
  const usage = s.usage?.average !== null && s.usage?.average !== undefined
    ? `Three-month average: ${s.usage.average} active learners, against ${s.cap ?? 'no'} included.` : '';
  switch (alert.kind) {
    case 'trial_ending': return {
      subject: `${a.name}'s academy trial ends in ${s.trial.daysLeft} days`,
      body: `${who} is on the free trial until ${fmtDay(s.trial.endsAt)}. `
        + (s.afterTrial && s.afterTrial.slug !== 'free'
          ? `It moves onto ${s.afterTrial.name} afterwards.` : 'No plan is chosen yet, so it will drop to Free.'),
      task: `Call ${companyName || a.name} about a plan before their academy trial ends`,
    };
    case 'plan_requested': return {
      subject: `${a.name} has asked for the ${s.request.plan.name} plan`,
      body: `${who} asked for ${s.request.plan.name}${s.request.billingPeriod ? `, billed ${s.request.billingPeriod}` : ''}`
        + `${s.request.byName ? `, from ${s.request.byName}` : ''}. Set it up in the staff CMS, then invoice it.`,
      task: `Set ${companyName || a.name} up on the ${s.request.plan.name} plan`,
    };
    case 'over_allowance': return {
      subject: `${a.name} has outgrown its academy plan`,
      body: `${who} has gone over its ${s.plan.name} allowance two months running. ${usage}`
        + (s.check?.suggested ? ` ${s.check.suggested.name} fits it.` : ''),
      task: `Talk to ${companyName || a.name} about moving their academy up a plan`,
    };
    case 'low_usage': return {
      subject: `${a.name} is barely using its academy`,
      body: `${who} is on ${s.plan.name} but hardly anyone is learning. ${usage} Worth a check-in before it comes up for renewal.`,
      task: `Check in with ${companyName || a.name}: their academy is hardly being used`,
    };
    case 'renewal_due': return {
      subject: `${a.name}'s academy renews on ${fmtDay(s.renewsAt)}`,
      body: `${who} renews ${s.plan.name} (${gbpPence(s.plan.annual)} a year) on ${fmtDay(s.renewsAt)}. ${usage}`
        + (s.check?.suggested ? ` Sized on that, it fits ${s.check.suggested.name}.` : ''),
      task: `Renewal conversation with ${companyName || a.name} about their academy`,
    };
    default: return null;
  }
}

/**
 * Daily: raise the academy alerts that are due, each once, as a bell alert for
 * whoever follows academies and a task for the account owner; raise and send
 * the invoices of academies set to invoice themselves; and refresh the status
 * of academy invoices from Xero, so a payment shows without anybody opening a
 * page.
 */
export async function cronAcademyAlerts(res) {
  await ensureAcademyTables();
  await ensureAcademyNotificationDefaults();
  let academies;
  try {
    academies = await listAcademies();
  } catch (err) {
    return res.status(200).json({ ok: false, error: err?.message || 'The academy platform could not be reached.' });
  }
  await syncAcademyInvoices();

  const now = new Date();
  const composed = await composeAcademies(academies.filter((a) => !a.demo), now);
  let sent = 0;
  let invoiced = 0;

  for (const a of composed) {
    for (const alert of alertsFor(a, now)) {
      const [claim] = await sql`
        INSERT INTO academy_alerts (tenant_id, kind, period_key)
        VALUES (${a.id}, ${alert.kind}, ${alert.periodKey})
        ON CONFLICT DO NOTHING
        RETURNING tenant_id`;
      if (!claim) continue;
      const companyName = a.company && !a.company.missing ? a.company.name : null;
      const msg = alertMessage(a, alert, companyName);
      if (!msg) continue;
      const link = `${APP_URL}/#/academies`;
      try {
        await sendNotification(ALERT_KEYS[alert.kind], {
          subject: msg.subject,
          text: `${msg.body}\n\nOpen Academies: ${link}`,
          html: `<p>${escapeHtml(msg.body)}</p><p><a href="${link}">Open Academies</a></p>`,
          inApp: { title: msg.subject, body: msg.body, link: '#/academies' },
        });
        await leaveTask(await accountOwner(a.crmCompanyId), msg.task, msg.body);
        sent += 1;
      } catch (err) {
        console.warn('[academies] alert failed', a.subdomain, alert.kind, err?.message || err);
      }
    }

    // Invoices that raise themselves: everything due, on one invoice, sent by
    // Xero. The same claims as the button, so the two can never both bill it.
    if (a.autoInvoice && a.due.length && a.company && !a.company.missing) {
      try {
        const invoice = await raiseAcademyInvoice(a, a.company, a.due, { email: true });
        invoiced += 1;
        const total = round2(a.due.reduce((sum, l) => sum + l.amount, 0));
        const subject = `Academy invoice raised: ${a.company.name}, ${gbp(total)} + VAT`;
        const body = `${invoice.invoiceNumber || 'An invoice'} for ${a.name}: ${a.due.map((l) => l.label).join('; ')}. `
          + (invoice.emailed ? 'Xero has emailed it to the client.' : 'Xero could not email it: send it from Xero.');
        await sendNotification('academy.invoice_raised', {
          subject,
          text: body,
          html: `<p>${escapeHtml(body)}</p>`,
          inApp: { title: subject, body, link: '#/academies' },
        }).catch(() => {});
      } catch (err) {
        console.warn('[academies] automatic invoice failed', a.subdomain, err?.message || err);
      }
    }
  }
  return res.status(200).json({ ok: true, sent, invoiced });
}
