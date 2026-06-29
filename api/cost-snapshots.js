// /api/cost-snapshots — list persisted monthly CRM-cost snapshots for the Admin
// "Storage & CRM costs" tab's month stepper. GET (finance.manage).
import { cors, requirePermission } from './_lib/middleware.js';
import { listCostSnapshots } from './_lib/crm/costSnapshot.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const auth = await requirePermission(req, res, 'finance.manage');
  if (!auth) return;

  try {
    const snapshots = await listCostSnapshots();
    return res.status(200).json({ snapshots });
  } catch (err) {
    console.error('[cost-snapshots]', err);
    return res.status(500).json({ error: err?.message || 'Could not load cost snapshots' });
  }
}
