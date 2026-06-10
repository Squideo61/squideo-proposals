// /api/push — Web Push subscription management for desktop notifications.
//
//   GET  ?action=public-key            → { key }  (the VAPID public key; public)
//   POST ?action=subscribe   { subscription } → store this browser's subscription
//   POST ?action=unsubscribe { endpoint }     → forget it
//
// public-key is unauthenticated (it's safe to expose and the client needs it
// before it can subscribe). subscribe/unsubscribe are scoped to the signed-in
// user so a subscription is always tied to the right person.
import { cors, requireAuth } from './_lib/middleware.js';
import { saveSubscription, removeSubscription, vapidPublicKey, pushConfigured } from './_lib/push.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action;

  try {
    if (req.method === 'GET' && action === 'public-key') {
      // Returns null when push isn't provisioned — the client treats that as
      // "Tier 2 unavailable" and falls back to in-tab notifications only.
      return res.status(200).json({ key: pushConfigured() ? vapidPublicKey() : null });
    }

    const payload = await requireAuth(req, res);
    if (!payload) return;
    const email = (payload.email || '').toLowerCase();

    if (req.method === 'POST' && action === 'subscribe') {
      const { subscription } = req.body || {};
      await saveSubscription(email, subscription);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'unsubscribe') {
      const { endpoint } = req.body || {};
      await removeSubscription(endpoint);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[push] handler error', err);
    if (!res.headersSent) return res.status(500).json({ error: 'Server error' });
  }
}
