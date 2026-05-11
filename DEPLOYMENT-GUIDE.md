# Squideo Proposals — Deployment Guide
**Neon (database) + Vercel (hosting)**

---

## What this guide covers

Your app has already been updated with all the code needed to connect to a real database and go live. This guide covers the manual steps you need to do yourself: creating accounts, running the database setup, filling in your secret keys, and deploying.

**Time required:** ~30–45 minutes

---

## How it works (simple version)

```
Your team's browsers
       ↕
   Vercel (hosts the app + runs the backend)
       ↕
   Neon (stores all proposals, users, signatures)
```

- **Neon** = the database. It stores your proposals, user accounts, signatures, etc. on their servers instead of in the browser.
- **Vercel** = the web host. It makes the app accessible at a real URL and runs the server-side code that talks to Neon.

---

## Step 1 — Create a Neon account and database

1. Go to **https://neon.tech** and sign up (free, no credit card needed)
2. Click **"New Project"** and name it `squideo`
3. Leave all other settings as default and click **Create**
4. Once created, click **SQL Editor** in the left sidebar
5. Paste the entire block below and click **Run**:

```sql
CREATE TABLE users (
  email         TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE proposals (
  id          TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  number_year INTEGER,
  number_seq  INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_proposals_number ON proposals(number_year, number_seq);

CREATE TABLE templates (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE signatures (
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  signed_at   TIMESTAMPTZ NOT NULL,
  data        JSONB NOT NULL
);

CREATE TABLE payments (
  proposal_id       TEXT PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
  amount            NUMERIC(10,2) NOT NULL,
  payment_type      TEXT NOT NULL,
  paid_at           TIMESTAMPTZ NOT NULL,
  stripe_session_id TEXT,
  customer_email    TEXT
);

CREATE TABLE proposal_views (
  proposal_id      TEXT        NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  session_id       TEXT        NOT NULL,
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_seconds INTEGER     NOT NULL DEFAULT 0,
  ip_address       TEXT,
  country          TEXT,
  region           TEXT,
  city             TEXT,
  user_agent       TEXT,
  PRIMARY KEY (proposal_id, session_id)
);
CREATE INDEX idx_proposal_views_opened ON proposal_views(proposal_id, opened_at DESC);

CREATE TABLE settings (
  id                      INTEGER PRIMARY KEY DEFAULT 1,
  extras_bank             JSONB NOT NULL DEFAULT '[]',
  inclusions_bank         JSONB NOT NULL DEFAULT '[]',
  notification_recipients JSONB NOT NULL DEFAULT '[]',
  CHECK (id = 1)
);

INSERT INTO settings DEFAULT VALUES;

-- Partner Programme — subscription status & credit allocations
CREATE TABLE partner_subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  proposal_id            TEXT REFERENCES proposals(id) ON DELETE SET NULL,
  client_key             TEXT NOT NULL,
  client_name            TEXT,
  credits_per_month      NUMERIC(10,2) NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL DEFAULT 'active',
  current_period_end     TIMESTAMPTZ,
  canceled_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_partner_subscriptions_client ON partner_subscriptions(client_key);

CREATE TABLE credit_allocations (
  id           SERIAL PRIMARY KEY,
  client_key   TEXT NOT NULL,
  proposal_id  TEXT REFERENCES proposals(id) ON DELETE SET NULL,
  description  TEXT NOT NULL,
  credit_cost  NUMERIC(10,2) NOT NULL,
  allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  allocated_by TEXT,
  notes        TEXT
);
CREATE INDEX idx_credit_allocations_client ON credit_allocations(client_key, allocated_at DESC);
```

You should see a success message. Your database is now ready.

