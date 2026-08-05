-- Partner Programme enquiries from the client portal.
--
-- The page originally tried to book a real slot against the team's Google
-- calendar. That machinery is right for a kick-off call — the project is
-- already sold and the producer's diary is the constraint — but wrong here: it
-- needs a host with a connected calendar and free time in the next fortnight,
-- and when either is missing the client is shown "there's nothing open",
-- which is a dead end at exactly the moment they were ready to talk.
--
-- So: ask what they're after, take a date that suits them, and let a human
-- confirm it. Two answers instead of a calendar, and it can never be empty.
--
-- minutes_per_month is the sizing question ("1 credit = 60 seconds"), kept as
-- text because the useful answer includes "not sure yet".

CREATE TABLE IF NOT EXISTS partner_enquiries (
  id                TEXT        PRIMARY KEY,
  company_id        TEXT        REFERENCES companies(id) ON DELETE CASCADE,
  portal_user_id    TEXT,
  minutes_per_month TEXT,
  preferred_date    DATE,
  preferred_time    TEXT,
  note              TEXT,
  handled_at        TIMESTAMPTZ,
  handled_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS partner_enquiries_company_idx
  ON partner_enquiries (company_id, created_at DESC);

-- The open-enquiry lookup: one live enquiry per organisation, so a client who
-- comes back sees "we'll be in touch" rather than an empty form inviting them
-- to ask again.
CREATE INDEX IF NOT EXISTS partner_enquiries_open_idx
  ON partner_enquiries (company_id) WHERE handled_at IS NULL;
