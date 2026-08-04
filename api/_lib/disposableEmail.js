// Throwaway-inbox domains, rejected at self-serve signup.
//
// Deliberately a small hand-kept list, not a 100k-entry package: the goal is to
// stop the lazy 90% (someone grabbing the course without giving a real address),
// not to win an arms race. Anyone determined enough to find a domain we've
// missed was never going to be a lead anyway.
//
// NOT to be confused with FREEMAIL_DOMAINS in api/_lib/portal/onboarding.js —
// gmail/outlook addresses are perfectly real people and are always accepted.
// They only affect lead SCORING, never admission.

const DISPOSABLE = new Set([
  '10minutemail.com', '10minutemail.net', '20minutemail.com', '33mail.com',
  'anonaddy.com', 'anonbox.net', 'burnermail.io', 'dispostable.com',
  'discard.email', 'dropmail.me', 'einrot.com', 'emailondeck.com',
  'fakeinbox.com', 'fakemail.net', 'getairmail.com', 'getnada.com',
  'grr.la', 'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de',
  'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org',
  'guerrillamailblock.com', 'harakirimail.com', 'inboxbear.com',
  'inboxkitten.com', 'jetable.org', 'mail-temporaire.fr', 'mail7.io',
  'mailcatch.com', 'maildrop.cc', 'mailasdfasdf.com', 'mailinator.com',
  'mailinator.net', 'mailnesia.com', 'mailsac.com', 'mailtemp.info',
  'mintemail.com', 'moakt.com', 'mohmal.com', 'mvrht.net', 'mytemp.email',
  'nowmymail.com', 'onetimemail.org', 'pokemail.net', 'sharklasers.com',
  'spam4.me', 'spambog.com', 'spamgourmet.com', 'temp-mail.io',
  'temp-mail.org', 'tempail.com', 'tempinbox.com', 'tempmail.dev',
  'tempmail.plus', 'tempmailo.com', 'tempr.email', 'throwawaymail.com',
  'trashmail.com', 'trashmail.de', 'trashmail.me', 'trbvm.com',
  'wegwerfemail.de', 'yopmail.com', 'yopmail.fr', 'yopmail.net',
  'zetmail.com',
]);

// Some providers hand out endless rotating subdomains (foo.mailinator.com), so
// match the registrable suffix too rather than only the exact host.
export function isDisposableEmail(email) {
  const at = String(email || '').lastIndexOf('@');
  if (at < 0) return false;
  const domain = String(email).slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  if (DISPOSABLE.has(domain)) return true;
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (DISPOSABLE.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}
