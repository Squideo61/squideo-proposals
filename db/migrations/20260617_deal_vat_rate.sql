-- Per-deal VAT rate, set on the deal create/edit form. Stored as a fraction
-- (0.2 = 20%) to match the proposal vatRate convention. Nullable — a null is
-- treated as the standard 20% at display time. Self-healed at runtime by
-- ensureDealVat() so the column exists even before this migration is applied.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS vat_rate NUMERIC;
