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
