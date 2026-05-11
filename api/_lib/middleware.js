import { verifyToken } from './auth.js';
import { lookupExtensionToken } from './extension.js';

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export async function requireAuth(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Unauthorised' });
    return null;
  }
  // 1. Try as a session JWT (the normal web-app path).
  try {
    return await verifyToken(token);
  } catch { /* fall through */ }
  // 2. Fall back to a stored extension token. Adds one DB query but only for
  //    callers that don't have a valid JWT; web-app traffic still short-circuits
  //    on the JWT verify above.
  try {
    const ext = await lookupExtensionToken(token);
    if (ext) return ext;
  } catch (err) {
    console.warn('[requireAuth] extension token lookup failed', err.message);
  }
  res.status(401).json({ error: 'Invalid token' });
  return null;
}

export async function requireAdmin(req, res) {
  const payload = await requireAuth(req, res);
  if (!payload) return null;
  if (payload.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }
  return payload;
}
