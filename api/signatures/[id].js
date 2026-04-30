import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';
import { sendMail, signedHtml, APP_URL } from '../_lib/email.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  if (req.method === 'DELETE') {
    const user = await requireAuth(req, res);
    if (!user) return;
    await sql`DELETE FROM signatures WHERE proposal_id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'GET') {
    const rows = await sql`SELECT name, email, signed_at, data FROM signatures WHERE proposal_id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];
    return res.status(200).json({ name: row.name, email: row.email, signedAt: row.signed_at, ...row.data });
  }

  if (req.method === 'POST') {
    // Reject replay/overwrite: once signed, the only way to re-sign is for the
    // team to clear the signature via the auth-required DELETE above (the
    // dashboard's "Unmark as accepted" action).
    const existing = await sql`SELECT 1 FROM signatures WHERE proposal_id = ${id} LIMIT 1`;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'This proposal has already been signed.' });
    }

    const { name, email, signedAt, ...rest } = req.body;
    await sql`
      INSERT INTO signatures (proposal_id, name, email, signed_at, data)
      VALUES (${id}, ${name}, ${email}, ${signedAt}, ${JSON.stringify(rest)})
    `;

    try {
      const [users, proposals] = await Promise.all([
        sql`SELECT email FROM users`,
        sql`SELECT data FROM proposals WHERE id = ${id}`,
      ]);
      const proposal = proposals[0]?.data || {};
      const recipients = users.map(u => u.email).filter(Boolean);
      if (recipients.length) {
        const title = proposal.proposalTitle || proposal.clientName || id;
        const link = `${APP_URL}/?proposal=${id}`;
        await sendMail({
          to: recipients,
          subject: `🎉 Signed: ${title}`,
          html: signedHtml({ proposal, signerName: name, signerEmail: email, signedAt, link }),
          text: `${name || 'Someone'} (${email || ''}) signed "${title}" on ${signedAt}. ${link}`,
        });
      }
    } catch (err) {
      console.error('[signatures] broadcast email failed', err);
    }

    return res.status(201).json({ ok: true });
  }

  res.status(405).end();
}
