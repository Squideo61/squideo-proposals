// Squideo Academy by card: Starter and Team, paid as a Stripe subscription
// from the academy's own Plan page.
//
// The academy platform (squideo-lms) asks for everything here over the CRM's
// academy-billing API (api/academy-billing/[action].js), because the CRM owns
// the money and holds the Stripe account.
//
//   checkout   a Stripe Checkout for the chosen plan, charged with VAT on top.
//              During a free trial with more than two days to run, the card is
//              saved now and first charged when the trial ends; otherwise it is
//              charged today and any trial ends now.
//   completed  (webhook) the subscription is recorded, the academy linked to a
//              company (found by name, or created, with the payer as a
//              contact) and put on its plan.
//   payments   (webhook) every payment Stripe takes is mirrored into Xero as a
//              paid invoice to that company. That is what counts it as income
//              here (the Income ledger, Cash Flow) and in the accounts, and
//              Xero emails it to the client as their VAT invoice. A first
//              payment that arrives before its checkout has linked the company
//              waits for it: only the checkout creates a company.
//   daily job  extra people for a card academy go on a one-off Stripe invoice,
//              charged to the card on file; payments that could not reach Xero
//              are tried again; a paid checkout whose academy never got its
//              plan is finished off.
//   portal     Stripe's own page for the card, past invoices and cancelling.
//   change     between Starter and Team, monthly and annual: Stripe prorates,
//              and the platform moves the academy onto the new plan.
//   stop       staff stop the card at the end of the period paid for.
//   ended      (webhook) the academy drops to Free, unless somebody has
//              already moved it onto an invoiced plan.
//
// Stripe amounts include VAT; the pure rules for them are in ./academyBilling.js.

import Stripe from 'stripe';
import sql from '../db.js';
import { makeId, escapeHtml } from './shared.js';
import { APP_URL } from '../email.js';
import { createPayment, emailInvoice } from '../xero.js';
import { sendNotification, ensureAcademyNotificationDefaults } from '../notifications.js';
import { getAcademy, linkAcademy, patchAcademy } from '../lms.js';
import { createXeroInvoiceForDeal } from './invoices.js';
import { resolveContactForSigner } from '../portal/onboarding.js';
import { ensureAcademyTables } from './academyTables.js';
import {
  VAT_RATE, cardIsLive, cardPaymentLabel, cardRenewsAt, cardStateFor, cardStatusFrom, grossPence,
  holdUntilTrialEnds, splitGross,
} from './academyBilling.js';

