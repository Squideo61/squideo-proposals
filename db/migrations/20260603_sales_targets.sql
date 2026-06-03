-- Separate monthly targets for the Business → Performance "Sales performance"
-- sub-section (deals signed), independent of finance_targets (Income performance,
-- cash received). JSONB array of { key, label, amount, color }; NULL → app falls
-- back to the seeded defaults in api/settings.js.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS sales_targets JSONB;
