/**
 * Send the visitor back to the site they came from, not always to squideo.com.
 *
 * The quote and contact forms redirect to a hardcoded
 * `https://www.squideo.com/qr-thank-you` after submitting. That is correct in
 * production and wrong everywhere else: submitting the form from the new
 * marketing site on its staging domain landed the tester on DUDA's thank-you
 * page, on the old site, which is a confusing way to find out your test worked.
 *
 * It also made the loop untestable before cutover. Go/no-go criterion 9 is a
 * real lead submitted end to end — attribution captured, conversion fired, row
 * in the CRM — and half of that happens on the thank-you page.
 *
 * So: keep the PATH from the configured URL, and take the ORIGIN from whoever
 * embedded us, if and only if it is on the allowlist below.
 *
 * ⚠ THE ALLOWLIST IS THE SECURITY BOUNDARY. This turns a referrer — which is
 * attacker-controllable — into a redirect target, which is the shape of an
 * open-redirect bug. Matching against exact origins, never a suffix or a
 * pattern: "https://www.squideo.com.evil.test" must not pass, and a
 * `endsWith('squideo.com')` check would let it.
 *
 * Anything not on the list falls through to the configured URL unchanged, so
 * production behaviour is identical to before.
 */

const ALLOWED_ORIGINS = [
  "https://www.squideo.com",
  "https://squideo.com",
  "https://www.squideo.co.uk",
  "https://squideo.co.uk",
  // The new marketing site's staging domain, so the forms can be exercised
  // before the DNS switch rather than for the first time on cutover morning.
  "https://squideo-web.vercel.app",
];

export function resolveRedirect(configuredUrl) {
  if (!configuredUrl) return configuredUrl;

  try {
    // document.referrer is the embedding page when we are in an iframe. Empty
    // when the form is opened directly, which is the fall-through case.
    if (!document.referrer) return configuredUrl;

    const parent = new URL(document.referrer).origin;
    if (!ALLOWED_ORIGINS.includes(parent)) return configuredUrl;

    const target = new URL(configuredUrl);
    return parent + target.pathname + target.search;
  } catch {
    // A malformed referrer or URL is not worth failing a submission over.
    return configuredUrl;
  }
}
