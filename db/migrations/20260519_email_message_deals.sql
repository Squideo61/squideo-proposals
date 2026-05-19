-- Message-level join for emails ↔ deals. Complements email_thread_deals
-- (which is thread-scoped) so a single message can be filed against a
-- different deal than the rest of its conversation when a user opts in.
CREATE TABLE IF NOT EXISTS email_message_deals (
  gmail_message_id TEXT NOT NULL REFERENCES email_messages(gmail_message_id) ON DELETE CASCADE,
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  linked_by_email TEXT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (gmail_message_id, deal_id)
);

CREATE INDEX IF NOT EXISTS email_message_deals_deal_idx ON email_message_deals (deal_id);
