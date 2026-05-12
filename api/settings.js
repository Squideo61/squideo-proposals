import sql from './_lib/db.js';
import { cors, requireAuth } from './_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const rows = await sql`SELECT extras_bank, inclusions_bank, notification_recipients FROM settings WHERE id = 1`;
    const row = rows[0];
    return res.status(200).json({
      extrasBank: row.extras_bank,
      inclusionsBank: row.inclusions_bank,
      notificationRecipients: row.notification_recipients,
    });
  }

  if (req.method === 'PUT') {
    // Global settings — admin only. A compromised member account shouldn't
    // be able to redirect signed/paid notifications or pollute every new
    // proposal's defaults.
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { extrasBank, inclusionsBank, notificationRecipients } = req.body || {};
    await sql`
      UPDATE settings SET
        extras_bank             = COALESCE(${extrasBank ? JSON.stringify(extrasBank) : null}::jsonb, extras_bank),
        inclusions_bank         = COALESCE(${inclusionsBank ? JSON.stringify(inclusionsBank) : null}::jsonb, inclusions_bank),
        notification_recipients = COALESCE(${notificationRecipients ? JSON.stringify(notificationRecipients) : null}::jsonb, notification_recipients)
      WHERE id = 1
    `;
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
}
