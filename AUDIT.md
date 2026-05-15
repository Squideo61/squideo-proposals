# Squideo Codebase Audit — 2026-05-12

Full-codebase review across security, quality, and operations. Findings are
ranked **Critical / High / Medium / Low**. Every finding cites file + line so
you can jump straight to the source. No code was changed in this pass — this
report is the backlog you triage from.

> **Audit caveat**: `npm audit` and `npm outdated` could not run end-to-end —
> the local npm registry connection failed with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
> (corporate cert intercept on this machine). Dependency-section findings rely
> on manual inspection of `package.json` + public CVE knowledge as of August 2025.
> Re-run `npm audit --omit=dev` on a network without TLS interception to verify.

---

## Executive summary

The top 10 things to fix, in order of severity. Each links to the relevant
section below.

| # | Severity | Area | Finding |
|---|----------|------|---------|
| 1 | **Critical** | Auth | `/api/proposals/[id]` PUT and DELETE let **any authed user overwrite or delete any proposal** — no ownership/admin check. ([§2.1](#21-no-ownership-check-on-proposal-mutations-critical)) |
| 2 | **Critical** | Data exposure | `/api/payments/[id]` GET has **no auth at all** — anyone with a proposal ID can read customer email + amount + receipt URL. ([§3.1](#31-unauthenticated-payment-detail-read-critical)) |
| 3 | **Critical** | Auth | `/api/settings` PUT lets **any authed user mutate global settings** including notification recipients. ([§2.2](#22-global-settings-mutable-by-any-member-critical)) |
| 4 | **High** | Auth | Most CRM DELETE endpoints (companies, contacts, tasks, deals, templates, files, comments-by-author-only) have no role check — any member can delete anyone's data. ([§2.3](#23-crm-deletes-have-no-role-or-ownership-checks-high)) |
| 5 | **High** | Module boundaries | Extension still has a **fourth duplicated `STAGE_COLOURS`** map in `extension/src/content/ComposeBar.jsx:22` using the old stage names (`qualified`, `quoting`, `sent`) — missed in the previous sync. ([§5.1](#51-fourth-duplicated-stage_colours-map-in-the-extension-high)) |
| 6 | **High** | Logging | Cron handlers and Pub/Sub push silently `200` on most failure paths — operational issues will go unnoticed for days. ([§7.1](#71-silent-failure-paths-in-cron--pubsub-handlers-high)) |
| 7 | **High** | Tests | **Zero tests in the repo.** Load-bearing modules (`gmailSync.ingestMessage`, `advanceStage`, Stripe webhook, `requireAuth`) have no safety net for regressions. ([§8.1](#81-no-tests-anywhere-high)) |
| 8 | **High** | Docs | `README.md` describes the project as a **localStorage prototype** with simulated payments and no server. It hasn't been updated since the Neon/Vercel migration. New collaborators will be badly misled. ([§10.4](#104-readmemd-is-a-prototype-era-relic-high)) |
| 9 | **Medium** | Debt | `api/crm/[...slug].js` is **2346 lines** in one file, ten resources sharing one default handler. Adding the next feature compounds risk of regression. ([§9.1](#91-the-crm-mega-file-medium)) |
| 10 | **Medium** | Performance | SPA bundles to **943 KB / 273 KB gzipped** in a single chunk. The public proposal viewer loads the entire CRM, builder, and admin UI. ([§9.4](#94-bundle-size--no-code-splitting-medium)) |

---

## 1. Input validation

### State of play

API routes use tagged-template SQL (`sql\`...\``) via `@neondatabase/serverless`,
which prevents classic SQL injection at the engine level. Body validation is
inconsistent — some routes have careful `trimOrNull` / `numberOrNull` / enum
checks (e.g. [api/crm/[...slug].js:47-60](api/crm/[...slug].js#L47-L60), `isValidStage`),
others trust the body shape blindly. DOMPurify is used correctly in the email
viewer and signature preview.

### Findings

**1.1. `req.body` shape trusted in several mutations** — *Low*

[api/crm/[...slug].js:317-336](api/crm/[...slug].js#L317-L336) and many siblings:
deals POST reads `body.companyId`, `body.primaryContactId`, etc. with only
`trimOrNull`. A non-string (`{}`, `[]`, `false`) coerces silently. Not exploitable
because SQL is parameterised, but a malformed body produces confusing 500s
instead of a clean 400.

**Remediation**: a thin `requireString(field, body)` / `requireEnum(field, body, allowed)`
helper in `_lib/middleware.js` that 400s on type mismatch.

**1.2. `req.body` shape trusted in `gmailSend()`** — *Low*

[api/crm/[...slug].js:1916-1928](api/crm/[...slug].js#L1916-L1928): `to`, `cc`,
`bcc` are accepted as arrays without validating each entry is a non-empty
string. A `["foo", null, 42]` passes through to the SMTP `To:` header
construction. Currently shielded by `.filter(Boolean)` for `to`/`cc`/`bcc`, but
not by an email-shape check. The current Gmail API will reject an obviously
malformed address, but the error surfaces as a 502 with no field-specific
message.

**Remediation**: server-side regex (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) per address
matching the one already used in the Stripe `customerEmail` validation
([api/stripe/[action].js:493](api/stripe/[action].js#L493)).

**1.3. `/api/views/[id]` accepts any `sessionId`** — *Low*

[api/views/[id].js:14-48](api/views/[id].js#L14-L48): `sessionId` is the
upsert key but is untyped. A malicious caller can pollute view stats by
sending an unbounded number of distinct `sessionId`s per proposal.

**Remediation**: cap `sessionId` length to e.g. 64 chars; rate-limit per IP
(or per `proposal_id`, IP-pair) at the edge — Vercel Edge Middleware would do
this cheaply.

**1.4. `req.body` JSON not always re-parsed for raw-body routes** — *Low*

`api/stripe/[action].js` correctly disables `bodyParser` for the webhook and
manually re-parses for `checkout`/`verify`. But `api/views/[id].js:15-19`
parses `req.body` as either object **or** string — when it's a string and
`JSON.parse` fails, it silently treats the body as `{}`. The caller gets
"sessionId required" instead of "malformed JSON".

**Remediation**: distinguish "no body" from "malformed body" in the 400
response.

**1.5. Stripe `checkout` body fields trusted** — *Medium*

[api/stripe/[action].js:488-507](api/stripe/[action].js#L488-L507): `proposalId`,
`amount`, `partner`, `billing` come from the public client. `billing` is
persisted as JSONB without shape validation; a hostile client could store
arbitrary nested JSON keyed by `proposal_id`. The webhook then trusts
`billing.companyName` etc. when minting Xero contacts.

**Remediation**: explicit allowlist of `billing` keys; cap each string to
e.g. 256 chars; reject unknown keys.

**1.6. DOMPurify allowlist is fine** — *(no finding)*

[src/components/crm/DealDetailView.jsx:534-538, 595-599, 1418-1422](src/components/crm/DealDetailView.jsx#L534-L538):
forbids `style`/`script`/`iframe`/`object`/`embed`/`form` and `onerror`/`onload`/`onclick`.
The signature preview at line 1418 keeps inline `style` (intentional — Gmail
signatures rely on inline styles for layout). That's a reasonable tradeoff
given the source (the authed user's own Gmail account, not a third party).

**1.7. `actorEmail` not bound to authenticated user** — *Medium*

[api/crm/[...slug].js:1136](api/crm/[...slug].js#L1136) writes
`resolved_by = 'extension'`, fine. But several `deal_events` inserts trust
`payload.actorEmail` only because the route already took it from `user.email`.
Worth a comment policy — "never accept `actorEmail` from body" — to keep
future contributors safe. No exploit today.

---

## 2. Authentication

### State of play

Two token kinds flow through `requireAuth` ([api/_lib/middleware.js:10-32](api/_lib/middleware.js#L10-L32)):
session JWTs signed by `JWT_SECRET` (web app), and opaque extension tokens
stored hashed in `extension_tokens` (Chrome extension). 2FA uses TOTP +
email-OTP + backup codes, with a 30-day "trusted device" cookie. Gmail OAuth
refresh tokens are AES-256-GCM-encrypted at rest. Stripe webhook and Gmail
Pub/Sub push both verify their respective signatures. The auth foundation is
solid; the gaps are around **per-resource authorisation** (vertical access
control), not authentication.

### Findings

### 2.1. No ownership check on proposal mutations — **Critical**

[api/proposals/[...path].js:52-110](api/proposals/[...path].js#L52-L110):
`PUT /api/proposals/:id` and `DELETE /api/proposals/:id` only check
`requireAuth(req, res)`. **Any authed user (admin or member, web or extension
token) can overwrite the data of any proposal or delete it outright** simply
by knowing its ID. Proposal IDs are random-ish strings but they leak via
the public client URL the team sends to customers.

**Remediation**: tie write access to `proposal.data.preparedByEmail`
(matches `user.email` or `user.role === 'admin'`). If team-wide write access
is intended, document it explicitly and at minimum require `admin` for
DELETE.

### 2.2. Global settings mutable by any member — **Critical**

[api/settings.js:21-30](api/settings.js#L21-L30): the `PUT` calls only
`requireAuth(req, res)`. **Any authed user** can rewrite `extras_bank`,
`inclusions_bank`, and `notification_recipients` (the latter being the email
list that gets all "signed" / "paid" team notifications). A compromised
member account — or a disgruntled one — can silently redirect notifications
or pollute every new proposal's defaults.

**Remediation**: use `requireAdmin` instead of `requireAuth`. The helper
already exists in [api/_lib/middleware.js:34-42](api/_lib/middleware.js#L34-L42).

### 2.3. CRM deletes have no role or ownership checks — **High**

Spot-checked DELETE handlers, all reachable by any authed user:

- `companies` DELETE [api/crm/[...slug].js:185-188](api/crm/[...slug].js#L185-L188)
- `contacts` DELETE [api/crm/[...slug].js:263-266](api/crm/[...slug].js#L263-L266)
- `deals` DELETE — looking at the route at line 482, `actions.deleteDeal` posts but the auth path is just `requireAuth` (no admin/owner check inferred)
- `tasks` DELETE [api/crm/[...slug].js:922-925](api/crm/[...slug].js#L922-L925)
- `crm_email_templates` DELETE [api/crm/[...slug].js:1353-1356](api/crm/[...slug].js#L1353-L1356)
- `deal_files` DELETE [api/crm/[...slug].js:488-497](api/crm/[...slug].js#L488-L497)
- `signatures` DELETE [api/signatures/[id].js:12-17](api/signatures/[id].js#L12-L17)
- `payments` DELETE/POST [api/payments/[id].js:18-43](api/payments/[id].js#L18-L43)

Comments DELETE/PATCH ([api/crm/[...slug].js:713-738](api/crm/[...slug].js#L713-L738))
**does** check `created_by === user.email || user.role === 'admin'` — that's
the pattern the others should follow.

**Remediation**: introduce a per-resource ownership helper, or at minimum
`requireAdmin` on every DELETE. A small internal team can live with
`requireAdmin`; a larger team needs ownership tracking on rows that don't yet
have a `created_by`/`owner_email`.

### 2.4. Deal-file download URLs leak across the org — **High**

[api/crm/[...slug].js:479-486](api/crm/[...slug].js#L479-L486): generating a
signed download URL only checks `requireAuth` and `WHERE id = ${subaction} AND
deal_id = ${id}`. Any authed user can read **any** deal file by guessing
or knowing the deal+file IDs. Files are often client documents, contracts,
internal media — there's no expectation the whole team can pull anyone's deal
artifacts.

**Remediation**: gate behind the deal's `owner_email` (or a `deal_users`
sharing model if you need team visibility), then issue the signed URL with a
short TTL.

### 2.5. `bcrypt` cost factor 10 is mid-pack — *Low*

[api/auth/[action].js:177](api/auth/[action].js#L177): `bcrypt.hash(password, 10)`.
2026 best practice is 12 (≈250 ms on commodity hardware). At cost 10 a
modern attacker brute-forcing one of your hashes gets ~3000 attempts/sec
on a single GPU instance. Not catastrophic; raise on the next deploy.

**Remediation**: bump to 12 going forward. Existing hashes don't need rehashing.

### 2.6. No login rate-limit — *Medium*

[api/auth/[action].js:124-150](api/auth/[action].js#L124-L150): login is a
simple `bcrypt.compare`. The slow hash absorbs naive throughput attacks
(bcrypt is the rate-limit), but there's no per-IP / per-account lockout to
slow a credential-stuffing campaign that's already heavy.

**Remediation**: an `email_otps`-style table for failed-login attempts (or
just Upstash Redis with an exponential backoff). 5 wrong attempts per email
per 10 minutes is generous.

### 2.7. 2FA backup-code hash is plain SHA-256, no salt — *Low*

[api/_lib/twofactor.js:66-69](api/_lib/twofactor.js#L66-L69): backup codes
are 8 hex characters (4 bytes of entropy → 4 billion possibilities), hashed
with bare `SHA-256`. If a DB dump leaks the `users.backup_code_hashes` array,
an attacker can pre-compute all 4 billion codes in seconds and crack the
hash. The 2FA challenge token TTL is 5 minutes which limits exposure, but
this is still a one-pass attack.

**Remediation**: add a per-user salt, or move to a slow hash (argon2id with
a low memory cost since the input space is small). Easier: extend codes
to 10 hex chars and add a per-user pepper from `JWT_SECRET`.

### 2.8. JWT verify falls through to DB lookup on any failure — *Low*

[api/_lib/middleware.js:18-26](api/_lib/middleware.js#L18-L26): `try
verifyToken; catch fall-through to extension token lookup`. A garbled string
(`Bearer not-a-jwt`) costs a DB roundtrip per request. Not a leak, just
wasteful. If a session JWT expires, every subsequent request from that user
also costs a roundtrip until they reconnect.

**Remediation**: shape-check the token first (`/^ey[A-Za-z0-9_-]+\..+\..+/`
→ try JWT; `/^ext_/` → try DB; else 401 immediately).

### 2.9. Trusted-device cookie isn't bound to UA hash — *Low*

[api/_lib/twofactor.js:97-100](api/_lib/twofactor.js#L97-L100): the cookie
is `HttpOnly; Secure; SameSite=Lax` — good. But the `trusted_devices` row
only records `user_agent` as descriptive metadata; the token itself is good
on any browser that has it. If the cookie is exfiltrated (XSS — unlikely
given the React stack but possible via a future content-type bug), the
attacker bypasses 2FA on that account.

**Remediation**: bind the token hash to the UA fingerprint (or, more robust,
include the current `session.email` in the cookie body — currently the email
is looked up *by* the cookie, which means stolen-cookie + known-email is enough).

---

## 3. Data exposure

### State of play

Most write paths use `serialise*` helpers that project only the fields the UI
needs, so common columns (e.g. `password_hash`, `totp_secret`) don't leak.
The exceptions are read-mode-write SELECTs (`const cur = (await sql\`SELECT *
FROM <table> WHERE id = ${id}\`)[0]` — 14 places) where `cur` is discarded
after the patch — those don't leak. The real leaks are unauthenticated GETs.

### Findings

### 3.1. Unauthenticated payment-detail read — **Critical**

[api/payments/[id].js:11-16](api/payments/[id].js#L11-L16): GET has no auth.
Returns `customer_email`, `amount`, `receipt_url`, `stripe_session_id`,
`payment_type`, `paid_at`. Proposal IDs are not enumerable but they appear
in every email link sent to the client (e.g. `…/?proposal=<id>&thanks=1`),
in Stripe's success/cancel URLs, and in inbound mail subjects. **An attacker
who knows or guesses one ID gets the client's email + amount paid + Stripe
receipt URL.**

**Remediation**: require auth, or scope the public response to whatever the
client signing the proposal already sees on their thank-you screen (i.e.
`amount + paymentType` and nothing else).

### 3.2. Public proposal returns the full `data` blob — *Medium*

[api/proposals/[...path].js:34-46](api/proposals/[...path].js#L34-L46): the
public GET returns `...r.data` (the whole JSONB). Audit `data` for anything
the team writes server-side but the client shouldn't see:
- `preparedByEmail` — internal team email, exposed to client. Probably OK
  but worth a conscious decision.
- Any future "internal notes" field would leak by default — add an explicit
  allowlist of public fields rather than blanket-returning `data`.

**Remediation**: build a `publicProposalView(data)` projection that emits
*exactly* what `ClientView.jsx` consumes.

### 3.3. `signatures` GET is public — *Low*

[api/signatures/[id].js:19-24](api/signatures/[id].js#L19-L24): returns
signer `name`, `email`, `signed_at`, plus the entire `data` JSONB. Used by
the public client view to render the "you've signed" block, so it needs to
be public — but the `data` blob includes the client's full payment-option
choices, billing fields, etc. Not currently sensitive, but the door is open
to leaking anything future code stuffs into `signatures.data`.

**Remediation**: same projection pattern as 3.2.

### 3.4. Leaderboard exposes all user emails to all authed users — *Low*

[api/proposals/[...path].js:240](api/proposals/[...path].js#L240): `SELECT
email, name, avatar FROM users` — anyone with a session JWT (any role) gets
the entire team roster including emails. Acceptable inside a single
workspace but worth flagging in case the app grows to multi-tenant.

### 3.5. `proposal_views` retains IP + UA forever — *Medium*

[api/views/[id].js:38-48](api/views/[id].js#L38-L48): every proposal open
writes `ip_address, country, region, city, user_agent`. There's no retention
policy. Under GDPR/PECR these are personal data, and clients aren't told
their IP is being captured.

**Remediation**: privacy notice on the public proposal page; auto-prune
rows older than 12 months via a cron; consider IP truncation (`/24` for
IPv4) as the default, full IP only when an explicit consent flag is set.

### 3.6. Browser `localStorage` stores the session JWT — *Low*

[src/api.js:1-13](src/api.js#L1-L13): `squideo.jwt` in `localStorage`. JWT
is readable by any JS on the page — fine in normal operation, catastrophic
if an XSS lands. The stack is React (good), DOMPurify is used for the only
HTML-injection path I found (Gmail bodies), and there's no `dangerouslySetInnerHTML`
on untrusted content elsewhere. But the future risk is real.

**Remediation**: long-term, move to an `HttpOnly` cookie + `Set-Cookie` from
the login endpoint. Short-term, add a strict CSP header in `vercel.json`
(`Content-Security-Policy: default-src 'self'; script-src 'self'; …`).

---

## 4. Third-party risks

### State of play

External integrations: Gmail API + OAuth (Google), Stripe (payments, checkout,
subscriptions, webhooks), Xero (invoices/quotes), Resend (transactional mail),
Vercel Blob (deal files), Neon (Postgres), InboxSDK (Chrome extension runtime),
DOMPurify (client-side sanitisation).

### Findings

### 4.1. InboxSDK loads runtime code from `inboxsdk.com` — *Medium*

[extension/src/content/index.jsx:37-43](extension/src/content/index.jsx#L37-L43):
`InboxSDK.load(2, INBOXSDK_APP_ID, …)` reaches `inboxsdk.com` on every Gmail
page load. The npm package is just the loader; the actual Gmail-integration
code is fetched at runtime and runs in the page world via `pageWorld.js`.
A supply-chain compromise at InboxSDK would let attackers run arbitrary
code in every Squideo extension user's Gmail tab.

**Remediation**: this is a documented InboxSDK tradeoff; document it in
`extension/README.md` as a known dependency surface. Pin the loader version
(already done via package.json `^2.1.7`, currently 2.2.12 installed). If
sensitivity rises, evaluate replacing InboxSDK with hand-written Gmail DOM
integration (significant effort).

### 4.2. Xero token refresh has no retry on transient failure — *Low*

[api/_lib/xero.js:76-98](api/_lib/xero.js#L76-L98): one-shot retry on 401
only (token expired). Network blips / 429s / 503s throw immediately. The
Xero invoice push from the Stripe webhook is wrapped in a try/catch that
just logs and continues (intentional — webhook must always 200), so the
invoice is just lost. There's no retry queue.

**Remediation**: tiny exponential backoff inside `xeroFetch` for 429/5xx.
Alternative: a `failed_xero_pushes` table + nightly retry cron.

### 4.3. Resend send failures are silent — *Medium*

[api/_lib/email.js:25-30](api/_lib/email.js#L25-L30): `try { await c.emails.send(...) }
catch (err) { console.error(...) }`. Failed transactional emails (signed/paid
notifications, 2FA codes, task reminders) only leave a Vercel log line. The
calling code thinks it succeeded.

**Remediation**: bubble up the error so callers can decide; specifically for
2FA codes ([api/auth/[action].js:200-201](api/auth/[action].js#L200-L201)),
a silent email failure is a really bad UX — user is stuck on the verify
screen with no code coming.

### 4.4. Stripe webhook signature verification ✓ — *(no finding)*

[api/stripe/[action].js:340-351](api/stripe/[action].js#L340-L351): correctly
uses `stripe.webhooks.constructEvent(rawBody, signature, secret)`. `bodyParser:
false` is set, raw body collected from the stream.

### 4.5. Gmail Pub/Sub JWT verification ✓ — *(no finding)*

[api/_lib/gmailSync.js:8-19](api/_lib/gmailSync.js#L8-L19) plus
[api/crm/[...slug].js:2237-2249](api/crm/[...slug].js#L2237-L2249): correctly
verifies the Google-signed JWT with `audience` + `issuer` checks against
Google's JWKS. Good.

### 4.6. Stripe Checkout success/cancel URLs hardcoded — *Low*

[api/stripe/[action].js:510-512](api/stripe/[action].js#L510-L512):
`https://app.squideo.com/?proposal=…` is the literal URL (was previously the raw Vercel URL — domain migrated 2026-05-15).
The same string appears at least three more times in `api/crm/[...slug].js`
(the extension's host_permission too). Domain change requires a code edit
in 5+ places.

**Remediation**: route everything through `APP_URL` (env var) — that's the
pattern `api/_lib/email.js` uses.

### 4.7. Vercel Blob `getDownloadUrl` TTL not specified — *Low*

[api/crm/[...slug].js:484](api/crm/[...slug].js#L484): default Blob signed-URL
TTL. Combined with 2.4 (no per-deal ACL), the issue is that even after a user
loses access, any signed URL they pulled is good until its default expiry.

**Remediation**: shortest-acceptable TTL on the signed URL (Vercel allows
specifying it).

---

## 5. Module boundaries

### State of play

The split between web SPA (`src/`), API (`api/`), and Chrome extension
(`extension/`) is mostly clean. No cross-imports observed between SPA and
API. The extension intentionally duplicates a few constants (theme, stage
colour mapping) rather than importing from `src/` — defensible because of
build isolation, but it's the source of the drift caught in §5.1.

### Findings

### 5.1. Fourth duplicated `STAGE_COLOURS` map in the extension — **High**

[extension/src/content/ComposeBar.jsx:22-31](extension/src/content/ComposeBar.jsx#L22-L31)
still has the **old** stage names (`qualified`, `quoting`, `sent`). The
fix from earlier today updated three of the four files (`index.jsx`,
`BoxesNav.jsx`, `Sidebar.jsx`). `ComposeBar.jsx` was missed. Effect:
the deal-picker pill in the in-Gmail compose bar shows the wrong colour
(falls back to `lead` slate) for any deal in `responded` / `proposal_sent` /
`long_term`.

**Remediation**: sync `ComposeBar.jsx`'s map with the others; better, extract
all four into `extension/src/lib/stages.js` and import from one place.

### 5.2. `STAGE_COLOURS` duplicated 4× in the extension and 1× implicitly in the web app — *Medium*

The web app uses `PIPELINE_STAGES` ([src/components/crm/PipelineView.jsx:8-17](src/components/crm/PipelineView.jsx#L8-L17))
with `color` (single value) — the extension files use `STAGE_COLOURS` with
`{ bg, fg }` (two values). Both encode the same business concept; both will
drift again the next time stages change.

**Remediation**: hoist a single `src/lib/stages.js` (or top-level `shared/stages.js`
sym-linked / re-exported by both bundles). Web app derives `bg/fg` from
`color` via a small function; extension imports the same.

### 5.3. `api/crm/[...slug].js` mixes 10 unrelated resources — *Medium*

Companies, contacts, deals, tasks, gmail-oauth, gmail-send, gmail-pubsub,
gmail-backfill, triage, emails, threads, templates, comments, cron — all in
one file ([api/crm/[...slug].js](api/crm/[...slug].js)). Vercel Hobby's
12-function cap (now moot on Pro) drove the consolidation, but the file is
now 2346 lines. The natural splits are obvious from the switch at line 118.

**Remediation**: split into per-resource files under `api/_lib/crm/` (helpers,
not new routes — so the Vercel function count stays 1), then the slug router
becomes a 50-line dispatcher. See §9.1.

### 5.4. Triage / Pipeline / Deal detail share three different deal-mutation paths — *Low*

[src/store.jsx](src/store.jsx) has `saveDeal`, `moveDealStage`, `deleteDeal`,
`triageAssign`, plus `loadDealDetail` that re-fetches afterwards. We just
fixed `saveDeal` not patching `dealDetail`. There may be other places where
the optimistic path forgets the secondary cache.

**Remediation**: a single `updateDealLocal(state, dealId, patch)` helper that
patches both `state.deals` and `state.dealDetail` consistently. Replace ad-hoc
spreads in all five mutation actions.

### 5.5. Extension `host_permissions` includes the production Vercel domain — *Low*

[extension/manifest.json:11-14](extension/manifest.json#L11-L14): the extension's
host permission for the API is hardcoded to `app.squideo.com` (migrated from
the raw Vercel URL 2026-05-15). A future domain switch requires a manifest
change → resubmit to Web Store.

**Remediation**: keep this in mind for any future domain migration — update
the manifest **before** Stripe/Resend/Gmail callbacks switch over; otherwise
the extension breaks for everyone overnight.

---

## 6. Dependencies

### State of play

Root: 15 prod deps, 2 dev deps. Extension: 3 prod deps, 3 dev deps. All
within recent major-version ranges. No abandoned upstreams observed. `npm
audit` could not run (see audit caveat at top).

### Findings

### 6.1. `recharts` 2.13.0 — *Low*

Latest 2.x as of Aug 2025 was 2.13.0 — current. Bundle weight is significant
(~120KB minified) for the leaderboard chart; consider lazy-loading if you
want to shrink the main bundle (see §9.4).

### 6.2. `stripe` 22.x — *(no finding)*

[package.json:18](package.json#L18) — `stripe: ^22.1.0`. Stripe ships
frequently; the 22.x line is current and bug-fix-supported.

### 6.3. `bcryptjs` instead of `bcrypt` (native) — *Low*

[package.json:9](package.json#L9) — `bcryptjs: ^3.0.3`. Pure-JS impl is
~30% slower than the native binding but avoids Vercel build-time native
compilation headaches. Acceptable tradeoff at current scale.

### 6.4. `@inboxsdk/core` 2.2.12 (extension) — *Low*

Pinned to `^2.1.7` in `extension/package.json`; 2.2.12 is currently installed.
Latest npm-published version per our earlier check. No CVEs known.

### 6.5. `dompurify` 3.4.2 — *(no finding)*

Up-to-date. Same major as latest at audit cutoff.

### 6.6. **Could not verify CVE status** — *Medium (audit gap, not codebase)*

Local `npm audit` fails with TLS error. Run on a clean network:
```bash
npm audit --omit=dev
cd extension && npm audit --omit=dev
```
Then add any High/Critical findings here.

### 6.7. No automated dependency update path — *Low*

No Renovate / Dependabot config in the repo. New CVEs in any of the 18+ deps
won't surface until someone manually runs `npm audit`.

**Remediation**: a Renovate (or GitHub Dependabot) config at the repo root
that opens PRs for security patches. Free, low-noise if scoped to security
updates only.

---

## 7. Logging & monitoring

### State of play

All logging goes to `console.log` / `console.error` / `console.warn`, captured
by Vercel's function logs. No APM, no error aggregator, no structured logs,
no alerting. For a product with paid customers this is below the bar.

### Findings

### 7.1. Silent failure paths in cron + Pub/Sub handlers — **High**

[api/crm/[...slug].js:2271, 2286, 2296, 2309, 2327, 2332](api/crm/[...slug].js#L2271):
`gmailPush` returns `{ ok: true, skip: '…' }` or `{ ok: false, error: '…' }`
with HTTP **200** in every case — because Pub/Sub will retry on non-200.
That's the right HTTP behaviour, but the JSON body never reaches anyone.
A token refresh failure (`'token-refresh-failed'`) silently breaks Gmail sync
for one user until they reconnect.

**Remediation**: extract a `logEvent({ kind, severity, …meta })` helper that
also writes to a `system_events` table. Critical events (auth disconnect,
Stripe webhook signature fail, repeated Gmail token refresh fail) trigger an
email to an `OPS_ALERT_EMAIL` env var. Cheaper than Sentry, good enough for
this scale.

### 7.2. 87 silent `.catch(() => {})` or `catch {}` in `src/` and `api/` — *Medium*

Sample (full list via `grep -rEn "\.catch\(\(\) =>" api/ src/`):
- [src/store.jsx:134-143](src/store.jsx#L134-L143): every initial fetch in
  `fetchAll` silently turns errors into `{}` / `[]`. Result: when the user's
  session expires mid-session, the UI shows an empty state instead of
  prompting re-auth.
- [src/store.jsx:169-173](src/store.jsx#L169-L173): per-proposal
  signature/payment fetches silently swallow 401s.
- [api/extension/[action].js:133](api/extension/[action].js#L133): the
  cleanup query suppresses all errors (low-stakes, fine).

**Remediation**: split into "errors I expect" (404 for "no signature on this
proposal" → empty) vs "errors I don't" (401 → re-auth prompt, 5xx → toast).
The blanket `() => null` cliff is the worst of both worlds.

### 7.3. Stripe webhook logs are inconsistent — *Medium*

[api/stripe/[action].js:349-350](api/stripe/[action].js#L349-L350): on
signature-verify failure, returns 400 with a short message — no log line.
Pub/Sub handler does the same (line 2247). If someone is probing your
webhook endpoint, you'd never see it.

**Remediation**: `console.warn('[stripe webhook] signature verify failed',
{ ip, sig: req.headers['stripe-signature']?.slice(0, 16) })` before the
return. Same for Gmail push.

### 7.4. No structured/JSON logging — *Low*

All log lines are plain strings. Vercel doesn't aggregate by event type, so
querying "how many Gmail token refreshes failed last week" requires
text-grep through the logs UI.

**Remediation**: a tiny `_lib/log.js` that emits `console.log(JSON.stringify({
ts, level, msg, ...ctx }))` so Vercel's log viewer / Logflare / Axiom can
filter by structured fields.

### 7.5. No request-level metrics — *Low*

You won't know which API routes are slow until users complain. Vercel does
expose function duration in its UI but it's pull-based.

**Remediation**: optional. Vercel Analytics is one click; OpenTelemetry would
be overkill at this size.

---

## 8. Test coverage

### State of play

```
$ find . -name "*.test.*" -not -path "./node_modules/*"
(no results)
$ find . -name "*.spec.*" -not -path "./node_modules/*"
(no results)
$ grep '"test"' package.json
(no match)
```

### Findings

### 8.1. No tests anywhere — **High**

Confirmed: zero `.test.js`, `.spec.js`, `__tests__/`, no `test` script in
either `package.json`. The codebase is ~6700 lines of API code alone, with
several Lewis-Carroll-style multi-step business flows (Stripe webhook → Xero
invoice → email → CRM advance, Gmail Pub/Sub → ingest → resolver → DB writes,
proposal sign → email fan-out → deal stage). One regression in any of these
will hit production undetected.

**Remediation**: start with **regression-catching** tests on the auto-link
resolver (`resolveDealForMessage` in [api/_lib/gmailSync.js:207-280](api/_lib/gmailSync.js#L207-L280))
— it's pure with DB queries that can be mocked, has 5 numbered rules, and is
where the auto-link logic will subtly drift first. Vitest + a `pg-mem` (or
SQL-string-snapshot) shim, 1–2 days of work. Add tests *as you change those
modules* rather than backfilling everything.

### 8.2. Highest-value targets — *(plan)*

Priority order:

1. [api/_lib/gmailSync.js](api/_lib/gmailSync.js) — `resolveDealForMessage`,
   `parseAddressList`, `extractBody` parsers.
2. [api/_lib/dealStage.js](api/_lib/dealStage.js) — `advanceStage` ratchet
   logic. Three branches, easy to break, used by 4 different writers.
3. [api/stripe/[action].js](api/stripe/[action].js) — webhook event dispatch
   (mock Stripe events fixtures from `stripe-mock` / hand-written).
4. [api/_lib/middleware.js](api/_lib/middleware.js) `requireAuth` — JWT path,
   extension-token path, 401 path.
5. [api/_lib/xeroMappers.js](api/_lib/xeroMappers.js) — line-item builders.
   Pure functions, trivial to unit test.

### 8.3. No type checking — *Medium*

No TypeScript, no JSDoc-with-checkJs, no Flow. With 6700 LOC of JS in `api/`
and ~5000 LOC of JSX in `src/`, every refactor relies on grep + memory. A
gradual TS migration (or `// @ts-check` at the top of `_lib` files) would
catch a class of bugs.

**Remediation**: out of scope for this audit; flag for future planning.

---

## 9. Technical debt

### State of play

The codebase is young (commits indicate active development through 2026).
Most of the debt is structural: a few mega-files, a few duplicated constants,
and one or two patterns that wouldn't survive a 5x growth in feature count.

### Findings

### 9.1. The CRM mega-file — *Medium*

[api/crm/[...slug].js](api/crm/[...slug].js) is **2346 lines** and routes
10+ resources through one switch statement at [line 119](api/crm/[...slug].js#L119).
Every time you add a feature you scroll to a new section, paste a new `case`,
and pray you don't break the layout. Test coverage is impossible in this
shape (see §8.1). Find/replace in the file is risky.

**Remediation**: keep it as a **single Vercel function** (route file) so the
function-count cap isn't impacted, but extract per-resource handler functions
into `api/_lib/crm/<resource>.js`. The route file becomes a thin dispatcher:

```js
import { companiesRoute } from '../_lib/crm/companies.js';
// …
switch (resource) {
  case 'companies': return companiesRoute(req, res, ...);
  // …
}
```

Each helper is then independently testable and editable.

### 9.2. `store.jsx` optimistic-update pattern is hand-rolled per action — *Medium*

[src/store.jsx](src/store.jsx) — 788 lines, ~30 action functions. The pattern
"setState optimistically → call API → setState on response → catch swallow"
is repeated everywhere. We just patched `saveDeal` to also patch
`dealDetail`. There are siblings (`saveContact`, `saveCompany`, etc.) that
likely have the same bug latent.

**Remediation**: a `mutate(setState, optimisticPatch, apiCall, onSuccess?)`
helper that handles the dual-cache update + rollback uniformly. Even better,
a reducer-driven store (zustand / valtio) — but that's larger surgery.

### 9.3. `SELECT *` everywhere in the CRM file — *Low*

21 `SELECT *` matches in `api/crm/[...slug].js`. Every one is fed into a
`serialise*` helper that projects only the needed fields, so this isn't an
exposure today — but a schema addition (e.g. an `internal_notes` column on
`deals`) would silently flow through to the API response of the related route
the next time someone read-modify-writes.

**Remediation**: replace `SELECT *` with the explicit column list per query
where it matters (especially `deals` since deals are read by extension chips
too).

### 9.4. Bundle size — no code-splitting — *Medium*

Vite build output (just ran):
```
dist/assets/index-XXXXXX.js   943.57 kB  │ gzip: 272.88 kB
```
A single bundle includes the entire admin SPA, the CRM, the proposal builder,
and the public client viewer. **The public client viewer loads all of it on
every proposal open.** Recharts is ~120KB minified just for the leaderboard
that 99% of clients never see.

**Remediation**: route-based code splitting — `React.lazy()` the admin/CRM
views, eager-load only the public-proposal path. `recharts` should be
dynamically imported inside `LeaderboardView`. Realistic targets: ~150KB
gzipped on the public path, full bundle ~270KB only for authed users.

### 9.5. The extension's `STAGE_COLOURS` duplication — *Medium*

Already covered in §5.1 and §5.2 — listed here as well because it's the
canonical example of "constant drift". Treat it as a debt-priority item not
just a boundary issue.

### 9.6. Inline `style={{ … }}` everywhere — *Low*

Most components use inline `style` objects rather than the `BRAND` constants
or CSS classes. `DealDetailView.jsx` alone has ~80 inline-style blocks. Not
broken, just repetitive — the day you want to support a theme toggle, this
is a week-long refactor.

**Remediation**: not urgent; could batch into a "theme tokens → CSS variables"
follow-up.

### 9.7. Legacy stage names in `DEPLOYMENT-GUIDE.md` — *Low*

[DEPLOYMENT-GUIDE.md:317-319](DEPLOYMENT-GUIDE.md#L317-L319): backfill SQL
maps unviewed proposals to stage `'quoting'`. That stage was renamed to
`'proposal_sent'` in commit cdd38f3. New deployers running the docs verbatim
will set stages that no longer match the UI's `STAGE_BY_ID`.

**Remediation**: rewrite the inline migrations to point at `db/migrations/`
files (which already exist) and remove the embedded SQL.

---

## 10. Environment, docs, perf, consistency

This section folds in performance and code-consistency notes (which the user
also asked about) since they overlap with environment/docs/setup concerns.

### Findings

### 10.1. Env var inventory — *(no finding, reference)*

All `process.env.X` referenced in API + extension code:
```
APP_URL              BLOB_READ_WRITE_TOKEN  CRON_SECRET
DATABASE_URL         GMAIL_PUBSUB_TOPIC     GMAIL_PUSH_AUDIENCE
GMAIL_TOKEN_KEY      GOOGLE_CLIENT_ID       GOOGLE_CLIENT_SECRET
JWT_SECRET           MAIL_FROM              RESEND_API_KEY
STRIPE_SECRET_KEY    STRIPE_WEBHOOK_SECRET  XERO_CLIENT_ID
XERO_CLIENT_SECRET   XERO_REDIRECT_URI
```
17 vars. None are documented in one place. Several fail noisily if missing
(e.g. `GMAIL_TOKEN_KEY` — see [api/_lib/gmailTokens.js:6-9](api/_lib/gmailTokens.js#L6-L9));
others fail silently (`RESEND_API_KEY` missing → emails just skipped with a
warn — [api/_lib/email.js:21-24](api/_lib/email.js#L21-L24)).

### 10.2. No dev/staging/prod environment separation — *Medium*

Nothing in `vercel.json`, `package.json`, or docs indicates a non-prod
environment. Vercel Preview Deployments (every PR) will hit **prod Neon, prod
Stripe, prod Gmail OAuth, prod Resend** unless the env vars are scoped per
environment in the Vercel dashboard. If those are all prod-scoped, every
preview deploy can move real money and send real emails.

**Remediation**: confirm in the Vercel dashboard that Preview/Development
have separate values for `DATABASE_URL` (a Neon branch), `STRIPE_SECRET_KEY`
(Stripe test mode), `RESEND_API_KEY` (Resend test/dev account). Document
this in `DEPLOYMENT-GUIDE.md`.

### 10.3. `vercel.json` and cron config — *Low*

[vercel.json](vercel.json) sets `maxDuration: 10` for every function. The
plan was Pro (verified — see memory). On Pro, functions can go up to 60s.
The 10s ceiling means the Gmail backfill chain
([api/crm/[...slug].js:2038-2041](api/crm/[...slug].js#L2038-L2041))
specifically budgets 7s to stay safe — pure constraint inheritance from the
Hobby era. Could be relaxed.

**Remediation**: `maxDuration: 60` per-function for `api/crm/gmail/*` and
`api/stripe/webhook` (longer Xero pushes). Keep the rest at 10s as a default
ceiling.

### 10.4. `README.md` is a prototype-era relic — **High**

[README.md](README.md) describes the project as a localStorage-only prototype
with simulated payments, no real email, and `squideo.store.v1` in
`localStorage`. None of that is true since the Neon/Vercel migration.
Onboarding a new dev with this README would actively mislead them.

**Remediation**: rewrite. The current state needs ~20 lines: what the project
is (React SPA + Vercel API + Neon Postgres + Chrome extension), how to set
up locally (point to `MAKING-CHANGES.md`), where production lives, where
to find architecture (point to `DEPLOYMENT-GUIDE.md`).

### 10.5. `DEPLOYMENT-GUIDE.md` migrations live as inline blockquotes — *Medium*

[DEPLOYMENT-GUIDE.md:131-472](DEPLOYMENT-GUIDE.md): every schema change since
the initial deploy is documented as a > blockquote in this file. Meanwhile
[db/migrations/](db/migrations/) exists with 4 SQL files. The two are not in
sync — the inline guide is missing migrations for 2FA, deal_comments,
deal_files, gmail_signature, Xero, Stripe, partner programme columns added
later, etc.

**Remediation**: declare `db/migrations/` the single source of truth. Replace
the deployment guide's inline SQL with a "run every file in
`db/migrations/` in alphabetical order" instruction. Move the genuinely
useful narrative (what each phase is for) into per-file SQL comments at the
top of each migration.

### 10.6. `extension/README.md` references the wrong build config — *Low*

[extension/README.md:39](extension/README.md#L39): "vite.config.js" — there's
no `vite.config.js` in the extension; the build is driven by `build.js`
([extension/build.js](extension/build.js)).

**Remediation**: one-line edit.

### 10.7. Deal-detail handler runs 6 queries in parallel — *(no finding)*

[api/crm/[...slug].js:552-588](api/crm/[...slug].js#L552-L588): `Promise.all`
fans out proposals/events/tasks/emails/files/comments fetches. Truly parallel,
all single-key indexed lookups. Good.

### 10.8. Triage list query is O(N) per user — *Low*

[api/crm/[...slug].js:958-971](api/crm/[...slug].js#L958-L971): scans
`email_messages` filtered by `unmatched = TRUE AND internal_only = FALSE
AND user_email = …`. Index on `(user_email)` exists for the partial
`WHERE unmatched`. Should be fine until the unmatched backlog grows huge.

### 10.9. Bundle and JS size on public proposal — covered in §9.4.

### 10.10. Naming and error-shape consistency — *Low*

API responses inconsistently use `{ error: '...' }` (most routes) vs the
occasional `{ message: '...' }` — quick grep shows `error` is the dominant
shape, only the cron success returns `{ ok: true, found, sent }` vs other
"OK" shapes like `{ ok: true }`. Frontend assumes `error` key
([src/api.js:29](src/api.js#L29)) — if a future route uses `message`,
the user sees `Request failed` instead of the real reason.

**Remediation**: codify `{ error: string, code?: string }` as the failure
shape in every route. Document in a top-of-file comment in
`api/_lib/middleware.js`.

### 10.11. Resource naming: camelCase JSON ↔ snake_case columns — *(no finding)*

Pattern is consistent: DB is snake_case, API JSON is camelCase,
`serialise*` helpers do the conversion. Good.

### 10.12. Component file structure — *Low*

`src/components/` mixes feature components (`BuilderView`, `ClientView`,
`AuthScreen`) with shared UI (`ui.jsx`, `Avatar.jsx`) at the same level.
`crm/` is the only sub-folder. As more features land, every component
sharing the root makes "where does this go" decisions ambiguous.

**Remediation**: at 30+ components, group: `components/proposals/`,
`components/auth/`, `components/billing/`, `components/shared/`.

---

## Appendix — file index

Files referenced in this audit, grouped by audit section. Use Ctrl/Cmd-click
in VS Code.

### §1 Input validation
- [api/crm/[...slug].js](api/crm/[...slug].js)
- [api/views/[id].js](api/views/[id].js)
- [api/stripe/[action].js](api/stripe/[action].js)
- [src/components/crm/DealDetailView.jsx](src/components/crm/DealDetailView.jsx)

### §2 Authentication
- [api/_lib/middleware.js](api/_lib/middleware.js)
- [api/_lib/auth.js](api/_lib/auth.js)
- [api/_lib/twofactor.js](api/_lib/twofactor.js)
- [api/_lib/extension.js](api/_lib/extension.js)
- [api/_lib/gmailTokens.js](api/_lib/gmailTokens.js)
- [api/auth/[action].js](api/auth/[action].js)
- [api/proposals/[...path].js](api/proposals/[...path].js)
- [api/settings.js](api/settings.js)
- [api/payments/[id].js](api/payments/[id].js)
- [api/signatures/[id].js](api/signatures/[id].js)
- [api/extension/[action].js](api/extension/[action].js)
- [api/crm/[...slug].js](api/crm/[...slug].js)

### §3 Data exposure
- [api/payments/[id].js](api/payments/[id].js)
- [api/proposals/[...path].js](api/proposals/[...path].js)
- [api/signatures/[id].js](api/signatures/[id].js)
- [api/views/[id].js](api/views/[id].js)
- [src/api.js](src/api.js)

### §4 Third-party risks
- [api/_lib/xero.js](api/_lib/xero.js)
- [api/_lib/email.js](api/_lib/email.js)
- [api/_lib/gmailSync.js](api/_lib/gmailSync.js)
- [api/stripe/[action].js](api/stripe/[action].js)
- [extension/src/content/index.jsx](extension/src/content/index.jsx)

### §5 Module boundaries
- [extension/src/content/ComposeBar.jsx](extension/src/content/ComposeBar.jsx)
- [extension/src/content/Sidebar.jsx](extension/src/content/Sidebar.jsx)
- [extension/src/content/BoxesNav.jsx](extension/src/content/BoxesNav.jsx)
- [extension/src/content/index.jsx](extension/src/content/index.jsx)
- [extension/manifest.json](extension/manifest.json)
- [src/components/crm/PipelineView.jsx](src/components/crm/PipelineView.jsx)
- [src/store.jsx](src/store.jsx)
- [api/crm/[...slug].js](api/crm/[...slug].js)

### §6 Dependencies
- [package.json](package.json)
- [extension/package.json](extension/package.json)

### §7 Logging
- [api/crm/[...slug].js](api/crm/[...slug].js) (esp. gmailPush + cron)
- [api/stripe/[action].js](api/stripe/[action].js)
- [api/_lib/email.js](api/_lib/email.js)
- [src/store.jsx](src/store.jsx)
- [src/api.js](src/api.js)

### §8 Tests
- [api/_lib/gmailSync.js](api/_lib/gmailSync.js)
- [api/_lib/dealStage.js](api/_lib/dealStage.js)
- [api/_lib/xeroMappers.js](api/_lib/xeroMappers.js)
- [api/_lib/middleware.js](api/_lib/middleware.js)
- [api/stripe/[action].js](api/stripe/[action].js)

### §9 Technical debt
- [api/crm/[...slug].js](api/crm/[...slug].js)
- [src/store.jsx](src/store.jsx)
- [extension/src/content/ComposeBar.jsx](extension/src/content/ComposeBar.jsx)
- [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md)

### §10 Environment / docs / perf / consistency
- [README.md](README.md)
- [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md)
- [MAKING-CHANGES.md](MAKING-CHANGES.md)
- [extension/README.md](extension/README.md)
- [vercel.json](vercel.json)
- [db/migrations/](db/migrations/)
- [src/api.js](src/api.js)
