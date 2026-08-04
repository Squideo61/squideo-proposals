-- Contact tags — a general labelling system for the CRM.
--
-- Built for the crash course (its signups need to be findable), but
-- deliberately generic: the next campaign, event or list should reuse this
-- rather than adding another bespoke flag column. Contacts filtering today is
-- one free-text search and a "Customers only" checkbox, and neither composes.
--
-- Two tables rather than a TEXT[] on contacts. An array column loses the
-- canonical label (every spelling of "Course Signup" becomes its own tag),
-- can't carry a colour, can't be renamed in one place, and makes the per-tag
-- counts the filter chips need into a full-table scan.
--
-- Self-healed at runtime by ensureCrmTagTables() in api/_lib/crm/tags.js.

CREATE TABLE IF NOT EXISTS crm_tags (
  id         TEXT        PRIMARY KEY,
  slug       TEXT        NOT NULL UNIQUE,   -- stable id used by code
  label      TEXT        NOT NULL,          -- what humans see; freely renamable
  colour     TEXT        NOT NULL DEFAULT '#2BB8E6',
  kind       TEXT        NOT NULL DEFAULT 'contact',  -- room for 'company'/'deal' later
  -- `system` marks a tag applied by code (course signup, course completed).
  -- Renaming and recolouring stay allowed; deleting does not, because a delete
  -- would silently break the thing that applies it.
  system     BOOLEAN     NOT NULL DEFAULT FALSE,
  sort_order INTEGER,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id TEXT        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id     TEXT        NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,
  applied_by TEXT,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, tag_id)
);

-- The filter chips count contacts per tag on every render of the Contacts page.
CREATE INDEX IF NOT EXISTS contact_tags_tag_idx ON contact_tags(tag_id);

-- The tags code applies on its own. Seeded here so a fresh workspace has them
-- with the right colours; applyTag() also find-or-creates, so a workspace that
-- never ran this migration still ends up with the same rows.
INSERT INTO crm_tags (id, slug, label, colour, system, sort_order) VALUES
  ('tg_course_signup',    'course-signup',    'Course signup',    '#2BB8E6', TRUE, 10),
  ('tg_course_completed', 'course-completed', 'Course completed', '#15803D', TRUE, 20),
  ('tg_course_lead',      'course-lead',      'Course → enquiry', '#F59E0B', TRUE, 30)
ON CONFLICT (slug) DO NOTHING;
