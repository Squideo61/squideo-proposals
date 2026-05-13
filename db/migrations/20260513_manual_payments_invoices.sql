CREATE TABLE IF NOT EXISTS manual_invoices (
  id              TEXT        PRIMARY KEY,
  proposal_id     TEXT        REFERENCES proposals(id) ON DELETE CASCADE,
  deal_id         TEXT        REFERENCES deals(id) ON DELETE CASCADE,
  invoice_number  TEXT,
  amount          NUMERIC,
  issued_at       DATE,
  due_at          DATE,
  status          TEXT        NOT NULL DEFAULT 'issued',
  blob_url        TEXT        NOT NULL,
  blob_pathname   TEXT,
  filename        TEXT,
  mime_type       TEXT,
  size_bytes      INTEGER,
  notes           TEXT,
  uploaded_by     TEXT        REFERENCES users(email) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS manual_invoices_proposal_idx ON manual_invoices(proposal_id);
CREATE INDEX IF NOT EXISTS manual_invoices_deal_idx ON manual_invoices(deal_id);

CREATE TABLE IF NOT EXISTS manual_payments (
  id                 TEXT        PRIMARY KEY,
  proposal_id        TEXT        NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  amount             NUMERIC     NOT NULL,
  payment_method     TEXT        NOT NULL,
  payment_type       TEXT,
  paid_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes              TEXT,
  manual_invoice_id  TEXT        REFERENCES manual_invoices(id) ON DELETE SET NULL,
  recorded_by        TEXT        REFERENCES users(email) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS manual_payments_proposal_idx ON manual_payments(proposal_id);
