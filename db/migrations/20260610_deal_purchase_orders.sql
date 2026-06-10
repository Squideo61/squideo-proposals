-- Purchase-Order tracking for PO-route deals.
--
-- A deal sold on the PO route starts production off a signed proposal alone; the
-- physical purchase order (and its PO number) arrives later. These columns record
-- when the PO is received and its number (which becomes the reference on the Xero
-- invoice), and deal_po_files stores the uploaded PO documents.
--
-- deal_po_files is deliberately separate from deal_files: the Drive-folder mirror
-- in api/_lib/crm/deals.js deletes deal_files rows not present in Drive, which
-- would wipe these Blob-only PO docs. Self-healed at runtime by ensureDealPo().

ALTER TABLE deals ADD COLUMN IF NOT EXISTS po_number TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS po_received_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS deal_po_files (
  id            TEXT        PRIMARY KEY,
  deal_id       TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  filename      TEXT        NOT NULL,
  mime_type     TEXT,
  size_bytes    BIGINT,
  blob_url      TEXT,
  blob_pathname TEXT,
  uploaded_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deal_po_files_deal_idx ON deal_po_files (deal_id);
