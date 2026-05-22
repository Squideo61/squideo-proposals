-- Pivot: VIDEOS (not whole projects) move through the production board, so each
-- video carries its own stage and Monday-style columns. The project (deal) is
-- now just the container that groups a client's videos. Idempotent.
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS production_phase            TEXT;
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS production_stage            TEXT;
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS production_stage_changed_at TIMESTAMPTZ;
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS payment_terms              TEXT;
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS video_length               TEXT;
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS delivery_deadline          DATE;
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS text_direction_deadline    DATE;
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS producer_email             TEXT;
CREATE INDEX IF NOT EXISTS project_videos_stage_idx ON project_videos(production_phase, production_stage);

-- Backfill existing videos onto the board (Pre-Production / New Project),
-- inheriting whatever was set at the project level so no data is lost.
UPDATE project_videos v
   SET production_phase            = 'pre_production',
       production_stage            = 'new_project',
       production_stage_changed_at = NOW(),
       producer_email              = d.producer_email,
       payment_terms               = d.payment_terms,
       video_length                = d.video_length,
       delivery_deadline           = d.delivery_deadline,
       text_direction_deadline     = d.text_direction_deadline
  FROM deals d
 WHERE d.id = v.deal_id AND v.production_phase IS NULL;
