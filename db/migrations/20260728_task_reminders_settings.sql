-- Admin-editable config for the automatic client-task reminders. A single JSON
-- blob on the settings row: { enabled, everyDays, maxReminders, subject,
-- bodyHtml }. Edited in Admin → Task reminders; read by cronClientTaskReminders.
-- Self-healed at runtime by ensureFinanceTargetsColumn() in api/settings.js.

ALTER TABLE settings ADD COLUMN IF NOT EXISTS task_reminders JSONB;