export const CARD_PLANS = Object.freeze(['starter', 'team']);
const BILLING_PERIODS = ['monthly', 'annual'];
const KIND = 'academy_subscription';
const EXTRAS_KIND = 'academy_extras';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (status, message) => Object.assign(new Error(message), { status });
const today = () => new Date().toISOString().slice(0, 10);
const idOf = (v) => (typeof v === 'string' ? v : v?.id || null);
const gbpPence = (pence) => `£${(Number(pence || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function stripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) throw fail(503, 'Card payments are not set up on this server.');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// ── What the platform sends ─────────────────────────────────────────────────

function checkedPlan(plan, billingPeriod) {
  if (!plan || !CARD_PLANS.includes(plan.slug)) throw fail(400, 'That plan is set up with Squideo, not paid for by card.');
  if (!BILLING_PERIODS.includes(billingPeriod)) throw fail(400, 'Choose monthly or annual billing.');
  const exPence = Math.round(Number(billingPeriod === 'annual' ? plan.annual : plan.monthly));
  if (!(exPence > 0)) throw fail(400, 'That plan has no price.');
  return { slug: plan.slug, name: String(plan.name || plan.slug).slice(0, 60), exPence };
}

function checkedTenant(tenantId) {
  const id = String(tenantId || '');
  if (!UUID_RE.test(id)) throw fail(400, 'Which academy is this for?');
  return id;
}

// Where Stripe sends the admin back to: their own academy, over https.
function checkedUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw fail(400, 'A return address is missing.'); }
  const local = /(^|\.)(localhost|lvh\.me)$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw fail(400, 'Return addresses must be https.');
  return url.toString();
}

const metadataFor = (tenantId, plan, billingPeriod) => ({
  kind: KIND, tenantId, plan: plan.slug, planName: plan.name, billingPeriod, exVatPence: String(plan.exPence),
});

// One Stripe product per plan and period, with a fixed id so it is made once.
// The price is set on each subscription, so a price change needs no product.
const productsMade = new Set();
async function productFor(stripe, plan, billingPeriod) {
  const id = `squideo_academy_${plan.slug}_${billingPeriod}`;
  if (productsMade.has(id)) return id;
  try {
    await stripe.products.retrieve(id);
  } catch (err) {
    if (err?.code !== 'resource_missing' && err?.statusCode !== 404) throw err;
    await stripe.products.create({
      id,
      name: `Squideo Academy: ${plan.name} plan, ${billingPeriod === 'annual' ? 'annual' : 'monthly'} (inc. VAT)`,
      metadata: { kind: KIND, plan: plan.slug, billingPeriod },
    }).catch((e) => { if (e?.code !== 'resource_already_exists') throw e; });
  }
  productsMade.add(id);
  return id;
}

// ── The subscription, as the CRM keeps it ───────────────────────────────────

async function subscriptionRow(tenantId) {
  const [row] = await sql`SELECT * FROM academy_subscriptions WHERE tenant_id = ${tenantId}`;
  return row || null;
}

async function saveSubscription(tenantId, sub, { email = null } = {}) {
  const m = sub.metadata || {};
  const unit = sub.items?.data?.[0]?.price?.unit_amount;
  await sql`
    INSERT INTO academy_subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, plan, plan_name,
                                       billing_period, status, amount_gross, current_period_end, cancel_at, email, updated_at)
    VALUES (${tenantId}, ${idOf(sub.customer)}, ${sub.id}, ${m.plan || null}, ${m.planName || null},
            ${m.billingPeriod || null}, ${cardStatusFrom(sub)}, ${Number.isFinite(unit) ? unit / 100 : null},
            ${cardRenewsAt(sub)}, ${sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null}, ${email}, NOW())
    ON CONFLICT (tenant_id) DO UPDATE SET
      stripe_customer_id     = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      plan = EXCLUDED.plan, plan_name = EXCLUDED.plan_name, billing_period = EXCLUDED.billing_period,
      status = EXCLUDED.status, amount_gross = EXCLUDED.amount_gross,
      current_period_end = EXCLUDED.current_period_end, cancel_at = EXCLUDED.cancel_at,
      email = COALESCE(EXCLUDED.email, academy_subscriptions.email),
      activated_at = CASE WHEN academy_subscriptions.stripe_subscription_id IS DISTINCT FROM EXCLUDED.stripe_subscription_id
                          THEN NULL ELSE academy_subscriptions.activated_at END,
      updated_at = NOW()`;
}

/** The card subscriptions of these academies, by academy, for the Academies page. */
export async function cardRowsFor(tenantIds) {
  if (!tenantIds.length) return new Map();
  try {
    const rows = await sql`SELECT * FROM academy_subscriptions WHERE tenant_id = ANY(${tenantIds})`;
    return new Map(rows.map((r) => [r.tenant_id, serialiseCard(r)]));
  } catch {
    return new Map();
  }
}

function serialiseCard(r) {
  return {
    status: r.status,
    plan: r.plan,
    planName: r.plan_name || null,
    billingPeriod: r.billing_period || null,
    amountGross: r.amount_gross === null || r.amount_gross === undefined ? null : Number(r.amount_gross),
    renewsAt: r.current_period_end || null,
    cancelAt: r.cancel_at || null,
    email: r.email || null,
    subscriptionId: r.stripe_subscription_id || null,
    customerId: r.stripe_customer_id || null,
    live: cardIsLive({ status: r.status }),
  };
}

// The company an academy's card payments are invoiced to: the one it is linked
// to, else one with its name (academies are named by Squideo staff, so a name
// match is the client), else a new one, with whoever paid as its contact.
async function companyFor(academy, payer = {}) {
  if (academy.crmCompanyId) {
    const [linked] = await sql`SELECT id, name FROM companies WHERE id = ${academy.crmCompanyId}`;
    if (linked) return linked;
  }
  const name = String(academy.name || '').trim() || 'Squideo Academy client';
  const [found] = await sql`
    SELECT id, name FROM companies WHERE LOWER(TRIM(name)) = LOWER(${name}) ORDER BY created_at ASC LIMIT 1`;
  const company = found || { id: makeId('co'), name };
  if (!found) await sql`INSERT INTO companies (id, name) VALUES (${company.id}, ${name})`;
  await linkAcademy(academy.id, company.id);
  if (payer.email) {
    await resolveContactForSigner({ email: payer.email, name: payer.name || null, companyId: company.id, source: 'academy_card' })
      .catch((err) => console.warn('[academy cards] payer contact failed', err?.message || err));
  }
  return company;
}

async function tell(key, subject, body) {
  await ensureAcademyNotificationDefaults();
  const link = `${APP_URL}/#/academies`;
  await sendNotification(key, {
    subject,
    text: `${body}\n\n${link}`,
    html: `<p>${escapeHtml(body)}</p><p><a href="${link}">Open Academies</a></p>`,
    inApp: { title: subject, body, link: '#/academies' },
  }).catch((err) => console.warn('[academy cards] notification failed', key, err?.message || err));
}

