-- Video credit allocations — a production manager earmarking a slice of the
-- CLIENT'S company-wide video-credit balance against a specific video, before
-- that video has started (often before the deal is even in production).
--
-- Why a table of its own rather than another row in an existing ledger:
--
--  · partner credits (credit_allocations) has no notion of "promised but not
--    yet consumed" — a kind='work' row is spent the moment it exists, so a
--    reservation written there would drop the client's balance for work nobody
--    has started, and there'd be no way to hand it back if the video is
--    dropped.
--  · project_retainers is a per-DEAL pot the client bought for that project.
--    Company-wide portal credit isn't that, and forcing it into a retainer
--    would make it look spendable only on one deal.
--
-- So a reservation lives here, holding minutes OUT of "available" without
-- touching "used". When the video is signed off the reservation converts: a
-- normal credit_allocations kind='work' row is written (source_ref = 'vca_<id>'
-- so it can't double-charge) and the row flips to 'spent'. Nothing here is ever
-- counted twice, because a reserved row has no ledger row yet and a spent one
-- is no longer reserved.
CREATE TABLE IF NOT EXISTS video_credit_allocations (
  id          TEXT        PRIMARY KEY,
  video_id    TEXT        NOT NULL REFERENCES project_videos(id) ON DELETE CASCADE,
  deal_id     TEXT        NOT NULL,
  company_id  TEXT        NOT NULL,
  minutes     NUMERIC     NOT NULL CHECK (minutes > 0),
  -- reserved → earmarked, held out of the client's available balance
  -- spent    → the video was signed off; a credit_allocations work row exists
  -- released → handed back (video cancelled / assignment removed)
  status      TEXT        NOT NULL DEFAULT 'reserved',
  note        TEXT,
  assigned_by TEXT,
  spent_at    TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live allocation per video. Released rows are kept for the audit trail, so
-- the constraint is partial rather than a plain UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS video_credit_allocations_video_open_idx
  ON video_credit_allocations(video_id) WHERE status <> 'released';
CREATE INDEX IF NOT EXISTS video_credit_allocations_company_idx
  ON video_credit_allocations(company_id, status);
CREATE INDEX IF NOT EXISTS video_credit_allocations_deal_idx
  ON video_credit_allocations(deal_id, status);
