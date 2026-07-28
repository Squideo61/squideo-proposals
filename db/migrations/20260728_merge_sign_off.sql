-- Merge the 'pending_group_sign_off' production stage into 'signed_off'. The two
-- were redundant (isVideoSignedOff already treated them identically); the board
-- now has a single "Signed Off" stage followed by a new "Final invoice" stage.
-- Relocate any existing cards/deals sitting on the removed stage so they don't
-- get mis-grouped into 'in_production'. Mirrored by the self-heal in
-- api/_lib/production.js (ensureProductionSchema).

UPDATE project_videos SET production_stage = 'signed_off' WHERE production_stage = 'pending_group_sign_off';
UPDATE deals          SET production_stage = 'signed_off' WHERE production_stage = 'pending_group_sign_off';
