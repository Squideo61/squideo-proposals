// One-off OAuth bootstrap for the Xero Web App integration. Visit
// /api/xero/connect once (logged in as Adam in your browser is fine — Xero
// will gate access via its own login), consent in Xero, and the callback
// stores the refresh token + tenant ID in the xero_tokens table. From then
// on, api/_lib/xero.js uses the refresh-token flow automatically.

import sql from '../_lib/db.js';
import { cors } from '../_lib/middleware.js';

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'accounting.contacts',
  'accounting.transactions',
].join(' ');

function redirectUri() {
  return process.env.XERO_REDIRECT_URI
    || (process.env.APP_URL || 'https://squideo-proposals-tu96.vercel.app') + '/api/xero/callback';
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // --- /api/xero/connect ---
  // Kicks off the OAuth flow. We rely on Xero's own login to gate access —
  // only someone who can authenticate to the Squideo Xero org can finish
  // the consent step.
  if (action === 'connect') {
    if (!process.env.XERO_CLIENT_ID) {
      return res.status(500).send('XERO_CLIENT_ID not set');
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.XERO_CLIENT_ID,
      redirect_uri: redirectUri(),
      scope: SCOPES,
      state: 'bootstrap',
    });
    res.writeHead(302, { Location: `${AUTHORIZE_URL}?${params.toString()}` });
    return res.end();
  }

  // --- /api/xero/callback ---
  if (action === 'callback') {
    const { code, error } = req.query;
    if (error) return res.status(400).send(`Xero error: ${error}`);
    if (!code) return res.status(400).send('Missing code');

    try {
      const basic = Buffer
        .from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`)
        .toString('base64');

      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(),
        }).toString(),
      });
      if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => '');
        return res.status(502).send(`Token exchange failed: ${tokenRes.status} ${text}`);
      }
      const tokens = await tokenRes.json();

      // Look up which tenants this access token can see, pick the first.
      // For Custom-Connection-style single-org integrations there's only
      // ever one — if you've consented multiple orgs, the picker UI in Xero
      // already restricted to one.
      const connRes = await fetch(CONNECTIONS_URL, {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Accept': 'application/json',
        },
      });
      if (!connRes.ok) {
        const text = await connRes.text().catch(() => '');
        return res.status(502).send(`Connections fetch failed: ${connRes.status} ${text}`);
      }
      const connections = await connRes.json();
      if (!Array.isArray(connections) || !connections.length) {
        return res.status(502).send('No Xero tenants returned for this connection.');
      }
      const tenantId = connections[0].tenantId;
      const tenantName = connections[0].tenantName || '(unknown)';

      await sql`
        INSERT INTO xero_tokens (id, refresh_token, tenant_id, updated_at)
        VALUES ('singleton', ${tokens.refresh_token}, ${tenantId}, NOW())
        ON CONFLICT (id) DO UPDATE
          SET refresh_token = EXCLUDED.refresh_token,
              tenant_id = EXCLUDED.tenant_id,
              updated_at = NOW()
      `;

      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(`
        <html><body style="font-family:system-ui;padding:40px;max-width:600px;margin:0 auto;">
          <h1>Xero connected ✓</h1>
          <p>Connected to <strong>${tenantName}</strong>.</p>
          <p>Tenant ID: <code>${tenantId}</code></p>
          <p>You can close this tab. The integration is now active.</p>
        </body></html>
      `);
    } catch (err) {
      console.error('[xero callback] failed', err);
      return res.status(500).send('Callback failed: ' + err.message);
    }
  }

  return res.status(404).send('Not found');
}
