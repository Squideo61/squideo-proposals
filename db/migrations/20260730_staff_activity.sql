-- Staff activity log: the management view (who's doing what) and the audit
-- trail (what exactly changed) in one table.
--
-- Written by api/_lib/crm/staffActivity.js, which self-heals this table at
-- runtime — this file is the record of it.
--
--   action        machine key, e.g. 'deals.update', 'auth.login', 'gmail.send'
--   entity/id     the record it happened to, kept even after that record is
--                 deleted (an audit trail that vanishes with the row is no
--                 audit trail)
--   entity_label  a name for that record, snapshotted at the time
--   summary       the human sentence: 'updated deal', 'signed in'
--   changes       [{ field, from, to }] for the records we diff
--   meta          { method, path, ip } / { via, ip, ua } for sign-ins
--
-- Retention: 12 months, pruned by the daily prune-views cron. Matches
-- proposal_views — both carry IP addresses.

CREATE TABLE IF NOT EXISTS staff_activity (
  id           BIGSERIAL   PRIMARY KEY,
  actor_email  TEXT,
  action       TEXT        NOT NULL,
  entity       TEXT,
  entity_id    TEXT,
  entity_label TEXT,
  summary      TEXT        NOT NULL,
  changes      JSONB,
  meta         JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staff_activity_time_idx   ON staff_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS staff_activity_actor_idx  ON staff_activity(actor_email, created_at DESC);
CREATE INDEX IF NOT EXISTS staff_activity_entity_idx ON staff_activity(entity, entity_id, created_at DESC);

-- Reading it is a management view over everyone's work, so it goes to Directors
-- (Admin holds '*' already). Back-filled at runtime by ensureSystemRoles().
UPDATE roles
   SET permissions = permissions || '["activity.view"]'::jsonb, updated_at = NOW()
 WHERE id = 'director' AND NOT (permissions @> '["activity.view"]'::jsonb);
