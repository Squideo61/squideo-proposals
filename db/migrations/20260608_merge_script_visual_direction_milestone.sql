-- Merge the per-video "Visual Direction" milestone into "Script".
--
-- Script and text/visual direction are sent to the client together, so they
-- now share a single milestone — "Script & Text Direction" (id 'script',
-- approving it advances the card to the Storyboard stage). This migration
-- folds any existing 'visual_direction' rows into 'script'.
--
-- Idempotent. Also self-healed at runtime by ensureProductionSchema() in
-- api/_lib/production.js, so a manual Neon apply is optional.

-- Uploaded assets: no unique constraint, so just relabel.
UPDATE video_milestone_assets SET milestone = 'script' WHERE milestone = 'visual_direction';

-- Approvals: unique (video_id, milestone). Drop a 'visual_direction' approval
-- when that video already has a 'script' approval, then relabel the rest. A
-- combined milestone counts as approved if either half had been approved.
DELETE FROM video_milestones v
 WHERE v.milestone = 'visual_direction'
   AND EXISTS (SELECT 1 FROM video_milestones s WHERE s.video_id = v.video_id AND s.milestone = 'script');

UPDATE video_milestones SET milestone = 'script' WHERE milestone = 'visual_direction';
