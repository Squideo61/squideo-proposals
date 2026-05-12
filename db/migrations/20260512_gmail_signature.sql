ALTER TABLE gmail_accounts
  ADD COLUMN IF NOT EXISTS signature_html TEXT,
  ADD COLUMN IF NOT EXISTS signature_fetched_at TIMESTAMPTZ;
