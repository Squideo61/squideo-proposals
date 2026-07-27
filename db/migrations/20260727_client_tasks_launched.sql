-- The portal "Your tasks" checklist (voiceover, kick-off call, purchase order)
-- unlocks for the client when the production manager sends the intro email from
-- the deal. This timestamp records that moment; null = not launched yet.
-- Idempotent; also self-healed in api/_lib/production.js (ensureProductionSchema).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS client_tasks_launched_at TIMESTAMPTZ;