> **Already deployed an older version?** If your database was created before proposal numbering and per-session view tracking, run this one-time migration in the SQL Editor:
> ```sql
> -- Proposal numbering (sequential per calendar year)
> ALTER TABLE proposals
>   ADD COLUMN IF NOT EXISTS number_year INTEGER,
>   ADD COLUMN IF NOT EXISTS number_seq  INTEGER;
> CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_number
>   ON proposals(number_year, number_seq);
> WITH ranked AS (
>   SELECT id,
>          EXTRACT(YEAR FROM created_at)::INT AS y,
>          ROW_NUMBER() OVER (PARTITION BY EXTRACT(YEAR FROM created_at)
>                             ORDER BY created_at) AS n
>   FROM proposals WHERE number_seq IS NULL
> )
> UPDATE proposals p SET number_year = r.y, number_seq = r.n
> FROM ranked r WHERE p.id = r.id;
>
> -- Replace minimal views table with rich session log
> DROP TABLE IF EXISTS views;
> CREATE TABLE proposal_views (
>   proposal_id      TEXT        NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
>   session_id       TEXT        NOT NULL,
>   opened_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
>   last_active_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
>   duration_seconds INTEGER     NOT NULL DEFAULT 0,
>   ip_address       TEXT,
>   country          TEXT,
>   region           TEXT,
>   city             TEXT,
>   user_agent       TEXT,
>   PRIMARY KEY (proposal_id, session_id)
> );
> CREATE INDEX idx_proposal_views_opened ON proposal_views(proposal_id, opened_at DESC);
>
> -- Partner Programme: subscription status + credit allocations
> CREATE TABLE IF NOT EXISTS partner_subscriptions (
>   stripe_subscription_id TEXT PRIMARY KEY,
>   proposal_id            TEXT REFERENCES proposals(id) ON DELETE SET NULL,
>   client_key             TEXT NOT NULL,
>   client_name            TEXT,
>   credits_per_month      NUMERIC(10,2) NOT NULL DEFAULT 1,
>   status                 TEXT NOT NULL DEFAULT 'active',
>   current_period_end     TIMESTAMPTZ,
>   canceled_at            TIMESTAMPTZ,
>   created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
>   updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
> );
> CREATE INDEX IF NOT EXISTS idx_partner_subscriptions_client ON partner_subscriptions(client_key);
>
> CREATE TABLE IF NOT EXISTS credit_allocations (
>   id           SERIAL PRIMARY KEY,
>   client_key   TEXT NOT NULL,
>   proposal_id  TEXT REFERENCES proposals(id) ON DELETE SET NULL,
>   description  TEXT NOT NULL,
>   credit_cost  NUMERIC(10,2) NOT NULL,
>   allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
>   allocated_by TEXT,
>   notes        TEXT
> );
> CREATE INDEX IF NOT EXISTS idx_credit_allocations_client ON credit_allocations(client_key, allocated_at DESC);
>
> -- Manual partner subscriptions + credit-adjustment kind
> ALTER TABLE credit_allocations
>   ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'work';
> ALTER TABLE partner_subscriptions
>   ADD COLUMN IF NOT EXISTS auto_credit BOOLEAN NOT NULL DEFAULT TRUE,
>   ADD COLUMN IF NOT EXISTS start_date  DATE;
>
> -- One-time backfill: seed partner_subscriptions from existing payments
> INSERT INTO partner_subscriptions
>   (stripe_subscription_id, proposal_id, client_key, client_name, credits_per_month, status)
> SELECT
>   p.partner_subscription_id,
>   p.proposal_id,
>   LOWER(TRIM(COALESCE(NULLIF(pb.billing->>'companyName', ''), s.email, p.proposal_id))),
>   COALESCE(NULLIF(pb.billing->>'companyName', ''), s.email),
>   COALESCE((s.data->>'partnerCredits')::NUMERIC, 1),
>   'active'
> FROM payments p
> LEFT JOIN proposal_billing pb ON pb.proposal_id = p.proposal_id
> LEFT JOIN signatures s        ON s.proposal_id  = p.proposal_id
> WHERE p.partner_subscription_id IS NOT NULL
> ON CONFLICT (stripe_subscription_id) DO NOTHING;
> ```

