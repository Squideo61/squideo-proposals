import bcrypt from 'bcryptjs';
import sql from '../_lib/db.js';
import {
  signToken,
  signChallengeToken,
  verifyChallengeToken,
  signEnrolmentToken,
  verifyEnrolmentToken,
} from '../_lib/auth.js';
import {
  cors,
  requireAuth,
  appendSetCookie,
  sessionCookieHeader,
  clearSessionCookieHeader,
} from '../_lib/middleware.js';
import { sendMail, twoFactorCodeHtml } from '../_lib/email.js';
import {
  generateTotpSecret,
  verifyTotp,
  generateOtpauthUrl,
  generateQrDataUrl,
  generateEmailOtp,
  hashOtp,
  generateBackupCodes,
  consumeBackupCode,
  createTrustedDeviceToken,
  hashTrustedDeviceToken,
  parseCookie,
  trustedDeviceCookieHeader,
} from '../_lib/twofactor.js';

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const BCRYPT_COST = 12;

// Login rate-limit: 5 failed attempts per (email, IP) within 10 minutes
// triggers a lockout. Resets on successful login. The 10-minute window
// rolls forward as long as attempts keep arriving.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 10;

function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()
       || req.headers['x-real-ip']
       || 'unknown');
}

async function isLoginLocked(email, ip) {
  // INTERVAL literal must be a constant string in the SQL, hence the 10
  // hard-coded here matching LOGIN_LOCKOUT_MINUTES. If you change the
  // constant, change the interval too.
  const rows = await sql`
    SELECT attempts, last_at FROM failed_logins
    WHERE email = ${email} AND ip = ${ip}
      AND last_at > NOW() - INTERVAL '10 minutes'
  `;
  return rows.length > 0 && rows[0].attempts >= LOGIN_MAX_ATTEMPTS;
}

async function recordFailedLogin(email, ip) {
  await sql`
    INSERT INTO failed_logins (email, ip, attempts, first_at, last_at)
    VALUES (${email}, ${ip}, 1, NOW(), NOW())
    ON CONFLICT (email, ip) DO UPDATE SET
      attempts = failed_logins.attempts + 1,
      last_at  = NOW()
  `;
}

async function clearFailedLogins(email, ip) {
  await sql`DELETE FROM failed_logins WHERE email = ${email} AND ip = ${ip}`;
}

async function loadUser(email) {
  const rows = await sql`
    SELECT email, name, avatar, role, password_hash,
           totp_secret, totp_enrolled, backup_code_hashes
    FROM users WHERE email = ${email}
  `;
  return rows[0] || null;
}

function publicUser(u) {
  return { email: u.email, name: u.name, avatar: u.avatar, role: u.role || 'member' };
}

async function consumeTrustedDevice(rawCookie, email) {
  if (!rawCookie) return false;
  const hash = hashTrustedDeviceToken(rawCookie);
  const rows = await sql`
    UPDATE trusted_devices
    SET last_used_at = NOW()
    WHERE token_hash = ${hash} AND email = ${email} AND expires_at > NOW()
    RETURNING id
  `;
  return rows.length > 0;
}

async function issueTrustedDevice(res, email, userAgent) {
  const raw = createTrustedDeviceToken();
  const hash = hashTrustedDeviceToken(raw);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await sql`
    INSERT INTO trusted_devices (email, token_hash, user_agent, expires_at, last_used_at)
    VALUES (${email}, ${hash}, ${userAgent || null}, ${expiresAt.toISOString()}, NOW())
  `;
  appendSetCookie(res, trustedDeviceCookieHeader(raw));
}

async function issueSession(res, user) {
  const jwt = await signToken({ email: user.email, name: user.name, role: user.role || 'member' });
  appendSetCookie(res, sessionCookieHeader(jwt));
  return jwt;
}

