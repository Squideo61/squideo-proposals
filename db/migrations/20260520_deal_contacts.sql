-- Secondary contacts on a deal. The primary contact still lives on
-- deals.primary_contact_id so existing reads don't need to change; this
-- table only carries additional contacts (anyone Cc'd into a thread the
-- user explicitly attached, etc.). Self-healed at runtime by
-- ensureDealContactsTable() in api/_lib/crm/shared.js.
CREATE TABLE IF NOT EXISTS deal_contacts (
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'secondary',
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by TEXT,
  PRIMARY KEY (deal_id, contact_id)
);

CREATE INDEX IF NOT EXISTS deal_contacts_contact_idx ON deal_contacts (contact_id);