> **CRM Phase 1 (deals, contacts, companies, tasks)** — Adds the Streak-style sales pipeline. Run once in Neon's SQL Editor. Idempotent.
> ```sql
> CREATE TABLE IF NOT EXISTS companies (
>   id          TEXT PRIMARY KEY,
>   name        TEXT NOT NULL,
>   domain      TEXT,
>   notes       TEXT,
>   created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
>   updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
> );
> CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(LOWER(domain));
>
> CREATE TABLE IF NOT EXISTS contacts (
>   id          TEXT PRIMARY KEY,
>   email       TEXT,
>   name        TEXT,
>   phone       TEXT,
>   title       TEXT,
>   company_id  TEXT REFERENCES companies(id) ON DELETE SET NULL,
>   notes       TEXT,
>   created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
>   updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
> );
> CREATE INDEX IF NOT EXISTS idx_contacts_email   ON contacts(LOWER(email));
> CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
>
> CREATE TABLE IF NOT EXISTS deals (
>   id                  TEXT PRIMARY KEY,
>   title               TEXT NOT NULL,
>   company_id          TEXT REFERENCES companies(id) ON DELETE SET NULL,
>   primary_contact_id  TEXT REFERENCES contacts(id) ON DELETE SET NULL,
>   owner_email         TEXT REFERENCES users(email) ON DELETE SET NULL,
>   stage               TEXT NOT NULL DEFAULT 'lead',
>   stage_changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
>   value               NUMERIC(10,2),
>   expected_close_at   DATE,
>   lost_reason         TEXT,
>   notes               TEXT,
>   last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
>   created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
>   updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
> );
> CREATE INDEX IF NOT EXISTS idx_deals_stage   ON deals(stage, stage_changed_at DESC);
> CREATE INDEX IF NOT EXISTS idx_deals_owner   ON deals(owner_email);
> CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);
>
> CREATE TABLE IF NOT EXISTS deal_contacts (
>   deal_id     TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
>   contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
>   role        TEXT,
>   PRIMARY KEY (deal_id, contact_id)
> );
>
> CREATE TABLE IF NOT EXISTS deal_events (
>   id           BIGSERIAL PRIMARY KEY,
>   deal_id      TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
>   event_type   TEXT NOT NULL,
>   payload      JSONB NOT NULL DEFAULT '{}',
>   actor_email  TEXT,
>   occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
> );
> CREATE INDEX IF NOT EXISTS idx_deal_events_deal ON deal_events(deal_id, occurred_at DESC);
>
> CREATE TABLE IF NOT EXISTS tasks (
>   id              TEXT PRIMARY KEY,
>   deal_id         TEXT REFERENCES deals(id) ON DELETE CASCADE,
>   contact_id      TEXT REFERENCES contacts(id) ON DELETE SET NULL,
>   title           TEXT NOT NULL,
>   notes           TEXT,
>   due_at          TIMESTAMPTZ,
>   assignee_email  TEXT REFERENCES users(email) ON DELETE SET NULL,
>   done_at         TIMESTAMPTZ,
>   reminded_at     TIMESTAMPTZ,
>   created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
>   created_by      TEXT
> );
> CREATE INDEX IF NOT EXISTS idx_tasks_due      ON tasks(due_at) WHERE done_at IS NULL;
> CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_email, due_at) WHERE done_at IS NULL;
> CREATE INDEX IF NOT EXISTS idx_tasks_deal     ON tasks(deal_id);
>
> ALTER TABLE proposals ADD COLUMN IF NOT EXISTS deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL;
> CREATE INDEX IF NOT EXISTS idx_proposals_deal ON proposals(deal_id);
>
> -- One-time backfill: create a deal for every existing proposal that doesn't
> -- have one. Stage is inferred from existing signals (paid/signed/viewed) so
> -- the pipeline reflects current state without manual data entry.
> INSERT INTO deals (id, title, owner_email, stage, stage_changed_at, value, last_activity_at, created_at, updated_at)
> SELECT
>   'deal_' || p.id,
>   COALESCE(
>     NULLIF(p.data->>'contactBusinessName', ''),
>     NULLIF(p.data->>'clientName', ''),
>     'Untitled deal'
>   ),
>   NULLIF(p.data->>'preparedByEmail', ''),
>   CASE
>     WHEN pay.proposal_id IS NOT NULL THEN 'paid'
>     WHEN s.proposal_id   IS NOT NULL THEN 'signed'
>     WHEN v.proposal_id   IS NOT NULL THEN 'viewed'
>     ELSE 'quoting'
>   END,
>   COALESCE(pay.paid_at, s.signed_at, v.first_at, p.created_at),
>   COALESCE((p.data->>'basePrice')::NUMERIC, NULL),
>   COALESCE(pay.paid_at, s.signed_at, v.first_at, p.updated_at, p.created_at),
>   p.created_at,
>   p.updated_at
> FROM proposals p
> LEFT JOIN payments   pay ON pay.proposal_id = p.id
> LEFT JOIN signatures s   ON s.proposal_id   = p.id
> LEFT JOIN (
>   SELECT proposal_id, MIN(opened_at) AS first_at FROM proposal_views GROUP BY proposal_id
> ) v ON v.proposal_id = p.id
> WHERE p.deal_id IS NULL
> ON CONFLICT (id) DO NOTHING;
>
> UPDATE proposals p
>    SET deal_id = 'deal_' || p.id
>  WHERE p.deal_id IS NULL
>    AND EXISTS (SELECT 1 FROM deals d WHERE d.id = 'deal_' || p.id);
> ```

