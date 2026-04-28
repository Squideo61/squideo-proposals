# Squideo Proposals — Local Setup

## Prerequisites
1. Install Node.js from https://nodejs.org (pick the LTS version, left-side button)
2. Verify by opening Terminal (Mac) or PowerShell (Windows) and typing:
   ```
   node --version
   ```
   You should see something like `v20.11.0`.

## First-time setup (one minute)
1. Unzip this folder somewhere easy to find (e.g. Desktop)
2. Open Terminal (Mac) or PowerShell (Windows)
3. Navigate into the folder:
   ```
   cd ~/Desktop/squideo-local
   ```
   (Adjust the path if you put it elsewhere)
4. Install dependencies (one-off):
   ```
   npm install
   ```
   This takes 30–60 seconds.

## Run the app
```
npm run dev
```

Your browser should open automatically to http://localhost:5173.
If it doesn't, open that URL manually.

## To stop the app
Press `Ctrl+C` in the Terminal window.

## To run it again later
Open Terminal, navigate to the folder with `cd`, and run `npm run dev`.

## Important notes
- **Data persists in the browser's localStorage.** Proposals, templates, users, signatures and payments survive reloads. To wipe everything, open DevTools → Application → Local Storage → delete the `squideo.store.v1` key (or clear site data).
- **Passwords are stored unencrypted in localStorage.** Do not use real or shared passwords — this is a prototype constraint.
- **The first sign-up creates the admin account.** Use any email/password combination.
- **Share links** show in a toast notification but don't actually work until you deploy to a real domain.
- **Stripe payments** are simulated via an on-screen modal clearly marked as a prototype — no real money changes hands.
- **Email notifications** log to the browser console (F12 → Console tab) instead of sending real emails.
- **Uploads are capped at 5 MB per image** to keep localStorage under its ~5 MB per-origin budget.

See squideo-migration-brief.docx for how to turn this prototype into a real production app.
