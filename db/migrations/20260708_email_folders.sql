-- Email Folders: a non-deal home for filing emails and setting tasks against
-- them. Folders are owned by a user (private by default) and can be shared with
-- specific team members. Mirrors the email_thread_deals link model for filing
-- and reuses the existing tasks table (via a nullable folder_id) for to-dos.
-- Self-healed at runtime by ensureEmailFoldersSchema() in
-- api/_lib/crm/emailFolders.js, so applying this by hand is optional.

CREATE TABLE IF NOT EXISTS email_folders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT,
  owner_email TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS email_folders_owner_idx ON email_folders (owner_email);

-- Who a private folder is shared with (the owner always has access and is not
-- listed here).
CREATE TABLE IF NOT EXISTS email_folder_members (
  folder_id  TEXT NOT NULL REFERENCES email_folders(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (folder_id, user_email)
);

-- Which Gmail threads are filed into which folder (thread-scoped, like
-- email_thread_deals). No FK on gmail_thread_id so a thread can be filed even
-- before it has been synced into email_threads.
CREATE TABLE IF NOT EXISTS email_thread_folders (
  gmail_thread_id TEXT NOT NULL,
  folder_id       TEXT NOT NULL REFERENCES email_folders(id) ON DELETE CASCADE,
  filed_by        TEXT,
  filed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (gmail_thread_id, folder_id)
);
CREATE INDEX IF NOT EXISTS email_thread_folders_folder_idx ON email_thread_folders (folder_id);

-- Tasks can hang off a folder instead of (or as well as being unrelated to) a
-- deal. Reuses all the existing task machinery (assignees, reminders, undo).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS folder_id TEXT;
CREATE INDEX IF NOT EXISTS tasks_folder_id_idx ON tasks (folder_id) WHERE folder_id IS NOT NULL;
