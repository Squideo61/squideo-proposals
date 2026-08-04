-- The Explainer Video Crash Course — an 8-part lead magnet.
--
-- Module 1 plays free to anonymous visitors on /course; modules 2-8 need a
-- portal account, which the course page creates self-serve (the first place in
-- the product that does — everywhere else is invite-only).
--
-- Videos live in the PUBLIC revision blob store, the same one draft cuts use,
-- so they stream straight from a <video> tag. Bytes for a locked module are
-- only ever handed out through the portal's download route, which checks the
-- session; the anonymous /api/course payload is built by a serialiser that
-- structurally cannot emit a URL for a non-free module.
--
-- These objects are also self-healed at runtime (ensureCourseTables in
-- api/_lib/course/db.js) because migrations are applied by hand in Neon.

-- The 8 videos. `free` marks the one that plays without an account (module 1);
-- `published` gates whether it appears at all, so the page can go live with
-- module 1 while the rest are still uploading.
CREATE TABLE IF NOT EXISTS course_modules (
  id                TEXT        PRIMARY KEY,
  slug              TEXT        NOT NULL UNIQUE,
  module_number     INTEGER     NOT NULL,
  title             TEXT        NOT NULL,
  subtitle          TEXT,
  description       TEXT,
  blob_url          TEXT,
  blob_pathname     TEXT,
  mime_type         TEXT,
  size_bytes        BIGINT,
  duration_seconds  INTEGER,
  poster            TEXT,          -- base64 JPEG data URL, served as bytes
  poster_updated_at TIMESTAMPTZ,
  free              BOOLEAN     NOT NULL DEFAULT FALSE,
  published         BOOLEAN     NOT NULL DEFAULT FALSE,
  sort_order        INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS course_modules_order_idx
  ON course_modules ((COALESCE(sort_order, module_number)));

-- Per-viewer watch state. furthest_seconds is a high-water mark used to resume
-- and to decide completion (>=90%); seconds_watched is cumulative and only for
-- reporting. Written by a 15s heartbeat, so it must stay cheap.
CREATE TABLE IF NOT EXISTS course_progress (
  portal_user_id   TEXT        NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  module_id        TEXT        NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
  furthest_seconds INTEGER     NOT NULL DEFAULT 0,
  seconds_watched  INTEGER     NOT NULL DEFAULT 0,
  duration_seconds INTEGER,
  view_count       INTEGER     NOT NULL DEFAULT 0,
  first_viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_viewed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  PRIMARY KEY (portal_user_id, module_id)
);

CREATE INDEX IF NOT EXISTS course_progress_user_idx ON course_progress(portal_user_id);

-- One row per person who signed up for the course. Deliberately separate from
-- portal_users: it holds the marketing-consent evidence and the first-touch
-- attribution snapshot, neither of which belongs on an auth record.
--
-- attr_* columns are added by ensureLeadAttribution('course_signups') at
-- runtime — the same 20 columns quote_requests carries, so pickAttribution()
-- and deriveChannel() are reused unchanged.
CREATE TABLE IF NOT EXISTS course_signups (
  id                TEXT        PRIMARY KEY,
  email             TEXT        NOT NULL,
  name              TEXT,
  company_name      TEXT,
  portal_user_id    TEXT        REFERENCES portal_users(id) ON DELETE SET NULL,
  contact_id        TEXT        REFERENCES contacts(id) ON DELETE SET NULL,
  company_id        TEXT        REFERENCES companies(id) ON DELETE SET NULL,
  marketing_consent BOOLEAN     NOT NULL DEFAULT FALSE,
  consent_text      TEXT,        -- verbatim wording they were shown
  consent_ip        TEXT,
  consent_at        TIMESTAMPTZ,
  consent_source    TEXT,
  completed_at      TIMESTAMPTZ, -- finished all 8
  hot_notified_at   TIMESTAMPTZ, -- claimed once, so sales is alerted a single time
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS course_signups_email_idx ON course_signups(LOWER(email));
CREATE INDEX IF NOT EXISTS course_signups_user_idx ON course_signups(portal_user_id);

-- The anonymous half of the funnel: page views and free-video plays that happen
-- BEFORE anyone signs up. visitor_key is a random per-tab value held in
-- sessionStorage — no cookie, nothing that identifies a person.
CREATE TABLE IF NOT EXISTS course_events (
  id          TEXT        PRIMARY KEY,
  visitor_key TEXT,
  event_key   TEXT        NOT NULL,   -- page_view | play | progress | signup_open
  module_id   TEXT,
  detail      JSONB,
  country     TEXT,
  city        TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS course_events_at_idx ON course_events(created_at DESC);
CREATE INDEX IF NOT EXISTS course_events_key_idx ON course_events(event_key, created_at DESC);

-- Signup rate limit, same shape as portal_failed_logins: a counter per
-- (ip, hour-window), rows older than the window are simply ignored.
CREATE TABLE IF NOT EXISTS course_signup_throttle (
  ip           TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  attempts     INTEGER     NOT NULL DEFAULT 1,
  PRIMARY KEY (ip, window_start)
);

-- Companies created by self-serve course signup are PROSPECTS, not clients.
-- They exist only to anchor a portal_memberships row (requirePortalAuth 403s
-- without one). They are excluded from the CRM companies bootstrap by default,
-- or the Organisations tab and every company picker drown at a few hundred
-- signups. Staff merge a prospect into a real org if they convert.
--
-- NB: self-serve signup must NEVER resolve an EXISTING company by email domain
-- — that would let anyone at acme.co.uk sign up for the course and land inside
-- ACME's real client portal. It only ever creates a fresh prospect row.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS prospect BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS source TEXT;
CREATE INDEX IF NOT EXISTS companies_prospect_idx ON companies(prospect) WHERE prospect;

-- Which lead magnet a quote request came through. A NEW DIMENSION, deliberately
-- not a new attr_channel value: attr_channel is a fixed enum consumed by the
-- Marketing funnel, and overwriting it with 'course' would destroy the real
-- channel — a course lead that started as a Google Ads click would stop
-- counting as paid_search and silently corrupt CPL and ROAS.
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS lead_magnet TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS course_signup_id TEXT;
CREATE INDEX IF NOT EXISTS quote_requests_lead_magnet_idx ON quote_requests(lead_magnet)
  WHERE lead_magnet IS NOT NULL;
