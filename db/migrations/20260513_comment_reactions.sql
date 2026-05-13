CREATE TABLE IF NOT EXISTS deal_comment_reactions (
  comment_id  TEXT NOT NULL REFERENCES deal_comments(id) ON DELETE CASCADE,
  user_email  TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  PRIMARY KEY (comment_id, user_email, emoji)
);

CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment
  ON deal_comment_reactions(comment_id);
