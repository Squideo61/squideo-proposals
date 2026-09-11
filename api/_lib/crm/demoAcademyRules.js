// Demo academies, the pure part: how they group, how a visit reads, what a
// "demo opened" alert says. No database, no network — ./demoAcademies.js does
// the reading and writing.
//
// A demo academy is a Squideo Academy built for one prospect to try (Juno
// Genetics, Gower Chemicals…). Not to be confused with the "[DEMO] Test Client"
// project (./demoScope.js), which is a different thing that shares the word.

export const DEMO_TYPES = ['induction', 'consent', 'training'];

export const DEMO_TYPE_LABELS = {
  induction: 'Inductions',
  consent: 'Consent',
  training: 'Training & e-learning',
};

const ROLE_LABELS = { learner: 'Learner', manager: 'Manager', admin: 'Admin', owner: 'Admin', instructor: 'Instructor' };

export const roleLabel = (role) => ROLE_LABELS[role] || 'Login';

const time = (iso) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * Demos in their groups, in a fixed order (inductions, consent, training, then
 * any without a type), each group's demos most recently opened first. Empty
 * groups are left out, unless `keepEmpty`.
 */
export function groupDemos(demos, { keepEmpty = false } = {}) {
  const order = [...DEMO_TYPES, null];
  return order
    .map((type) => ({
      type,
      label: type ? DEMO_TYPE_LABELS[type] : 'No type yet',
      demos: (demos || [])
        .filter((d) => (DEMO_TYPES.includes(d?.demoType) ? d.demoType : null) === type)
        .sort((a, b) => (time(b.lastVisit?.start) ?? -1) - (time(a.lastVisit?.start) ?? -1)
          || String(a.name).localeCompare(String(b.name))),
    }))
    .filter((g) => keepEmpty || g.demos.length);
}

/** "just now", "12 minutes ago", "3 hours ago", "yesterday", "5 days ago", "12 Aug". */
export function ago(iso, now = new Date()) {
  const t = time(iso);
  if (t === null) return null;
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });
}

/** The line under a demo's name: when it was last opened, as whom, on what. */
export function lastSeenText(demo, now = new Date()) {
  const v = demo?.lastVisit;
  if (!v) return 'Not opened yet';
  const who = v.logins?.length ? ` as ${v.logins[0]}` : '';
  return `Opened ${ago(v.start, now)}${who}, on ${v.device || 'an unknown device'}`;
}

/** The logins of a demo, ready to paste into an email to the prospect. */
export function loginsText(demo) {
  const lines = [demo?.name ? `${demo.name} demo` : 'Demo', demo?.url || ''];
  lines.push('');
  for (const l of demo?.logins || []) lines.push(`${roleLabel(l.role)}: ${l.email}`);
  if (demo?.password) lines.push(`Password (all logins): ${demo.password}`);
  return lines.join('\n').trim();
}

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * The academy platform's "demo opened" event, cleaned — or null when it is not
 * one. It arrives over the shared secret, so it is trusted to be from the
 * platform, but not trusted to be well-formed.
 */
export function cleanDemoOpened(body) {
  const b = body && typeof body === 'object' ? body : {};
  const tenantId = str(b.tenantId, 64);
  const academyName = str(b.academyName, 200);
  if (!tenantId || !academyName) return null;
  return {
    tenantId,
    academyName,
    subdomain: str(b.subdomain, 100),
    demoType: DEMO_TYPES.includes(b.demoType) ? b.demoType : null,
    login: str(b.login, 200),
    role: str(b.role, 40),
    device: str(b.device, 100) || 'an unknown device',
    at: time(b.at) !== null ? new Date(b.at).toISOString() : new Date().toISOString(),
    crmDealId: str(b.crmDealId, 64),
    url: str(b.url, 300),
    cmsUrl: str(b.cmsUrl, 300),
  };
}

/** What the "demo opened" alert says. `deal` is the linked deal, if any. */
export function demoOpenedMessage(event, deal = null) {
  const as = event.login ? ` as ${event.login}` : '';
  const subject = `${event.academyName} has opened their demo`;
  const body = `Signed in${as}, on ${event.device}.`
    + (deal?.title ? ` Deal: ${deal.title}.` : '');
  return { subject, body };
}
