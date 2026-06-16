-- Many-to-many contact↔organisation memberships. A contact can now sit at
-- multiple organisations. We KEEP contacts.company_id as the contact's PRIMARY
-- organisation (deals, Xero contact links and lifetime-value rollups all still
-- key off it); this table holds the FULL set of memberships (a superset that
-- includes the primary), so reads treat it as authoritative for "all of a
-- contact's organisations".
CREATE TABLE IF NOT EXISTS contact_companies (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, company_id)
);
CREATE INDEX IF NOT EXISTS contact_companies_company_idx ON contact_companies (company_id);

-- Backfill: every existing primary company becomes a membership.
INSERT INTO contact_companies (contact_id, company_id)
SELECT c.id, c.company_id FROM contacts c
 WHERE c.company_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM companies co WHERE co.id = c.company_id)
ON CONFLICT DO NOTHING;