async function issueEmailOtp(email, purpose) {
  const code = generateEmailOtp();
  const codeHash = hashOtp(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();
  await sql`
    INSERT INTO email_otps (email, purpose, code_hash, attempts, expires_at, created_at)
    VALUES (${email}, ${purpose}, ${codeHash}, 0, ${expiresAt}, NOW())
    ON CONFLICT (email, purpose) DO UPDATE
      SET code_hash = EXCLUDED.code_hash,
          attempts = 0,
          expires_at = EXCLUDED.expires_at,
          created_at = NOW()
  `;
  // 2FA codes MUST surface delivery failure — a silent fail would leave the
  // user stuck on the verify screen with no code coming.
  await sendMail({
    to: email,
    subject: purpose === 'enrol'
      ? 'Confirm your Squideo email'
      : 'Your Squideo verification code',
    html: twoFactorCodeHtml({ code, minutes: OTP_TTL_MINUTES, purpose }),
    text: `Your Squideo verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`,
    throwOnError: true,
  });
}

async function verifyEmailOtp(email, purpose, code) {
  const rows = await sql`
    SELECT code_hash, attempts, expires_at
    FROM email_otps
    WHERE email = ${email} AND purpose = ${purpose}
  `;
  const row = rows[0];
  if (!row) return { ok: false, error: 'No code requested' };
  if (new Date(row.expires_at) < new Date()) {
    await sql`DELETE FROM email_otps WHERE email = ${email} AND purpose = ${purpose}`;
    return { ok: false, error: 'Code expired' };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await sql`DELETE FROM email_otps WHERE email = ${email} AND purpose = ${purpose}`;
    return { ok: false, error: 'Too many attempts. Request a new code.' };
  }
  if (hashOtp(String(code).replace(/\s+/g, '')) !== row.code_hash) {
    await sql`
      UPDATE email_otps SET attempts = attempts + 1
      WHERE email = ${email} AND purpose = ${purpose}
    `;
    return { ok: false, error: 'Invalid code' };
  }
  await sql`DELETE FROM email_otps WHERE email = ${email} AND purpose = ${purpose}`;
  return { ok: true };
}

async function realHandler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // `me` is naturally a GET — the SPA hits it on every page load to rehydrate
  // the session from the HttpOnly cookie. Everything else is POST.
  if (action === 'me') {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
    const payload = await requireAuth(req, res);
    if (!payload) return;
    const u = await loadUser(payload.email);
    if (!u) return res.status(404).json({ error: 'User not found' });
    return res.status(200).json({ user: publicUser(u) });
  }

  // `logout` clears the session cookie. Doesn't need auth — anyone hitting it
  // just gets their own cookie wiped (idempotent).
  if (action === 'logout') {
    if (req.method !== 'POST') return res.status(405).end();
    appendSetCookie(res, clearSessionCookieHeader());
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') return res.status(405).end();

  // ---------- login ----------
  if (action === 'login') {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const ip = clientIp(req);
    if (await isLoginLocked(email, ip)) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in 10 minutes.' });
    }

    const user = await loadUser(email);
    if (!user) {
      await recordFailedLogin(email, ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      await recordFailedLogin(email, ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Password verified — clear the (email, IP) rate-limit slot.
    await clearFailedLogins(email, ip);

    const tdCookie = parseCookie(req.headers.cookie, 'sq_td');
    if (tdCookie && (await consumeTrustedDevice(tdCookie, user.email))) {
      await issueSession(res, user);
      return res.status(200).json({ user: publicUser(user) });
    }

    if (user.totp_enrolled) {
      const challenge_token = await signChallengeToken({ email: user.email });
      return res.status(200).json({
        requires2fa: true,
        challenge_token,
        methods: ['totp', 'email', 'backup'],
      });
    }

    const enrolment_token = await signEnrolmentToken({ email: user.email });
    return res.status(200).json({ requiresEnrolment: true, enrolment_token });
  }

  // ---------- signup ----------
  if (action === 'signup') {
    const { email, name, password, inviteToken } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'email, name and password are required' });
    const token = (inviteToken || '').trim();
    if (!token) return res.status(400).json({ error: 'An invite is required to create an account' });

    const inv = (await sql`SELECT email, role, expires_at, used_at, revoked_at FROM invites WHERE token = ${token}`)[0];
    if (!inv || inv.used_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired invite' });
    }
    if (inv.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
      return res.status(400).json({ error: 'Email does not match invite' });
    }

    const existing = await sql`SELECT email FROM users WHERE lower(email) = ${email.toLowerCase()}`;
    if (existing.length > 0) return res.status(409).json({ error: 'An account with that email already exists' });

    const consumed = await sql`UPDATE invites SET used_at = now()
      WHERE token = ${token} AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      RETURNING role`;
    if (!consumed.length) return res.status(409).json({ error: 'Invite already used' });
    const role = consumed[0].role || 'member';

    const password_hash = await bcrypt.hash(password, BCRYPT_COST);
    await sql`INSERT INTO users (email, name, password_hash, role) VALUES (${email}, ${name}, ${password_hash}, ${role})`;

    const enrolment_token = await signEnrolmentToken({ email });
    return res.status(201).json({ requiresEnrolment: true, enrolment_token, user: { email, name, avatar: null, role } });
  }

  // ---------- 2fa-send-email ----------
  if (action === '2fa-send-email') {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    let email, purpose;
    try {
      const p = await verifyChallengeToken(token);
      email = p.email; purpose = 'login';
    } catch {
      try {
        const p = await verifyEnrolmentToken(token);
        email = p.email; purpose = 'enrol';
      } catch {
        return res.status(401).json({ error: 'Token invalid or expired' });
      }
    }
    await issueEmailOtp(email, purpose);
    return res.status(200).json({ sent: true });
  }

  // ---------- 2fa-verify ----------
  if (action === '2fa-verify') {
    const { challenge_token, method, code, remember_device } = req.body;
    if (!challenge_token || !method || !code) {
      return res.status(400).json({ error: 'challenge_token, method and code are required' });
    }
    let email;
    try {
      const p = await verifyChallengeToken(challenge_token);
      email = p.email;
    } catch {
      return res.status(401).json({ error: 'Challenge expired. Please sign in again.' });
    }
    const user = await loadUser(email);
    if (!user) return res.status(401).json({ error: 'Account not found' });

    if (method === 'totp') {
      if (!user.totp_secret || !verifyTotp(user.totp_secret, code)) {
        return res.status(401).json({ error: 'Invalid authenticator code' });
      }
    } else if (method === 'email') {
      const r = await verifyEmailOtp(email, 'login', code);
      if (!r.ok) return res.status(401).json({ error: r.error });
    } else if (method === 'backup') {
      const { ok, remaining } = consumeBackupCode(user.backup_code_hashes || [], code);
      if (!ok) return res.status(401).json({ error: 'Invalid backup code' });
      await sql`UPDATE users SET backup_code_hashes = ${remaining} WHERE email = ${email}`;
    } else {
      return res.status(400).json({ error: 'Unknown method' });
    }

    if (remember_device) {
      await issueTrustedDevice(res, email, req.headers['user-agent']);
    }
    await issueSession(res, user);
    return res.status(200).json({ user: publicUser(user) });
  }

  // ---------- 2fa-enrol-start ----------
  if (action === '2fa-enrol-start') {
    const { enrolment_token, method } = req.body;
    if (!enrolment_token || !method) return res.status(400).json({ error: 'enrolment_token and method required' });
    let email;
    try {
      const p = await verifyEnrolmentToken(enrolment_token);
      email = p.email;
    } catch {
      return res.status(401).json({ error: 'Enrolment session expired. Please sign in again.' });
    }
    if (method === 'totp') {
      const secret = generateTotpSecret();
      await sql`UPDATE users SET totp_secret = ${secret}, totp_enrolled = FALSE WHERE email = ${email}`;
      const otpauth_url = generateOtpauthUrl({ email, secret });
      const qr_data_url = await generateQrDataUrl(otpauth_url);
      return res.status(200).json({ otpauth_url, secret_base32: secret, qr_data_url });
    }
    if (method === 'email') {
      await issueEmailOtp(email, 'enrol');
      return res.status(200).json({ sent: true });
    }
    return res.status(400).json({ error: 'Unknown method' });
  }

  // ---------- 2fa-enrol-confirm ----------
  if (action === '2fa-enrol-confirm') {
    const { enrolment_token, code } = req.body;
    if (!enrolment_token || !code) return res.status(400).json({ error: 'enrolment_token and code required' });
    let email;
    try {
      const p = await verifyEnrolmentToken(enrolment_token);
      email = p.email;
    } catch {
      return res.status(401).json({ error: 'Enrolment session expired. Please sign in again.' });
    }
    const user = await loadUser(email);
    if (!user || !user.totp_secret) return res.status(400).json({ error: 'Start enrolment first' });
    if (!verifyTotp(user.totp_secret, code)) {
      return res.status(401).json({ error: 'Invalid authenticator code' });
    }
    const { codes, hashes } = generateBackupCodes(10);
    await sql`
      UPDATE users
      SET totp_enrolled = TRUE, backup_code_hashes = ${hashes}
      WHERE email = ${email}
    `;
    await issueSession(res, user);
    return res.status(200).json({ user: publicUser(user), backup_codes: codes });
  }

  // ---------- 2fa-reset (authed) ----------
  if (action === '2fa-reset') {
    const payload = await requireAuth(req, res);
    if (!payload) return;
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password required' });
    const user = await loadUser(payload.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });
    await sql`
      UPDATE users
      SET totp_secret = NULL, totp_enrolled = FALSE, backup_code_hashes = '{}'
      WHERE email = ${payload.email}
    `;
    await sql`DELETE FROM trusted_devices WHERE email = ${payload.email}`;
    return res.status(200).json({ ok: true });
  }

  // ---------- 2fa-regenerate-backup (authed) ----------
  if (action === '2fa-regenerate-backup') {
    const payload = await requireAuth(req, res);
    if (!payload) return;
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password required' });
    const user = await loadUser(payload.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });
    if (!user.totp_enrolled) return res.status(400).json({ error: '2FA is not enabled' });
    const { codes, hashes } = generateBackupCodes(10);
    await sql`UPDATE users SET backup_code_hashes = ${hashes} WHERE email = ${payload.email}`;
    return res.status(200).json({ backup_codes: codes });
  }

  res.status(404).end();
}

export default async function handler(req, res) {
  try {
    return await realHandler(req, res);
  } catch (err) {
    console.error('[auth handler crash]', { action: req.query?.action, method: req.method, msg: err?.message, stack: err?.stack });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Auth handler crashed: ' + (err?.message || 'unknown') });
    }
  }
}
