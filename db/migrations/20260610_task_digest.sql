-- Morning task digest (heads-up counterpart to the at-due task.reminder ping).
-- digest_sent_at gates the daily summary to once per task. The task-digest cron
-- also self-heals this column + the role default, so the feature works before
-- this migration is applied — this file is the durable record.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS digest_sent_at TIMESTAMPTZ;

-- Seed the new task.digest notification default per role by copying each role's
-- existing task.reminder setting (so anyone who had reminders on also gets the
-- digest, and vice versa). Only fills roles that don't already have the key.
UPDATE roles
   SET notification_defaults = jsonb_set(
     notification_defaults, '{task.digest}',
     COALESCE(notification_defaults->'task.reminder', 'false'::jsonb), true)
 WHERE NOT (notification_defaults ? 'task.digest');