> **CRM Phase 2 (Gmail OAuth)** — Adds per-user Gmail authentication and a short-lived OAuth state table. Refresh tokens are stored encrypted (AES-256-GCM); the encryption key lives in the `GMAIL_TOKEN_KEY` env var. Run once in Neon.
> ```sql
> CREATE TABLE IF NOT EXISTS gmail_accounts (
>   user_email                TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
>   gmail_address             TEXT NOT NULL,
>   refresh_token_enc         BYTEA NOT NULL,
>   refresh_token_iv          BYTEA NOT NULL,
>   refresh_token_tag         BYTEA NOT NULL,
>   access_token              TEXT,
>   access_token_expires_at   TIMESTAMPTZ,
>   history_id                TEXT,
>   watch_expires_at          TIMESTAMPTZ,
>   pubsub_topic              TEXT,
>   scopes                    TEXT,
>   connected_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
>   disconnected_at           TIMESTAMPTZ,
>   updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
> );
>
> CREATE TABLE IF NOT EXISTS oauth_states (
>   state       TEXT PRIMARY KEY,
>   user_email  TEXT NOT NULL,
>   purpose     TEXT NOT NULL,                  -- 'gmail-connect' for now
>   created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
> );
> CREATE INDEX IF NOT EXISTS idx_oauth_states_created ON oauth_states(created_at);
> ```