// ── From the platform ───────────────────────────────────────────────────────

/** A Stripe Checkout for a card plan. Returns { url }. */
export async function createAcademyCheckout(stripe, body = {}) {
  await ensureAcademyTables();
  const tenantId = checkedTenant(body.tenantId);
  const plan = checkedPlan(body.plan, body.billingPeriod);
  const successUrl = checkedUrl(body.successUrl);
  const cancelUrl = checkedUrl(body.cancelUrl);
  const existing = await subscriptionRow(tenantId);
  if (existing && cardIsLive({ status: existing.status })) {
    throw fail(409, 'This academy already pays by card. Switch plan instead.');
  }
  const product = await productFor(stripe, plan, body.billingPeriod);
  const hold = holdUntilTrialEnds(body.trial);
  const metadata = metadataFor(tenantId, plan, body.billingPeriod);
  const who = existing?.stripe_customer_id
    ? { customer: existing.stripe_customer_id }
    : (body.email ? { customer_email: String(body.email).slice(0, 200) } : {});
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    ...who,
    client_reference_id: tenantId,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'gbp',
        product,
        unit_amount: grossPence(plan.exPence),
        recurring: { interval: body.billingPeriod === 'annual' ? 'year' : 'month' },
      },
    }],
    subscription_data: {
      description: `Squideo Academy for ${String(body.academyName || 'your academy').slice(0, 200)}`,
      metadata,
      ...(hold ? { trial_end: hold } : {}),
    },
    metadata,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return { url: session.url };
}

/** Stripe's page for the card, invoices and cancelling. Returns { url }. */
export async function createAcademyPortal(stripe, body = {}) {
  await ensureAcademyTables();
  const tenantId = checkedTenant(body.tenantId);
  const returnUrl = checkedUrl(body.returnUrl);
  const row = await subscriptionRow(tenantId);
  if (!row?.stripe_customer_id) throw fail(404, 'This academy does not pay by card.');
  try {
    const session = await stripe.billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: returnUrl });
    return { url: session.url };
  } catch (err) {
    // Usually the portal has not been set up in the Stripe dashboard yet.
    console.error('[academy cards] billing portal failed', err?.message || err);
    throw fail(503, 'Managing your card online is not available yet. Email Squideo and we will sort it out.');
  }
}

