# Making Changes to Squideo Proposals

Follow these steps every time you want to update the app.

> **⚠ Never paste real credentials, passwords, API keys, or connection strings into this file or any other file in the repo.** Secrets live in Vercel's Environment Variables. Use `vercel env pull` (below) to bring them down to your machine — that file (`.env.local`) is gitignored.

---

## First-time setup (only once per machine)

Before your first run, link this folder to the Vercel project and pull the env vars down locally:

```bash
vercel link
```

Pick the existing **squideo-proposals** project when prompted.

```bash
vercel env pull .env.local
```

This creates a local `.env.local` containing `DATABASE_URL`, `JWT_SECRET`, and any other env vars from Vercel. The file is in `.gitignore` and will not be committed.

> Re-run `vercel env pull .env.local` any time the secrets change in the Vercel dashboard (e.g. after a rotation).

---

## Step 1 — Open a terminal in VS Code

In VS Code: **Terminal → New Terminal**

---

## Step 2 — Start the local app for testing

```bash
vercel dev
```

`vercel dev` automatically reads `.env.local`, so you no longer need to set `$env:DATABASE_URL` or `$env:JWT_SECRET` by hand.

Once you see `Ready! Available at http://localhost:3000`, open your browser to **http://localhost:3000** and test your changes there.

---

## Step 3 — Make your changes

Edit the files in VS Code. The browser at localhost:3000 will update automatically as you save.

---

## Step 4 — Push your changes to go live

When you're happy with your changes, open a **new terminal** (Terminal → New Terminal) and run:

```bash
git add .
```

```bash
git commit -m "describe what you changed"
```

```bash
git push
```

Vercel will automatically detect the push and redeploy the live app. It takes about 60 seconds.

You can watch the progress at **https://vercel.com/dashboard** → your project → Deployments.

---

## Quick reference

| Task | Command |
|------|---------|
| First-time link to Vercel | `vercel link` |
| Pull env vars from Vercel | `vercel env pull .env.local` |
| Start local app | `vercel dev` |
| Stop local app | Press `Ctrl+C` in the terminal |
| Save changes to GitHub | `git add .` → `git commit -m "message"` → `git push` |
| View live app | `https://app.squideo.com` |
| View database | https://console.neon.tech |
| View deployments | https://vercel.com/dashboard |
