-- Mirror of Xero contacts so we can offer fast typeahead in deal/proposal
-- creation flows. Populated on demand via POST /api/crm/xero-contacts/sync.
-- Existing local `companies` get an optional link to a Xero contact.

CREATE TABLE IF NOT EXISTS xero_contacts (
  id                TEXT PRIMARY KEY,         -- Xero ContactID (UUID)
  name              TEXT NOT NULL,
  email             TEXT,
  vat_number        TEXT,
  default_currency  TEXT,
  status            TEXT,                     -- ACTIVE / ARCHIVED / GDPRREQUEST
  address_line1     TEXT,
  address_line2     TEXT,
  city              TEXT,
  postcode          TEXT,
  country           TEXT,
  phone             TEXT,
  is_supplier       BOOLEAN DEFAULT FALSE,
  is_customer       BOOLEAN DEFAULT FALSE,
  xero_updated_at   TIMESTAMPTZ,              -- UpdatedDateUTC from Xero
  last_synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_xero_contacts_name_lower  ON xero_contacts (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_xero_contacts_email_lower ON xero_contacts (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_xero_contacts_status      ON xero_contacts (status);

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS xero_contact_id TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_xero_contact_id ON companies (xero_contact_id);