/**
 * Switch a card academy between Starter and Team, or monthly and annual. Stripe
 * charges or credits the difference for the time left (nothing during a trial),
 * and a card that declines leaves everything as it was.
 */
export async function changeAcademyCardPlan(stripe, body = {}) {
  await ensureAcademyTables();
  const tenantId = checkedTenant(body.tenantId);
  const target = checkedPlan(body.plan, body.billingPeriod);
  const row = await subscriptionRow(tenantId);
  if (!row?.stripe_subscription_id || !cardIsLive({ status: row.status })) {
    throw fail(409, 'This academy does not pay by card.');
  }
  const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
  const item = sub.items?.data?.[0];
  if (!item) throw fail(409, 'This card subscription has nothing to change.');
  const product = await productFor(stripe, target, body.billingPeriod);
  const trialing = sub.status === 'trialing';
  let updated;
  try {
    updated = await stripe.subscriptions.update(sub.id, {
      items: [{
        id: item.id,
        price_data: {
          currency: 'gbp',
          product,
          unit_amount: grossPence(target.exPence),
          recurring: { interval: body.billingPeriod === 'annual' ? 'year' : 'month' },
        },
      }],
      proration_behavior: trialing ? 'none' : 'always_invoice',
      ...(trialing ? {} : { payment_behavior: 'error_if_incomplete' }),
      // Choosing a plan is choosing to stay.
      cancel_at_period_end: false,
      metadata: metadataFor(tenantId, target, body.billingPeriod),
    });
  } catch (err) {
    if (err?.type === 'StripeCardError') throw fail(402, err.message || 'Your card was declined, so nothing has changed.');
    throw err;
  }
  await saveSubscription(tenantId, updated);
  await patchAcademy(tenantId, {
    plan: target.slug,
    billingPeriod: body.billingPeriod,
    keepRenewal: row.billing_period === 'annual' && body.billingPeriod === 'annual',
    card: cardStateFor(updated),
  });
  return { ok: true };
}

/** Staff: stop an academy's card at the end of the period it has paid for. */
export async function stopAcademyCard(stripe, tenantId) {
  await ensureAcademyTables();
  const row = await subscriptionRow(tenantId);
  if (!row?.stripe_subscription_id || !cardIsLive({ status: row.status })) {
    throw fail(409, 'This academy does not pay by card.');
  }
  const updated = await stripe.subscriptions.update(row.stripe_subscription_id, { cancel_at_period_end: true });
  await saveSubscription(tenantId, updated);
  if (row.activated_at) await patchAcademy(tenantId, { card: cardStateFor(updated) });
  return serialiseCard(await subscriptionRow(tenantId));
}

// ── From Stripe (api/stripe/[action].js) ───────────────────────────────────
//
// Each ignores events that are not its own, and throws when the academy
// platform cannot be reached, so the webhook answers 500 and Stripe sends the
// event again: an academy that has paid must end up on its plan.

/** checkout.session.completed: record it, link a company, put the academy on its plan. */
export async function completeAcademyCheckout(stripe, session) {
  if (session?.metadata?.kind !== KIND || session.mode !== 'subscription') return false;
  const tenantId = session.metadata.tenantId;
  const subId = idOf(session.subscription);
  if (!tenantId || !subId) return false;
  await ensureAcademyTables();
  const sub = await stripe.subscriptions.retrieve(subId);
  const email = session.customer_details?.email || session.customer_email || null;
  await saveSubscription(tenantId, sub, { email });
  return activate(tenantId, sub, { email, name: session.customer_details?.name || null });
}

