# Squideo Proposals — Deployment Guide
**Neon (database) + Vercel (hosting)**

This guide covers a fresh deployment of the live app. If you're making code
changes to an existing deployment, see [MAKING-CHANGES.md](MAKING-CHANGES.md)
instead.

**Time required:** ~45 minutes for a fresh setup.

---

## How it works

```
Your team's browsers + the public proposal viewer
       ↕
   Vercel (hosts the SPA + runs the API + crons)
       ↕
   Neon (Postgres — proposals, users, signatures, CRM, …)

Side surfaces:
   • Stripe (checkout + subscriptions + webhook)
   • Resend (transactional email)
   • Xero (invoices + quotes)
   • Gmail / Google OAuth + Pub/Sub (inbound mail sync)
   • Vercel Blob (deal-file uploads)
   • Chrome Web Store (extension distribution)
```

---

## Step 1 — Create a Neon database

1. Sign up at **https://neon.tech** (free, no card).
2. Create a project named `squideo` (defaults are fine).
3. Open the **SQL Editor**.
4. Apply every file in [`db/migrations/`](db/migrations/) **in alphabetical order**.
   Each file is idempotent (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`) so
   re-running is safe.

> **`db/migrations/` is the single source of truth for schema.** Do not
> apply or maintain inline SQL outside that directory.

5. Copy the **Connection string** from the dashboard — you'll paste it into
   Vercel in step 4.

---

## Step 2 — Create a Vercel account & connect GitHub

1. Sign up at **https://vercel.com**.
2. Connect your GitHub account.

---

## Step 3 — Provision the third-party integrations

These all need API credentials set as env vars in step 4. Skip any you're
not using yet — most paths fall back gracefully (e.g. emails skip if
`RESEND_API_KEY` is missing).

- **Stripe** — Dashboard → Developers → API keys (`STRIPE_SECRET_KEY`).
  Add a webhook pointing at `https://YOUR-DOMAIN/api/stripe/webhook` and
  copy the signing secret (`STRIPE_WEBHOOK_SECRET`).
- **Resend** — Sign up, generate an API key (`RESEND_API_KEY`). Verify a
  sending domain matching `MAIL_FROM`.
- **Google Cloud / Gmail** — Create an OAuth client (web app type) with
  redirect URI `https://YOUR-DOMAIN/api/crm/gmail/callback`. Capture
  `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`. For inbound sync, create a
  Pub/Sub topic + push subscription targeting `/api/crm/gmail/push` and
  set `GMAIL_PUBSUB_TOPIC`.
- **Xero** — App registration with redirect URI matching
  `XERO_REDIRECT_URI`. Capture `XERO_CLIENT_ID` + `XERO_CLIENT_SECRET`.
- **Vercel Blob** — Enable Blob storage in the Vercel project; it auto-
  populates `BLOB_READ_WRITE_TOKEN`.

---

## Step 4 — Deploy to Vercel

1. **Add New Project** → import your GitHub repo.
2. Vercel auto-detects Vite — leave build settings alone.
3. Click **Environment Variables** and add the keys below. The minimum to
   boot is `DATABASE_URL` + `JWT_SECRET`; the rest enable individual
   features.

| Var | Required? | Purpose |
|-----|-----------|---------|
| `DATABASE_URL` | ✓ | Neon connection string |
| `JWT_SECRET` | ✓ | Session JWTs + 2FA backup-code pepper. ≥32 random chars. |
| `APP_URL` | ✓ | e.g. `https://app.squideo.co.uk` — used for redirect URLs + email links |
| `MAIL_FROM` |   | Default `Squideo Proposals <noreply@squideo.co.uk>` |
| `RESEND_API_KEY` |   | Transactional email |
| `STRIPE_SECRET_KEY` |   | Stripe checkout + verify |
| `STRIPE_WEBHOOK_SECRET` |   | Verifies webhook signatures |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |   | Gmail OAuth |
| `GMAIL_TOKEN_KEY` |   | 64-hex-char (32 byte) AES-256-GCM key for refresh tokens |
| `GMAIL_PUBSUB_TOPIC` |   | `projects/<gcp-project>/topics/<topic>` |
| `GMAIL_PUSH_AUDIENCE` |   | Optional, defaults to `${APP_URL}/api/crm/gmail/push` |
| `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` / `XERO_REDIRECT_URI` |   | Xero |
| `BLOB_READ_WRITE_TOKEN` |   | Deal-file uploads (auto-set by Blob integration) |
| `CRON_SECRET` |   | Required for cron endpoints; ≥32 random chars |

> **Generate `GMAIL_TOKEN_KEY` once and never rotate**: rotating invalidates
> every stored refresh token. Generate with:
> `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

4. **Deploy.**

---

## Step 5 — Smoke test

1. Open the live URL.
2. Sign up via the first-time admin invite flow (or create an invite if
   you've already seeded an admin).
3. Create a test proposal, sign it via the public client URL.
4. Confirm a row landed in Neon: `SELECT id FROM signatures LIMIT 5;`
5. Connect Gmail from the in-app **Account → Gmail integration** — confirm
   `gmail_accounts` row appears.

---

## Step 6 — Schedule the crons

The `crons` block in `vercel.json` schedules:

| Path | Schedule | Purpose |
|------|----------|---------|
| `/api/crm/cron/task-reminders` | `0 9 * * *` | Daily 09:00 UTC: emails task assignees about anything due in the next 24h. |
| `/api/crm/cron/gmail-watch-renew` | `0 5 * * *` | Daily 05:00 UTC: renews Gmail Pub/Sub watches (expire ~7d) + polls accounts that haven't received a push for >2h. |
| `/api/crm/cron/prune-views` | `0 3 * * 1` | Weekly 03:00 UTC Mon: deletes `proposal_views` rows older than 12 months (GDPR retention). |

Each requires `Authorization: Bearer ${CRON_SECRET}`. Vercel attaches this
automatically for project crons; you don't need to do anything else.

---

## Step 7 — Custom domain (optional)

In the Vercel project → Settings → Domains, add your custom domain and
update `APP_URL`. Re-issue Stripe webhook + Google OAuth redirect URI
configs to match the new domain.

---

## Common issues

**"Cannot connect to database"** — check `DATABASE_URL` in Vercel env vars.

**Blank page after deploying** — Vercel → Deployments → latest → View logs.

**"Invalid token" after logging in** — `JWT_SECRET` missing or mismatched
between local + Vercel.

**Stripe webhook returning 400** — `STRIPE_WEBHOOK_SECRET` mismatched with
the one Stripe shows for your endpoint.

**Gmail OAuth completes but no sync** — `GMAIL_PUBSUB_TOPIC` not set, or
the Pub/Sub push subscription doesn't point at `/api/crm/gmail/push`. Check
Vercel logs for `[gmail push]` lines.

**Crons returning 401** — `CRON_SECRET` not set.

---

## Sharing the app with your team

Existing admins invite new members from **Settings → Users → Invite**. The
invite link is single-use, email-bound, and expires in 7 days.
