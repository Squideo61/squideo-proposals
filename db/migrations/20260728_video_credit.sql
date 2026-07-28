-- Video Credit (client portal): clients buy a block of production minutes at the
-- Content Credit tiered discount and draw it down on new videos. Credit itself
-- reuses the existing partner-credit ledger (partner_subscriptions +
-- credit_allocations) — no new credit tables. credit_allocations.source_ref
-- (added in 20260520_partner_xero_link.sql) is reused to make card top-ups
-- idempotent against re-delivered Stripe webhooks.
--
-- The only schema change is a flag on quote_requests so a portal "New video"
-- request can signal the client wants to spend their credit (staff confirm the
-- scope and draw it down when they build it — no auto-deduction).

ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS use_credit BOOLEAN NOT NULL DEFAULT FALSE;
