import { verifyToken } from './auth.js';

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
  try {
    return await verifyToken(token);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
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
