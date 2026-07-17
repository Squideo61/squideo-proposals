-- Recurring tasks. A task can repeat daily/weekly/monthly. Two modes:
--   'after_done' — the next occurrence is created when the current one is
--                  completed (only one active at a time).
--   'fixed'      — the next occurrence is created when the due date passes,
--                  regardless of completion (driven by the task-reminders cron).
-- `recur_spawned` guards each occurrence to exactly one successor. Recurrence is
-- anchored on `due_at`; a recurring task always has a due date.
-- Mirrors the self-healing ensureRecurrenceColumns() in api/_lib/crm/tasks.js.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recur_freq    TEXT;    -- 'daily' | 'weekly' | 'monthly'
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recur_mode    TEXT;    -- 'after_done' | 'fixed'
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recur_until   DATE;    -- optional last date the series may reach
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recur_spawned BOOLEAN NOT NULL DEFAULT false;

-- Fixed-mode sweep looks up open, un-spawned, past-due recurring rows.
CREATE INDEX IF NOT EXISTS tasks_recur_idx ON tasks(recur_mode, recur_spawned, due_at)
  WHERE recur_freq IS NOT NULL;
