-- Flat premium-voiceover charge. { premiumPrice } JSON on the singleton settings
-- row — the single charge to pick a Premium artist. NULL until an admin sets it
-- (the Premium section is hidden from clients while unpriced).
--
-- Apply in the Neon console. Self-healed by ensureFinanceTargetsColumn() in
-- api/settings.js. Idempotent.

ALTER TABLE settings ADD COLUMN IF NOT EXISTS voiceover_pricing JSONB;
