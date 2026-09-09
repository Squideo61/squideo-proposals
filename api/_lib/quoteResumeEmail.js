const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

/**
 * Where "finish your quote" goes back to.
 *
 * BOTH HALVES ARE SENDER-SUPPLIED, and this is a link in an email we send to an
 * address the same anonymous caller chose — so an unchecked origin here is a way
 * to make Squideo email a stranger a link to any domain at all. The form knows
 * where it is living (the CRM's own /quote in an iframe, or /get-quote on the
 * marketing site, which runs it natively) and we don't, hence sender-supplied;
 * the allowlist is what makes that safe.
 *
 * Exact origins, never a suffix match: "https://squideo.com.evil.test" must not
 * pass, and `endsWith('squideo.com')` would let it through. The path is checked
 * as a path — one leading slash, no scheme, and no protocol-relative "//host",
 * which a browser reads as a different origin entirely.
 */
export function buildResumeUrl({ origin, path, formSessionId, allowedOrigins, fallbackOrigin }) {
  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  const claimed = clean(origin).replace(/\/$/, '');
  const safeOrigin = allowedOrigins.includes(claimed) ? claimed : fallbackOrigin.replace(/\/$/, '');

  const claimedPath = clean(path);
  const safePath = /^\/[A-Za-z0-9\-._~/]{0,100}$/.test(claimedPath) && !claimedPath.startsWith('//')
    ? claimedPath.replace(/\/$/, '')
    : '/quote';

  return `${safeOrigin}${safePath}?resume=${encodeURIComponent(formSessionId)}`;
}

export function buildResumeEmail({ kind, name, resumeUrl, unsubscribeUrl }) {
  const firstName = (name || '').trim().split(/\s+/)[0] || '';
  const intro = {
    initial: firstName
      ? `Hi ${escapeHtml(firstName)}, thanks for starting your quote request! Click the link below any time to pick up where you left off.`
      : `Thanks for starting your quote request! Click the link below any time to pick up where you left off.`,
    reminder_1: firstName
      ? `Hi ${escapeHtml(firstName)}, just a quick reminder — your quote request is still saved. Click below to finish it off.`
      : `Just a quick reminder — your quote request is still saved. Click below to finish it off.`,
    reminder_2: firstName
      ? `Hi ${escapeHtml(firstName)}, your saved quote request is waiting. We'd love to help — finish it off whenever you have a moment.`
      : `Your saved quote request is waiting. We'd love to help — finish it off whenever you have a moment.`,
    reminder_3: firstName
      ? `Hi ${escapeHtml(firstName)}, this is our last reminder. Your saved quote request is still here if you'd like to come back to it.`
      : `This is our last reminder. Your saved quote request is still here if you'd like to come back to it.`,
  }[kind] || '';

  const subject = {
    initial: 'Your Squideo quote — pick up where you left off',
    reminder_1: 'Reminder: your saved quote request',
    reminder_2: 'Still here when you\'re ready — your saved quote',
    reminder_3: 'Last reminder: your saved quote request',
  }[kind] || 'Your Squideo quote';

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0F2A3D;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFBFC;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E9EE;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:32px 28px 24px;font-size:15px;line-height:1.6;">
          <div style="font-size:20px;font-weight:700;margin-bottom:14px;">Your Squideo quote — saved for you</div>
          <p style="margin:0 0 22px;">${intro}</p>
          <p style="margin:0 0 24px;text-align:center;">
            <a href="${escapeHtml(resumeUrl)}" style="display:inline-block;background:#7ac943;color:#fff;text-decoration:none;font-weight:600;padding:14px 28px;border-radius:8px;font-size:15px;">Finish my quote request →</a>
          </p>
          <p style="margin:0;color:#6B7785;font-size:13px;">If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all;">${escapeHtml(resumeUrl)}</span></p>
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #E5E9EE;font-size:12px;color:#6B7785;line-height:1.5;">
          You're receiving this because you asked us to email you a link to your saved quote request. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6B7785;">Unsubscribe from reminders</a>.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html };
}
