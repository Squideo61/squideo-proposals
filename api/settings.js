import sql from './_lib/db.js';
import { cors, requireAuth } from './_lib/middleware.js';
import { getRole } from './_lib/userRoles.js';
import { hasPermission } from './_lib/permissions.js';

// Monthly targets for the Business → Performance graphs. Used when the settings
// row has no targets yet. `finance_targets` = Income performance (cash received);
// `sales_targets` = Sales performance (deals signed). Seeded from the owner's
// "Live Sales Sheet" monthly totals; fully editable in-app.
const DEFAULT_FINANCE_TARGETS = [
  { key: 'minimum', label: 'Minimum', amount: 27806.92, color: '#F59E0B' },
  { key: 't4k', label: '4k', amount: 30606.92, color: '#94A3B8' },
  { key: 'dream', label: 'Dream 5k', amount: 33406.92, color: '#EAB308' },
];

// Self-heal for db/migrations/20260603_finance_targets.sql + _sales_targets.sql
// so the columns exist before any read/write below. Module-cached — runs once
// per cold start.
let financeTargetsColumnEnsured = null;
function ensureFinanceTargetsColumn() {
  if (financeTargetsColumnEnsured) return financeTargetsColumnEnsured;
  financeTargetsColumnEnsured = (async () => {
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS finance_targets JSONB`;
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS sales_targets JSONB`;
  })().catch((err) => { financeTargetsColumnEnsured = null; throw err; });
  return financeTargetsColumnEnsured;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  await ensureFinanceTargetsColumn();

  if (req.method === 'GET') {
    const rows = await sql`SELECT extras_bank, inclusions_bank, notification_recipients, revision_call_url, finance_targets, sales_targets FROM settings WHERE id = 1`;
    const row = rows[0];
    return res.status(200).json({
      extrasBank: row.extras_bank,
      inclusionsBank: row.inclusions_bank,
      notificationRecipients: row.notification_recipients,
      revisionCallUrl: row.revision_call_url || '',
      financeTargets: Array.isArray(row.finance_targets) && row.finance_targets.length
        ? row.finance_targets
        : DEFAULT_FINANCE_TARGETS,
      salesTargets: Array.isArray(row.sales_targets) && row.sales_targets.length
        ? row.sales_targets
        : DEFAULT_FINANCE_TARGETS,
    });
  }

  if (req.method === 'PUT') {
    // Global settings — restricted. A compromised member account shouldn't
    // be able to redirect signed/paid notifications or pollute every new
    // proposal's defaults.
    if (!hasPermission(await getRole(user.role), 'settings.manage')) {
      return res.status(403).json({ error: 'You do not have permission to edit workspace settings' });
    }
    const { extrasBank, inclusionsBank, notificationRecipients, revisionCallUrl, financeTargets, salesTargets } = req.body || {};
    await sql`
      UPDATE settings SET
        extras_bank             = COALESCE(${extrasBank ? JSON.stringify(extrasBank) : null}::jsonb, extras_bank),
        inclusions_bank         = COALESCE(${inclusionsBank ? JSON.stringify(inclusionsBank) : null}::jsonb, inclusions_bank),
        notification_recipients = COALESCE(${notificationRecipients ? JSON.stringify(notificationRecipients) : null}::jsonb, notification_recipients),
        revision_call_url       = COALESCE(${revisionCallUrl !== undefined ? String(revisionCallUrl) : null}, revision_call_url),
        finance_targets         = COALESCE(${financeTargets ? JSON.stringify(financeTargets) : null}::jsonb, finance_targets),
        sales_targets           = COALESCE(${salesTargets ? JSON.stringify(salesTargets) : null}::jsonb, sales_targets)
      WHERE id = 1
    `;
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
}
