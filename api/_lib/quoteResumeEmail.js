const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

export function buildResumeEmail({ kind, name, resumeUrl, unsubscribeUrl }) {
  const intro = {
    initial: name
      ? `Hi ${escapeHtml(name)}, thanks for starting your quote request! Click the link below any time to pick up where you left off.`
      : `Thanks for starting your quote request! Click the link below any time to pick up where you left off.`,
    reminder_1: name
      ? `Hi ${escapeHtml(name)}, just a quick reminder — your quote request is still saved. Click below to finish it off.`
      : `Just a quick reminder — your quote request is still saved. Click below to finish it off.`,
    reminder_2: name
      ? `Hi ${escapeHtml(name)}, your saved quote request is waiting. We'd love to help — finish it off whenever you have a moment.`
      : `Your saved quote request is waiting. We'd love to help — finish it off whenever you have a moment.`,
    reminder_3: name
      ? `Hi ${escapeHtml(name)}, this is our last reminder. Your saved quote request is still here if you'd like to come back to it.`
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
