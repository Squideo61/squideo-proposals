import crypto from 'crypto';
import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';

const ISSUER = 'Squideo CRM';

export function generateTotpSecret() {
  return new Secret({ size: 20 }).base32;
}

function totpFor(secretBase32) {
  return new TOTP({
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function verifyTotp(secretBase32, code) {
  if (!secretBase32 || !code) return false;
  const cleaned = String(code).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const delta = totpFor(secretBase32).validate({ token: cleaned, window: 1 });
  return delta !== null;
}

export function generateOtpauthUrl({ email, secret }) {
  const t = new TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
  return t.toString();
}

export async function generateQrDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl, { width: 256, margin: 1 });
}

export function generateEmailOtp() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
}

export function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

export function generateBackupCodes(count = 10) {
  const codes = [];
  const hashes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    const formatted = raw.slice(0, 4) + '-' + raw.slice(4, 8);
    codes.push(formatted);
    hashes.push(hashBackupCode(formatted));
  }
  return { codes, hashes };
}

export function hashBackupCode(code) {
  // Peppered SHA-256. The pepper lives in JWT_SECRET (server-only), making a
  // DB-only leak insufficient to brute-force the 4-byte code space. Existing
  // hashes from before the pepper landed will fail to match — those users
  // need to regenerate their backup codes via the 2fa-regenerate-backup route.
  const normalised = String(code).replace(/[\s-]/g, '').toUpperCase();
  const pepper = process.env.JWT_SECRET || '';
  return crypto.createHash('sha256').update(normalised + ':' + pepper).digest('hex');
}

export function consumeBackupCode(existingHashes, code) {
  const target = hashBackupCode(code);
  const idx = (existingHashes || []).indexOf(target);
  if (idx === -1) return { ok: false, remaining: existingHashes || [] };
  const remaining = existingHashes.slice(0, idx).concat(existingHashes.slice(idx + 1));
  return { ok: true, remaining };
}

export function createTrustedDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashTrustedDeviceToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

export function parseCookie(header, name) {
  if (!header) return null;
  const parts = header.split(';');
  for (const p of parts) {
    const [k, ...rest] = p.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function trustedDeviceCookieHeader(rawToken) {
  const maxAge = 60 * 60 * 24 * 30;
  return `sq_td=${encodeURIComponent(rawToken)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearTrustedDeviceCookieHeader() {
  return 'sq_td=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}
