-- Where a deal came from, kept on the deal itself.
--
-- A portal quote request is flagged all over the inbox — the alert subject, the
-- bell, a pill on the row — and then qualifying it into a deal dropped every
-- trace of it. By the time anyone opened the builder there was nothing left to
-- say the client had already been promised 10% off, so honouring it depended on
-- remembering. quote_requests.deal_id makes the link recoverable, but nobody
-- goes looking backwards; the fact has to travel forwards.
--
-- lead_source: 'portal' | 'web' | null (older deals, and ones created by hand).
-- portal_discount: the promise that was actually made to the client, not a
-- policy — a prospect who requests through the portal gets FALSE here.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS lead_source TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS portal_discount BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill from the quote requests that created them, so deals qualified before
-- today carry their origin too.
UPDATE deals d
   SET lead_source     = COALESCE(d.lead_source, q.source),
       portal_discount = COALESCE(q.portal_discount, FALSE)
  FROM quote_requests q
 WHERE q.deal_id = d.id
   AND d.lead_source IS NULL;

CREATE INDEX IF NOT EXISTS deals_lead_source_idx ON deals (lead_source) WHERE lead_source IS NOT NULL;