// Put a paid-for academy on its plan, once.
async function activate(tenantId, sub, payer = {}) {
  const row = await subscriptionRow(tenantId);
  if (row?.activated_at && row.stripe_subscription_id === sub.id) return true;
  const academy = await getAcademy(tenantId);
  if (!academy) {
    console.error('[academy cards] paid for an academy the platform does not have', tenantId);
    return false;
  }
  const company = await companyFor(academy, payer);
  const m = sub.metadata || {};
  const body = { plan: m.plan, billingPeriod: m.billingPeriod, card: cardStateFor(sub) };
  // Charged today: whatever is left of a trial ends now. A first charge held
  // until the trial ends leaves it running, with this plan to follow.
  const phase = academy.summary?.trial?.phase;
  if (sub.status !== 'trialing' && phase && phase !== 'none') body.trial = 'end';
  await patchAcademy(tenantId, body);
  await sql`UPDATE academy_subscriptions SET activated_at = NOW() WHERE tenant_id = ${tenantId} AND stripe_subscription_id = ${sub.id}`;
  // A first payment that came in before the company was linked goes into Xero now.
  const waiting = await sql`
    SELECT stripe_invoice_id FROM academy_card_payments WHERE tenant_id = ${tenantId} AND manual_invoice_id IS NULL`;
  for (const p of waiting) await mirrorCardPayment(p.stripe_invoice_id);

  const amount = gbpPence(grossPence(Number(m.exVatPence) || 0));
  const per = m.billingPeriod === 'annual' ? 'a year' : 'a month';
  const first = sub.status === 'trialing' && sub.trial_end
    ? `The first payment is taken when its trial ends, on ${new Date(sub.trial_end * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`
    : 'The first payment has been taken.';
  await tell('academy.card_subscribed',
    `Academy paying by card: ${academy.name}, ${m.planName || m.plan}`,
    `${academy.name} (${company.name}) is now on ${m.planName || m.plan}, paying ${amount} ${per} by card, VAT included. ${first}`);
  return true;
}

async function academyInvoiceMeta(stripe, invoice) {
  if (!invoice) return null;
  if (invoice.metadata?.kind === EXTRAS_KIND && invoice.metadata.tenantId) return invoice.metadata;
  const subId = idOf(invoice.parent?.subscription_details?.subscription ?? invoice.subscription);
  if (!subId) return null;
  let meta = invoice.parent?.subscription_details?.metadata || invoice.subscription_details?.metadata || null;
  if (!meta?.kind) meta = (await stripe.subscriptions.retrieve(subId))?.metadata || null;
  return meta?.kind === KIND && meta.tenantId ? meta : null;
}

/** invoice.payment_succeeded / invoice.paid: record the payment and mirror it into Xero. */
export async function recordAcademyCardPayment(stripe, invoice) {
  const meta = await academyInvoiceMeta(stripe, invoice);
  if (!meta) return false;
  await ensureAcademyTables();
  const gross = Math.round(Number(invoice.amount_paid) || 0);
  // A held trial's first invoice is £0, as is one paid from credit: no money moved.
  if (gross <= 0) return true;
  const kind = meta.kind === EXTRAS_KIND ? 'extras' : 'plan';
  const label = cardPaymentLabel(meta, invoice);
  const [claim] = await sql`
    INSERT INTO academy_card_payments (stripe_invoice_id, tenant_id, kind, amount_gross, label, claim_id)
    VALUES (${invoice.id}, ${meta.tenantId}, ${kind}, ${gross / 100}, ${label}, ${meta.claimId || null})
    ON CONFLICT (stripe_invoice_id) DO NOTHING
    RETURNING stripe_invoice_id`;
  if (!claim) return true;
  await mirrorCardPayment(invoice.id);
  return true;
}

// Take a payment to mirror it: one mirror at a time, and free again after ten
// minutes if one died half way.
async function takePayment(stripeInvoiceId) {
  const [row] = await sql`
    UPDATE academy_card_payments SET mirror_started_at = NOW()
     WHERE stripe_invoice_id = ${stripeInvoiceId} AND manual_invoice_id IS NULL
       AND (mirror_started_at IS NULL OR mirror_started_at < NOW() - INTERVAL '10 minutes')
     RETURNING *`;
  return row || null;
}

