# Squideo Proposals + CRM

Production app for Squideo's proposal builder, sales CRM, Gmail integration,
and Stripe-driven billing.

## Stack

- **Frontend**: React 18 + Vite SPA (`src/`)
- **API**: Vercel Serverless Functions, Node 20 (`api/`)
- **Database**: Neon Postgres (`db/migrations/` — single source of truth for
  schema)
- **Chrome extension**: MV3, InboxSDK, lives in `extension/` (separate npm
  workspace)
- **Integrations**: Gmail OAuth + Pub/Sub, Stripe Checkout + Subscriptions,
  Xero invoices/quotes, Resend transactional email, Vercel Blob for deal
  files

## Local development

See [MAKING-CHANGES.md](MAKING-CHANGES.md) for the full setup. Short version:

```bash
vercel link            # one-off, pick the squideo-proposals project
vercel env pull .env.local
vercel dev             # http://localhost:3000
```

Edit files, browser hot-reloads, commit, `git push` deploys via Vercel.

## Deployment

See [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md) for Neon + Vercel setup. New
schema changes are SQL files in `db/migrations/` — apply them in alphabetical
order against your Neon branch via the SQL Editor before deploying the code
that uses them.

## Chrome extension

See [extension/README.md](extension/README.md) for build + side-load
instructions. Published privately via the Chrome Web Store.

## Repository layout

```
api/                  Serverless functions (Vercel)
  _lib/               Shared helpers — auth, DB, email, Gmail, Xero, Stripe
  auth/               Login, signup, 2FA
  crm/                Mega-router for CRM resources (companies, deals, …)
  proposals/          Proposal CRUD + public client read
  stripe/             Checkout, webhook, verify
  signatures/         Public sign endpoint
  views/              Anonymous view tracking
  payments/           Public payment status read
  extension/          Token exchange for the Chrome extension
  xero/               Xero connect/callback
src/                  React SPA
  components/         Feature UI + shared widgets
  components/crm/     Pipeline, deal detail, triage
db/migrations/        SQL schema changes (alphabetical order)
extension/            Chrome MV3 extension (separate package)
public/               Static assets served by Vite
```

## Audit

The latest internal security + quality audit lives in [AUDIT.md](AUDIT.md).
Track outstanding findings from there.

## Environment variables

All env vars are managed in the Vercel dashboard and synced locally with
`vercel env pull .env.local`. Currently in use:

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Neon Postgres connection string |
| `JWT_SECRET` | Session JWT signing key (also pepper for 2FA backup codes) |
| `APP_URL` | Canonical app base URL (used by Stripe redirect URLs + email links) |
| `MAIL_FROM` | `From:` header for transactional email |
| `RESEND_API_KEY` | Resend API key |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature secret |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail OAuth client |
| `GMAIL_TOKEN_KEY` | 64-hex-char AES-256-GCM key for refresh token encryption |
| `GMAIL_PUBSUB_TOPIC` | Gmail watch Pub/Sub topic |
| `GMAIL_PUSH_AUDIENCE` | (Optional) override expected audience on push JWTs |
| `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` / `XERO_REDIRECT_URI` | Xero OAuth |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token for deal file uploads |
| `CRON_SECRET` | Bearer token required by every cron handler |
