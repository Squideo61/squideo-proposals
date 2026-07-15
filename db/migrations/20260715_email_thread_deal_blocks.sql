-- Persistent "keep this thread off this deal" list. When a user manually
-- unlinks a thread from a deal, deleting the email_thread_deals row alone isn't
-- enough: the next inbound reply re-runs the auto-link resolver, matches the
-- sender against the deal's contacts (gmailSync resolveDealForMessage rule 4),
-- and rebuilds the link. This table records the manual unlink so the resolver
-- and the inbox chip resolver both skip that thread->deal pair on future
-- messages. Manually re-linking the same pair clears the block.
--
-- Self-healed at runtime by ensureThreadDealBlocksTable() in
-- api/_lib/crm/shared.js, so applying this by hand is optional.
CREATE TABLE IF NOT EXISTS email_thread_deal_blocks (
  gmail_thread_id TEXT NOT NULL,
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  blocked_by TEXT,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (gmail_thread_id, deal_id)
);

CREATE INDEX IF NOT EXISTS email_thread_deal_blocks_thread_idx
  ON email_thread_deal_blocks (gmail_thread_id);
