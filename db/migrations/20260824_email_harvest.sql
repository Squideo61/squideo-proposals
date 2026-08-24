-- Gmail harvest runs — sweeping the WHOLE mailbox for enquiries that predate
-- the CRM, resumably.
--
-- The first version of this did the search inside one request and stopped at
-- 500 messages, which on a busy mailbox is a couple of months. A ten-year
-- mailbox needs a job that survives the request that started it: ids are listed
-- once and stored, then worked through a batch at a time by a cron until
-- there's nothing left. Progress is on the run row, so closing the tab (or a
-- failed invocation) costs nothing.

CREATE TABLE IF NOT EXISTS email_harvest_runs (
  id            TEXT        PRIMARY KEY,
  user_email    TEXT        NOT NULL,           -- whose mailbox is being read
  query         TEXT        NOT NULL,           -- the Gmail search
  ingest        BOOLEAN     NOT NULL DEFAULT FALSE,  -- also file the emails into the CRM?
  status        TEXT        NOT NULL DEFAULT 'listing', -- listing|working|done|cancelled|failed
  page_token    TEXT,                           -- where the id listing got to
  listed        INTEGER     NOT NULL DEFAULT 0,
  processed     INTEGER     NOT NULL DEFAULT 0,
  ingested      INTEGER     NOT NULL DEFAULT 0,
  failed        INTEGER     NOT NULL DEFAULT 0,
  error         TEXT,
  started_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS email_harvest_runs_status_idx ON email_harvest_runs (status);

-- The work queue: every message id the search matched. Claimed in batches, so
-- overlapping cron runs can't read the same message twice.
CREATE TABLE IF NOT EXISTS email_harvest_messages (
  run_id           TEXT NOT NULL REFERENCES email_harvest_runs(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'queued',  -- queued|working|done|failed
  PRIMARY KEY (run_id, gmail_message_id)
);
CREATE INDEX IF NOT EXISTS email_harvest_messages_state_idx
  ON email_harvest_messages (run_id, state);

-- One row per person the sweep found, folded across all their messages, with
-- the evidence that makes them reviewable.
CREATE TABLE IF NOT EXISTS email_harvest_people (
  run_id       TEXT NOT NULL REFERENCES email_harvest_runs(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  name         TEXT,
  messages     INTEGER NOT NULL DEFAULT 0,
  first_at     TIMESTAMPTZ,
  last_at      TIMESTAMPTZ,
  last_subject TEXT,
  thread_id    TEXT,
  imported_at  TIMESTAMPTZ,
  PRIMARY KEY (run_id, email)
);
CREATE INDEX IF NOT EXISTS email_harvest_people_last_idx
  ON email_harvest_people (run_id, last_at DESC);