// A card payment, as a paid Xero invoice to the academy's company, with the
// academy's own record of it. A failure is kept on the payment row and tried
// again, by the checkout or the daily job; the money is safe in Stripe either way.
async function mirrorCardPayment(stripeInvoiceId) {
  const row = await takePayment(stripeInvoiceId);
  if (!row) return false;
  const p = {
    stripeInvoiceId, tenantId: row.tenant_id, kind: row.kind, label: row.label || 'Squideo Academy, by card',
    gross: Math.round(Number(row.amount_gross) * 100), claimId: row.claim_id || null,
  };
  try {
    const academy = await getAcademy(p.tenantId);
    if (!academy) throw new Error('The academy is no longer on the platform.');
    const [company] = academy.crmCompanyId
      ? await sql`SELECT id, name FROM companies WHERE id = ${academy.crmCompanyId}`
      : [];
    if (!company) throw new Error('Not linked to a company yet: its checkout links it.');
    const { exPence } = splitGross(p.gross);
    const invoice = await createXeroInvoiceForDeal({
      companyId: company.id,
      lineItems: [{ description: p.label, quantity: 1, unitAmount: exPence / 100, vatRate: VAT_RATE * 100 }],
      reference: `Squideo Academy: ${academy.name} (card)`.slice(0, 250),
      issuedAt: today(),
      dueAt: today(),
    }, {});
    const manualId = String(invoice.id || '').replace(/^manual:/, '');
    // Stripe already has the money, so the invoice is paid the moment it exists.
    await sql`
      UPDATE manual_invoices SET status = 'paid', paid_at = NOW(), payment_method = 'stripe-card', updated_at = NOW()
       WHERE id = ${manualId}`;
    await sql`UPDATE academy_card_payments SET manual_invoice_id = ${manualId}, mirror_error = NULL WHERE stripe_invoice_id = ${p.stripeInvoiceId}`;
    if (p.kind === 'extras' && p.claimId) {
      await sql`UPDATE academy_invoices SET manual_invoice_id = ${manualId}, company_id = ${company.id} WHERE id = ${p.claimId}`;
    } else {
      await sql`
        INSERT INTO academy_invoices (id, tenant_id, company_id, kind, period_key, label, amount_ex_vat, manual_invoice_id, source, created_by)
        VALUES (${makeId('acinv')}, ${p.tenantId}, ${company.id}, ${p.kind}, ${'card:' + p.stripeInvoiceId}, ${p.label},
                ${exPence / 100}, ${manualId}, 'card', 'stripe')
        ON CONFLICT (tenant_id, kind, period_key) DO NOTHING`;
    }
    const clearing = process.env.XERO_STRIPE_CLEARING_CODE;
    if (clearing && invoice.xeroInvoiceId) {
      await createPayment({
        invoiceId: invoice.xeroInvoiceId, accountCode: clearing, amount: Number(invoice.amount),
        date: today(), reference: `Stripe ${p.stripeInvoiceId}`,
      }).catch((err) => console.error('[academy cards] Xero payment not recorded; the invoice stays unpaid in Xero', err?.message || err));
    } else if (!clearing) {
      console.warn('[academy cards] XERO_STRIPE_CLEARING_CODE not set: the card payment stays unpaid in Xero');
    }
    if (invoice.xeroInvoiceId) {
      await emailInvoice(invoice.xeroInvoiceId).catch((err) => console.warn('[academy cards] Xero email failed', err?.message || err));
    }
    return true;
  } catch (err) {
    console.error('[academy cards] card payment not mirrored into Xero', p.stripeInvoiceId, err?.message || err);
    await sql`
      UPDATE academy_card_payments SET mirror_error = ${String(err?.message || err).slice(0, 500)}, mirror_started_at = NULL
       WHERE stripe_invoice_id = ${p.stripeInvoiceId}`.catch(() => {});
    return false;
  }
}