> **CRM Phase 3 (Gmail inbound sync via Pub/Sub)** — Adds tables that hold every email thread + message synced from Gmail and the M:N join that links threads to deals (boxes). Plus two columns on `gmail_accounts` for the poll-fallback cron and backfill bookkeeping. Run once in Neon.
> ```sql
> CREATE TABLE IF NOT EXISTS email_threads (
>   gmail_thread_id    TEXT PRIMARY KEY,
>   user_email         TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
>   subject            TEXT,
>   last_message_at    TIMESTAMPTZ,
>   participant_emails TEXT[] DEFAULT '{}',
>   created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
> );
> CREATE INDEX IF NOT EXISTS idx_email_threads_user_last ON email_threads(user_email, last_message_at DESC);
>
> CREATE TABLE IF NOT EXISTS email_messages (
>   gmail_message_id    TEXT PRIMARY KEY,
>   gmail_thread_id     TEXT NOT NULL REFERENCES email_threads(gmail_thread_id) ON DELETE CASCADE,
>   user_email          TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
>   message_id_header   TEXT,
>   in_reply_to         TEXT,
>   refs                TEXT[] DEFAULT '{}',
>   from_email          TEXT,
>   to_emails           TEXT[] DEFAULT '{}',
>   cc_emails           TEXT[] DEFAULT '{}',
>   subject             TEXT,
>   snippet             TEXT,
>   body_html           TEXT,
>   body_text           TEXT,
>   direction           TEXT NOT NULL,                   -- 'inbound' | 'outbound'
>   unmatched           BOOLEAN NOT NULL DEFAULT FALSE,
>   internal_only       BOOLEAN NOT NULL DEFAULT FALSE,
>   source              TEXT,                             -- 'pubsub' | 'extension-snapshot' | 'compose-helper'
>   sent_at             TIMESTAMPTZ NOT NULL,
>   ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
> );
> CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(gmail_thread_id, sent_at);
> CREATE INDEX IF NOT EXISTS idx_email_messages_unmatched ON email_messages(user_email) WHERE unmatched;
> CREATE INDEX IF NOT EXISTS idx_email_messages_msgid ON email_messages(message_id_header);
>
> CREATE TABLE IF NOT EXISTS email_thread_deals (
>   gmail_thread_id  TEXT NOT NULL REFERENCES email_threads(gmail_thread_id) ON DELETE CASCADE,
>   deal_id          TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
>   resolved_by      TEXT,                                -- 'header' | 'thread' | 'in-reply-to' | 'contact' | 'domain' | 'manual' | 'extension'
>   resolved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
>   PRIMARY KEY (gmail_thread_id, deal_id)
> );
> CREATE INDEX IF NOT EXISTS idx_email_thread_deals_deal ON email_thread_deals(deal_id);
>
> ALTER TABLE gmail_accounts ADD COLUMN IF NOT EXISTS last_pushed_at TIMESTAMPTZ;
> ALTER TABLE gmail_accounts ADD COLUMN IF NOT EXISTS backfill_completed_at TIMESTAMPTZ;
> ```

> **CRM Phase 3.5 (multi-assignee tasks)** — Replaces the single `tasks.assignee_email` column with a join table so a task can have any number of assignees. Backfills the existing single-assignment data into the join table. `tasks.assignee_email` is retained for one release as a read fallback; drop it in a follow-up migration (commented out below) once you've confirmed the new UI is deployed and stable.
> ```sql
> CREATE TABLE IF NOT EXISTS task_assignees (
>   task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
>   user_email  TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
>   assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
>   PRIMARY KEY (task_id, user_email)
> );
> CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_email);
>
> -- Backfill existing single-assignee rows into the join table.
> INSERT INTO task_assignees (task_id, user_email)
> SELECT id, assignee_email
> FROM tasks
> WHERE assignee_email IS NOT NULL
> ON CONFLICT DO NOTHING;
>
> -- Follow-up migration (run AFTER the new UI has been live for a release):
> -- DROP INDEX IF EXISTS idx_tasks_assignee;
> -- ALTER TABLE tasks DROP COLUMN IF EXISTS assignee_email;
> ```

6. Click **Dashboard** in the top left, then find the **"Connection string"** section
7. Copy the connection string — it looks like:
   ```
   postgresql://adam:somepassword@ep-cool-name-123.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
   Keep this handy for Step 3.

---

## Step 2 — Create a Vercel account

1. Go to **https://vercel.com** and sign up
2. Connect your **GitHub** account when prompted (Vercel deploys directly from GitHub)
3. That's all for now — you'll come back to Vercel in Step 5

---

## Step 3 — Fill in your secret keys (local file)

In your project folder, open the file called **`.env.local`**

> If you can't see it, it may be hidden. In Windows Explorer: View → Show → Hidden items

Replace the two placeholder values:

```
DATABASE_URL=postgresql://REPLACE_ME
JWT_SECRET=REPLACE_ME_WITH_A_LONG_RANDOM_SECRET
```

- **DATABASE_URL** → paste the connection string you copied from Neon in Step 1
- **JWT_SECRET** → make up any long random string of letters and numbers, at least 32 characters. For example: `squideo-super-secret-key-2024-xk39amq7`

Example of a filled-in `.env.local`:
```
DATABASE_URL=postgresql://adam:abc123@ep-cool-name-123.us-east-2.aws.neon.tech/neondb?sslmode=require
JWT_SECRET=squideo-proposals-secret-key-2024-abc123xyz
```

> **Important:** Never share this file or commit it to GitHub. It's already in `.gitignore` so it won't be uploaded automatically.

---

## Step 4 — Test it locally

Open a terminal in your project folder and run:

```bash
npm install -g vercel
vercel dev
```

The first time you run `vercel dev` it will ask you a few questions:
- **Set up and deploy?** → Yes
- **Which scope?** → your account
- **Link to existing project?** → No
- **What's your project name?** → squideo-proposals
- **In which directory is your code?** → hit Enter (current directory)
- **Want to override settings?** → No

Once it starts, open your browser to **http://localhost:3000**

**Test checklist:**
- [ ] Sign up with your email and password — you should be able to log in
- [ ] Create a new proposal
- [ ] Edit it and wait a second — then refresh. The data should still be there
- [ ] Go to Neon → SQL Editor and run `SELECT * FROM proposals;` — you should see your proposal in the database
- [ ] Open the app in a different browser (e.g. Edge instead of Chrome) and log in — same proposals should appear

If everything works, you're ready to deploy.

---

## Step 5 — Put your code on GitHub

If your project isn't already on GitHub:

1. Go to **https://github.com** and sign in
2. Click **New repository** → name it `squideo-proposals` → Create
3. In your terminal, run these commands one at a time:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/squideo-proposals.git
git push -u origin main
```

