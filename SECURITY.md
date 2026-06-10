# Squideo CRM — Security Overview

A summary of the protections in place across the platform. Built defence-in-depth:
multiple independent layers, so no single failure exposes the business or client data.

## 🔐 Login & Accounts
- **Two-factor authentication (2FA) is mandatory** — every user must set up an authenticator app (with email codes and one-time backup codes as fallbacks). A stolen password alone can't get anyone in.
- **Passwords are securely hashed** (industry-standard bcrypt) — even we can't see them, and a database leak wouldn't expose them.
- **Brute-force protection** — accounts lock after 5 failed login attempts, and 2FA codes can't be repeatedly guessed.
- **Minimum password length enforced** (10+ characters).
- **"Sign out everywhere"** — if a device is lost or an account is suspected compromised, one click invalidates every active session everywhere.
- **Auto sign-out on security events** — changing a password or resetting 2FA instantly logs out all other devices.
- **No account guessing** — the login page gives nothing away about which email addresses are registered.

## 💳 Payments & Money
- **Payment amounts are verified by our server**, recalculated from the proposal — a client can't tamper with their browser to underpay.
- **Stripe and Xero connections are cryptographically verified** — fake "payment received" messages are rejected automatically.

## 🗂️ Data Access Controls
- **Role-based permissions** — staff only see and do what their role allows (finance, deals, admin, etc.).
- **Client-facing pages only expose safe information** — internal data is never sent to public proposal/payment links.
- **Deleted-record restore is permission-gated** — only authorised staff can bring back removed records.
- **Database is immune to injection attacks** — the most common website hacking technique simply can't work against us.

## 🛡️ Attack Defences
- **Strict browser security policy (CSP)** — blocks malicious scripts and stops the app being embedded by impostor sites.
- **All email/content is sanitised** — prevents hidden malicious code in messages.
- **HTTPS enforced everywhere** (HSTS) — no unencrypted connections.
- **Camera/microphone/location access disabled** at the browser level.
- **Error messages reveal nothing** about our internal systems to attackers.

## 🚧 Edge / Network Protection
- **Firewall rate-limiting** on all public-facing pages (quote form, proposal signing, login) — automatically blocks bots and brute-force floods before they reach the app.
- **Strong, random encryption key** protecting all login sessions.
- **All secrets and API keys are encrypted** and never stored in the code.

## 🔍 Continuous Monitoring (automatic, ongoing)
- **Dependency scanning (Dependabot)** — automatically alerts and fixes if any third-party software component develops a known vulnerability.
- **Secret scanning** — blocks API keys or passwords from ever being accidentally published.
- **Automated test suite** runs on every change to catch regressions.
- **Up-to-date toolchain** — running current, supported software versions.

## 👤 Account Hygiene (operational)
- 2FA enabled across all admin service accounts (GitHub, Vercel, Stripe, Xero, Google, etc.) — closing the most common real-world breach route: provider account takeover.

---

**Bottom line:** the platform has been independently audited end-to-end, every
high-priority finding has been fixed, and continuous monitoring is now in place
to keep it that way.

*Last reviewed: June 2026.*