/** invoice.payment_failed: tell whoever looks after academy money, on the first failure only. */
export async function academyCardPaymentFailed(stripe, invoice) {
  const meta = await academyInvoiceMeta(stripe, invoice);
  if (!meta) return false;
  if ((Number(invoice.attempt_count) || 1) > 1) return true;
  const academy = await getAcademy(meta.tenantId).catch(() => null);
  const name = academy?.name || 'An academy';
  const amount = gbpPence(invoice.amount_due);
  await tell('academy.card_payment_failed',
    `Card payment failed: ${name}, ${amount}`,
    `Stripe could not take ${name}'s card payment of ${amount} (${cardPaymentLabel(meta, invoice)}). `
      + 'It tries again automatically, and the academy\'s admins are asked to update their card on their Plan page.');
  return true;
}

/** customer.subscription.created / updated / deleted: keep the platform's card state true. */
export async function syncAcademySubscription(stripe, sub, { deleted = false } = {}) {
  if (sub?.metadata?.kind !== KIND || !sub.metadata.tenantId) return false;
  await ensureAcademyTables();
  const tenantId = sub.metadata.tenantId;
  const row = await subscriptionRow(tenantId);
  // About a subscription this academy has since replaced: nothing to do.
  if (row?.stripe_subscription_id && row.stripe_subscription_id !== sub.id) {
    if (deleted || !cardIsLive({ status: cardStatusFrom(sub) })) return true;
  }

  if (deleted || cardStatusFrom(sub) === 'cancelled') {
    const wasLive = row && cardIsLive({ status: row.status });
    await sql`
      UPDATE academy_subscriptions SET status = 'cancelled', updated_at = NOW()
       WHERE tenant_id = ${tenantId} AND stripe_subscription_id = ${sub.id}`;
    const academy = await getAcademy(tenantId);
    const s = academy?.summary;
    const planNow = s?.trial?.phase && s.trial.phase !== 'none' ? s.afterTrial?.slug : s?.plan?.slug;
    const body = { card: null };
    // Still on the plan the card paid for: back to Free. Already moved onto an
    // invoiced plan by somebody: left there.
    if (planNow && planNow === (row?.plan || sub.metadata.plan)) Object.assign(body, { plan: 'free', billingPeriod: null });
    if (academy) await patchAcademy(tenantId, body);
    if (wasLive) {
      await tell('academy.card_cancelled',
        `Academy card subscription ended: ${academy?.name || tenantId}`,
        `${academy?.name || 'An academy'} has stopped paying by card for ${row?.plan_name || row?.plan || 'its plan'}. `
          + (body.plan ? 'It has moved to the Free plan.' : 'It stays on the plan it has now, which is invoiced.'));
    }
    return true;
  }

  await saveSubscription(tenantId, sub);
  const fresh = await subscriptionRow(tenantId);
  if (fresh?.activated_at) await patchAcademy(tenantId, { card: cardStateFor(sub) });
  return true;
}

// ── The daily job (cron academy-alerts) ─────────────────────────────────────

/**
 * Charge the extra people of a card academy to its card: a one-off Stripe
 * invoice, finalised and paid now. The period is claimed first, exactly as an
 * invoice claims it, so it can never be charged twice or also invoiced.
 */
