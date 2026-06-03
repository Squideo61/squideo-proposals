-- Company postal address. Stored at the company level (a company links 1:1 to
-- a Xero contact via companies.xero_contact_id) so it can be edited from the
-- deal page and pushed to the linked Xero contact's STREET address.
--
-- Field names mirror the xero_contacts mirror (20260515_xero_contacts.sql) and
-- the Xero Addresses payload used in api/_lib/xero.js getOrCreateContact.
-- Idempotent — re-runs do nothing.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS address_line1 TEXT,
  ADD COLUMN IF NOT EXISTS address_line2 TEXT,
  ADD COLUMN IF NOT EXISTS city          TEXT,
  ADD COLUMN IF NOT EXISTS postcode      TEXT,
  ADD COLUMN IF NOT EXISTS country       TEXT;