Replace `YOUR-USERNAME` with your GitHub username.

> The `.gitignore` file already ensures your `.env.local` secrets are NOT uploaded to GitHub.

---

## Step 6 — Deploy to Vercel

1. Go to **https://vercel.com** and click **Add New Project**
2. Click **Import** next to your `squideo-proposals` GitHub repository
3. Vercel will detect it's a Vite app automatically — don't change any build settings
4. Before clicking Deploy, click **Environment Variables** and add:

| Name | Value |
|------|-------|
| `DATABASE_URL` | Your Neon connection string (same as in `.env.local`) |
| `JWT_SECRET` | Your secret key (same as in `.env.local`) |

5. Click **Deploy**

Vercel will build and deploy your app. In about 60 seconds you'll get a live URL like:
```
https://squideo-proposals.vercel.app
```

---

## Step 7 — Final check

1. Open your live URL in a browser
2. Sign up for an account
3. Create a test proposal
4. Open the URL on your phone or another computer — log in and confirm the proposal is there

You're live. ✓

---

## Sharing the app with your team

Anyone can sign up at your Vercel URL using the **Sign up** link on the login screen. Everyone shares the same proposals and templates stored in Neon.

---

## What to do if something goes wrong

**"Cannot connect to database" error**
→ Double-check your `DATABASE_URL` is correct in Vercel's Environment Variables (no extra spaces)

**Blank page after deploying**
→ Go to Vercel → your project → Deployments → click the latest one → View logs

**"Invalid token" after logging in**
→ Make sure `JWT_SECRET` is set in Vercel's Environment Variables

**Data doesn't appear after refreshing**
→ Check the Neon SQL Editor to confirm data is reaching the database: `SELECT * FROM proposals;`

**Need to make code changes in future**
→ Edit your files locally, then `git add . && git commit -m "your change" && git push` — Vercel will automatically redeploy

---

## Important notes

- **Your existing proposals won't transfer** — any proposals created while the app was local (using localStorage) are not in Neon. You'll need to re-create them.
- **Passwords are now secure** — they're stored as bcrypt hashes in Neon, not as plain text in the browser.
- **Free tier limits** — Neon's free tier includes 0.5 GB storage and 190 compute hours/month, which is plenty for a small team. Vercel's free tier covers unlimited deploys and 100 GB bandwidth/month.

---

## Quick reference

| What | Where |
|------|-------|
| Neon dashboard (view/query your data) | https://console.neon.tech |
| Vercel dashboard (deployments, logs) | https://vercel.com/dashboard |
| Your live app | https://squideo-proposals.vercel.app (or your custom URL) |
| Local dev server | `vercel dev` → http://localhost:3000 |
| Secret keys file | `.env.local` in your project folder |
