// Is this actually an email address, and if not, can it be salvaged?
//
// Pure and DB-free so it can be tested against the real junk.
//
// This exists because of a specific failure. The old website's notification
// emails were parsed to recover years of enquiries, and where the message body
// arrived without line breaks the labels ran into the values:
//
//     …Email: olmazatheartist11@gmail.com Phone: 77758…
//              ↓ collapsed
//     absemailolmazatheartist11@gmail.comphone
//
// which a naive address regex matches happily — "comphone" is a perfectly legal
// top-level-domain shape. Every one of those is a guaranteed bounce, and
// bounces are the number a mailing domain is judged on, so they must not reach
// a send.

// The labels that surround an address in those templates. A word from this list
// welded to a domain or a local part is the signature of the bug, and is what
// makes a confident repair possible.
const LABEL_WORDS = [
  'phone', 'telephone', 'mobile', 'tel',
  'email', 'e-mail', 'mail',
  'name', 'company', 'organisation', 'organization',
  'optin', 'opt-in', 'opt', 'subscribe', 'marketing',
  'description', 'project', 'details', 'message',
  'timeline', 'timescale', 'deadline', 'budget',
  'submitted', 'form', 'session', 'video', 'length',
  'uploaded', 'files', 'attachments', 'additional', 'info', 'contact',
];

// Every real top-level domain is letters only and short. 24 is generous — the
// longest in use is 24 characters — and it is the check that catches
// "comphone", "co.ukphone" and the rest.
const STRICT = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;

// The common ones, used to spot a TLD that has had a word stuck on the end.
// Not a complete list and doesn't need to be: anything not here is only
// rejected if it ALSO ends in one of the label words above.
const KNOWN_TLDS = [
  'com', 'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net', 'org', 'io', 'co',
  'uk', 'eu', 'de', 'fr', 'es', 'it', 'nl', 'ie', 'us', 'ca', 'au', 'nz', 'info',
  'biz', 'tv', 'me', 'app', 'dev', 'agency', 'studio', 'media', 'digital', 'design',
  'email', 'group', 'online', 'site', 'shop', 'store', 'tech', 'ai', 'gov.uk', 'ac.uk', 'nhs.uk',
];

export function isValidEmail(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s || s.length > 254) return false;
  if (!STRICT.test(s)) return false;
  const [local, domain] = s.split('@');
  if (local.length > 64) return false;
  if (s.includes('..')) return false;
  // A domain whose last label ends with one of the surrounding words is the
  // collapsed-template artefact, not a real address.
  const tld = domain.split('.').pop();
  if (LABEL_WORDS.some((w) => tld !== w && tld.endsWith(w))) return false;
  return true;
}

// Try to recover the real address from a mangled one. Returns the repaired
// address, or null when there is no confident answer.
//
// Conservative on purpose. A wrong repair sends a stranger someone else's
// marketing; leaving it unrepaired only means one address stays off the list
// until a human looks. So every candidate must come out of isValidEmail, and
// anything ambiguous returns null.
export function repairEmail(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^mailto:/, '');
  if (!raw.includes('@')) return null;
  if (isValidEmail(raw)) return raw;

  const at = raw.indexOf('@');
  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);

  // 1. A label word welded to the end of the domain: "gmail.comphone".
  //    Cut at the longest known TLD the domain actually starts with.
  for (const tld of [...KNOWN_TLDS].sort((a, b) => b.length - a.length)) {
    const marker = '.' + tld;
    const idx = domain.indexOf(marker);
    if (idx === -1) continue;
    const trailing = domain.slice(idx + marker.length);
    // Only cut when what follows is one of the surrounding words — otherwise
    // "mail.company.com" would lose its ending.
    if (trailing && LABEL_WORDS.some((w) => trailing === w || trailing.startsWith(w))) {
      domain = domain.slice(0, idx + marker.length);
      break;
    }
  }

  // 2. A label word welded to the FRONT of the local part:
  //    "absemailolmazatheartist11" → "olmazatheartist11".
  //    Only from a word that ends the label ("email"/"mail"), and only when
  //    what's left is long enough to be a real local part.
  for (const w of ['email', 'e-mail', 'mail']) {
    const idx = local.lastIndexOf(w);
    if (idx === -1) continue;
    const rest = local.slice(idx + w.length);
    if (rest.length >= 3) { local = rest; break; }
  }

  const rebuilt = `${local}@${domain}`;
  return isValidEmail(rebuilt) ? rebuilt : null;
}

// What to do with an address found in stored data: keep it, replace it, or take
// it off the list. `reason` is for the report — a sweep that fixes things
// silently is one nobody can check.
export function assessEmail(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return { verdict: 'invalid', reason: 'No address' };
  if (isValidEmail(raw)) return { verdict: 'ok', email: raw };
  const fixed = repairEmail(raw);
  if (fixed && fixed !== raw) {
    return { verdict: 'repaired', email: fixed, reason: `${raw} → ${fixed}` };
  }
  return { verdict: 'invalid', reason: `${raw} is not a usable address` };
}
