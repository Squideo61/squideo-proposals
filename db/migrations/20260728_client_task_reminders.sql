-- Per-deal state for the automatic client-task reminder cron
-- (api/_lib/crm/cron.js → cronClientTaskReminders). Tracks when we last chased
-- the client and how many times, so the cadence (settings.task_reminders) and
-- the max-reminder cap are enforced. Self-healed at cron start.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS client_tasks_reminded_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS client_tasks_reminder_count INT NOT NULL DEFAULT 0;
