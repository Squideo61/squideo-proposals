-- Explicitly bind a partner-credit client to a CRM company.
--
-- The partner tables have no company_id, so "whose credit is this?" has always
-- been inferred: proposal→deal→company, a shared Xero contact, or a matching
-- client name. When a credit client's name differs materially from the company
-- name (and there's no linked proposal or shared Xero contact) nothing matches,
-- and the balance shows on Partners & Credits but reads as 0 on the company page
-- and in the client's portal. There was no way to correct that by hand.
--
-- company_id is now the authority: set it and the heuristics are bypassed
-- entirely for that client (so an explicitly-linked client can never also be
-- claimed by another company through a loose name match).
--
-- Idempotent. Also self-healed at runtime by ensureCreditCompanyLink()
-- (api/_lib/partnerCredits.js).
ALTER TABLE partner_subscriptions
  ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS partner_subscriptions_company_idx
  ON partner_subscriptions(company_id);
