-- Attachments a client tried to send with a lead and that never arrived.
--
-- The public forms report what they couldn't upload, so a failed brief or
-- storyboard is visible on the lead (and on the deal it becomes) instead of
-- being lost between a cheerful confirmation and an empty inbox row.
--
-- Shape: [{ "filename": "storyboard.pdf", "sizeBytes": 12345678, "reason": "…" }]
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS upload_errors JSONB;