export async function chargeCardExtras(stripe, academy, card, line) {
  const [claim] = await sql`
    INSERT INTO academy_invoices (id, tenant_id, company_id, kind, period_key, label, amount_ex_vat, source, created_by)
    VALUES (${makeId('acinv')}, ${academy.id}, ${academy.crmCompanyId || null}, 'extras', ${line.periodKey},
            ${line.label}, ${line.amount}, 'card', 'academy-cards')
    ON CONFLICT (tenant_id, kind, period_key) DO NOTHING
    RETURNING id`;
  if (!claim) return false;
  const exPence = Math.round(Number(line.amount) * 100);
  let invoice = null;
  try {
    const sub = await stripe.subscriptions.retrieve(card.subscriptionId);
    const paymentMethod = idOf(sub.default_payment_method);
    invoice = await stripe.invoices.create({
      customer: card.customerId,
      collection_method: 'charge_automatically',
      auto_advance: true,
      pending_invoice_items_behavior: 'exclude',
      currency: 'gbp',
      ...(paymentMethod ? { default_payment_method: paymentMethod } : {}),
      description: line.label,
      metadata: {
        kind: EXTRAS_KIND, tenantId: academy.id, periodKey: line.periodKey, claimId: claim.id,
        label: line.label, exVatPence: String(exPence),
      },
    });
    await stripe.invoiceItems.create({
      customer: card.customerId, invoice: invoice.id, currency: 'gbp',
      amount: grossPence(exPence), description: `${line.label} (inc. VAT)`,
    });
    await stripe.invoices.finalizeInvoice(invoice.id);
  } catch (err) {
    // Nothing was charged: bin the draft and free the period for tomorrow.
    if (invoice?.id) await stripe.invoices.del(invoice.id).catch(() => {});
    await sql`DELETE FROM academy_invoices WHERE id = ${claim.id}`;
    throw err;
  }
  // Finalised, it is charged, and retried by Stripe if the card declines. Paid,
  // it comes back through the webhook and into Xero like any card payment.
  await stripe.invoices.pay(invoice.id)
    .catch((err) => console.warn('[academy cards] extras charge declined; Stripe will retry', err?.message || err));
  return true;
}

/**
 * Everything card-shaped the daily job does, given the academies as the
 * Academies page composes them. Never throws: one academy's problem must not
 * stop the others, or the rest of the job.
 */
export async function runCardJobs(academies) {
  const out = { charged: 0, mirrored: 0, activated: 0 };
  let stripe = null;
  const client = () => { stripe = stripe || stripeClient(); return stripe; };
  try {
    await ensureAcademyTables();

    // Paid checkouts whose academy never got its plan (the platform was down
    // for every retry of the webhook). First, because it links the company
    // the payments below are invoiced to.
    const waiting = await sql`
      SELECT tenant_id, stripe_subscription_id FROM academy_subscriptions
       WHERE activated_at IS NULL AND status IN ('active', 'trialing', 'past_due', 'incomplete', 'cancelling')
         AND updated_at < NOW() - INTERVAL '10 minutes'
       LIMIT 10`;
    for (const w of waiting) {
      try {
        const sub = await client().subscriptions.retrieve(w.stripe_subscription_id);
        if (await activate(w.tenant_id, sub)) out.activated += 1;
      } catch (err) {
        console.warn('[academy cards] could not finish a checkout', w.tenant_id, err?.message || err);
      }
    }

    // Card payments that did not reach Xero. Ten minutes' grace, so a payment
    // still being handled by its webhook is left to it.
    const stuck = await sql`
      SELECT stripe_invoice_id FROM academy_card_payments
       WHERE manual_invoice_id IS NULL AND created_at < NOW() - INTERVAL '10 minutes'
         AND created_at > NOW() - INTERVAL '30 days'
       ORDER BY created_at LIMIT 10`;
    for (const p of stuck) {
      if (await mirrorCardPayment(p.stripe_invoice_id)) out.mirrored += 1;
    }

    // Extra people, onto the card.
    for (const a of academies) {
      if (!a.card?.live || !a.card.customerId || !a.card.subscriptionId) continue;
      for (const line of (a.due || []).filter((l) => l.viaCard)) {
        try {
          if (await chargeCardExtras(client(), a, a.card, line)) out.charged += 1;
        } catch (err) {
          console.warn('[academy cards] could not charge extras', a.subdomain, err?.message || err);
        }
      }
    }
  } catch (err) {
    console.warn('[academy cards] daily card jobs failed', err?.message || err);
  }
  return out;
}
