# Making Changes to Squideo Proposals

Follow these steps every time you want to update the app.

---

## Step 1 — Open a terminal in VS Code

In VS Code: **Terminal → New Terminal**

---

## Step 2 — Start the local app for testing

Run these three commands one at a time (copy and paste each separately):

```powershell
$env:DATABASE_URL='postgresql://neondb_owner:npg_zV1P9remvbdW@ep-green-grass-abv33j3f-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
```

```powershell
$env:JWT_SECRET='CU8Eu:P[=Kt+J#:xj8TZmEt,,A25fxr,q6@8j$Q8'
```

```powershell
vercel dev
```

Once you see `Ready! Available at http://localhost:3000`, open your browser to **http://localhost:3000** and test your changes there.

> You need to do this every time you open a new terminal. The secrets are not stored in the terminal permanently.

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
| Start local app | `vercel dev` (after setting the two env vars above) |
| Stop local app | Press `Ctrl+C` in the terminal |
| Save changes to GitHub | `git add .` → `git commit -m "message"` → `git push` |
| View live app | Your Vercel URL (e.g. `https://squideo-proposals.vercel.app`) |
| View database | https://console.neon.tech |
| View deployments | https://vercel.com/dashboard |
