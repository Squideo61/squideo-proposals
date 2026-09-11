// The academy platform (squideo-lms), as the CRM reaches it.
//
// Server to server over the platform's private CRM surface (api/crm/* there):
// it works out plans, trials, usage and statements; the CRM owns the money and
// the client relationship. Two env vars connect them: LMS_API_URL (the
// platform's staff address, e.g. https://staff.learn.squideo.com) and
// LMS_API_SECRET (the same value the platform holds as CRM_API_SECRET).
//
// Every call has a timeout, and every failure becomes an Error with a status
// and a sentence a person can act on, so a page that shows academies can say
// "the academy platform didn't answer" instead of failing whole.

const TIMEOUT_MS = 8000;

export function lmsConfigured() {
  return Boolean(process.env.LMS_API_URL && process.env.LMS_API_SECRET);
}

async function lmsFetch(path, { method = 'GET', body } = {}) {
  const base = String(process.env.LMS_API_URL || '').replace(/\/+$/, '');
  const secret = process.env.LMS_API_SECRET;
  if (!base || !secret) {
    const e = new Error('The academy platform is not connected yet: LMS_API_URL and LMS_API_SECRET need setting.');
    e.status = 503;
    throw e;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}/api/crm/${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    const e = new Error(err?.name === 'AbortError'
      ? 'The academy platform took too long to answer. Try again in a moment.'
      : 'The academy platform could not be reached. Try again in a moment.');
    e.status = 502;
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data?.error || `The academy platform answered with an error (${res.status}).`);
    e.status = res.status >= 500 ? 502 : res.status;
    throw e;
  }
  return data;
}

/** Every academy, with its plan summary. */
export async function listAcademies() {
  return (await lmsFetch('academies')).academies || [];
}

export async function getAcademy(id) {
  return (await lmsFetch(`academies/${encodeURIComponent(id)}`)).academy || null;
}

/** Link an academy to a CRM company, or unlink it with null. */
export async function linkAcademy(id, companyId) {
  return (await lmsFetch(`academies/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: { crmCompanyId: companyId || null },
  })).academy || null;
}

/**
 * Put an academy on a plan, as a signed order does: the platform applies its
 * own rules (a trial runs on with the plan to follow, a paid plan starts now).
 */
export async function setAcademyPlan(id, plan, billingPeriod) {
  return (await lmsFetch(`academies/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: { plan, billingPeriod: billingPeriod === 'annual' ? 'annual' : 'monthly' },
  })).academy || null;
}

/** The paid plans on the price list, in pence, for the proposal builder. */
export async function listPlans() {
  return (await lmsFetch('plans')).plans || [];
}
