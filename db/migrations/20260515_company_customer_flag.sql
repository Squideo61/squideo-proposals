-- Customer status for organisations.
--
-- "Customer" = an organisation that has either:
--   1. Been manually verified by an admin (customer_verified_at stamped), or
--   2. Has at least one signed proposal linked to it (derived in queries via
--      signatures → proposals → deals.company_id).
--
-- The manual flag is what we store here. The "has a signed proposal" half is
-- left to query-time derivation so it stays accurate without needing the
-- signatures POST path to also stamp companies (which would race if a deal's
-- company link is changed later).

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS customer_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_verified_by TEXT;

-- Auto-flag any company that ALREADY has a signed proposal as a customer.
-- The "verified by" is left NULL so the UI can tell apart "auto-flagged on
-- migration" from "an admin clicked Verify". Idempotent — re-runs do nothing.
UPDATE companies c
   SET customer_verified_at = NOW()
 WHERE customer_verified_at IS NULL
   AND EXISTS (
     SELECT 1
       FROM signatures s
       JOIN proposals p ON p.id = s.proposal_id
       JOIN deals d ON d.id = p.deal_id
      WHERE d.company_id = c.id
   );
