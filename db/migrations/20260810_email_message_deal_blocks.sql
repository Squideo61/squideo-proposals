-- Persistent "keep this ONE message off this deal" list — the per-message twin
-- of email_thread_deal_blocks. A deal shows every message of a linked thread
-- (deal detail unions email_thread_deals with email_message_deals), so deleting
-- an email_message_deals row can't hide a single email whose whole conversation
-- is attached: the thread link still pulls it in. This table records the
-- removal so the deal-detail read skips that message->deal pair. Re-linking the
-- message (or the whole thread) clears the block.
--
-- Self-healed at runtime by ensureMessageDealBlocksTable() in
-- api/_lib/crm/shared.js, so applying this by hand is optional.
CREATE TABLE IF NOT EXISTS email_message_deal_blocks (
  gmail_message_id TEXT NOT NULL,
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  blocked_by TEXT,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (gmail_message_id, deal_id)
);

CREATE INDEX IF NOT EXISTS email_message_deal_blocks_deal_idx
  ON email_message_deal_blocks (deal_id);
