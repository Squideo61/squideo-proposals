-- Which form a lead came off.
--
-- squideo.com is moving off Duda, and nine of its pages had Duda-native forms
-- that Duda itself captured — a free script request, two discovery-meeting
-- bookings, a brief template, a video amends form, a free consultation, a
-- LinkedIn offer, an interactive-video enquiry and an AI-translation enquiry.
-- The new site posts all nine here instead, so without a discriminator they
-- arrive in the "new" inbox indistinguishable from a quote request, and the
-- list stops being worth reading.
--
-- NOT the existing `source` column. That one is 'web' | 'portal' and answers
-- "which product did this come through", which is a different question and one
-- the reporting already depends on. A lead-magnet form on the marketing site is
-- `source = 'web'` and `form_source = 'brief-template'`; overloading the first
-- would silently reclassify every one of these as something other than web.
--
-- NULL for the quote and contact forms, which is most rows — those are the
-- default path and naming them would mean backfilling history to say so.

ALTER TABLE quote_requests
  ADD COLUMN IF NOT EXISTS form_source TEXT;

-- The inbox filters by status and then reads form_source per row; this is for
-- the Marketing question instead — "how many leads did the LinkedIn offer
-- bring", which scans by form over a date range.
CREATE INDEX IF NOT EXISTS quote_requests_form_source_idx
  ON quote_requests(form_source, created_at DESC)
  WHERE form_source IS NOT NULL;
