import sql from '../db.js';
import { makeId, trimOrNull, lowerOrNull } from './shared.js';
import { serialiseTask } from './tasks.js';

// Email Folders — a non-deal home for filing emails and setting tasks against
// them (see db/migrations/20260708_email_folders.sql). Private to the owner by
// default; sharable with specific teammates via email_folder_members. Filing is
// thread-scoped (email_thread_folders), mirroring email_thread_deals; tasks use
// the existing tasks table via a nullable folder_id.
//
// Routes (dispatched from api/crm/[...slug].js as resource 'folders'):
//   GET    /api/crm/folders                          — folders visible to me
//   POST   /api/crm/folders                          — create { name, color?, memberEmails? }
//   GET    /api/crm/folders/for-thread?gmailThreadId= — folders a thread is filed in
//   GET    /api/crm/folders/:id                       — folder detail (threads + tasks)
//   PATCH  /api/crm/folders/:id                       — rename / recolor / set members (owner)
//   DELETE /api/crm/folders/:id                       — delete the folder (owner)
//   POST   /api/crm/folders/:id/file                  — file a thread into the folder
//   DELETE /api/crm/folders/:id/file?gmailThreadId=   — unfile a thread

// Self-heal the schema so workspaces that skipped the manual Neon apply still
// work. Module-level cached, like the other ensure* helpers.
let schemaEnsured = null;
export async function ensureEmailFoldersSchema() {
  if (schemaEnsured) return schemaEnsured;
  schemaEnsured = (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS email_folders (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          color       TEXT,
          owner_email TEXT NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at TIMESTAMPTZ
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS email_folders_owner_idx ON email_folders (owner_email)`;
      await sql`
        CREATE TABLE IF NOT EXISTS email_folder_members (
          folder_id  TEXT NOT NULL REFERENCES email_folders(id) ON DELETE CASCADE,
          user_email TEXT NOT NULL,
          added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (folder_id, user_email)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS email_thread_folders (
          gmail_thread_id TEXT NOT NULL,
          folder_id       TEXT NOT NULL REFERENCES email_folders(id) ON DELETE CASCADE,
          filed_by        TEXT,
          filed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (gmail_thread_id, folder_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS email_thread_folders_folder_idx ON email_thread_folders (folder_id)`;
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS folder_id TEXT`;
      await sql`CREATE INDEX IF NOT EXISTS tasks_folder_id_idx ON tasks (folder_id) WHERE folder_id IS NOT NULL`;
    } catch (err) {
      schemaEnsured = null;
      console.warn('[email_folders] ensure failed', err.message);
      throw err;
    }
  })();
  return schemaEnsured;
}

function serialiseFolder(r, extra = {}) {
  return {
    id: r.id,
    name: r.name,
    color: r.color || null,
    ownerEmail: r.owner_email,
    createdAt: r.created_at,
    ...extra,
  };
}

function serialiseFiledThread(r) {
  return {
    gmailThreadId: r.gmail_thread_id,
    subject: r.subject || null,
    lastMessageAt: r.last_message_at || null,
    participantEmails: Array.isArray(r.participant_emails) ? r.participant_emails.filter(Boolean) : [],
    filedAt: r.filed_at,
  };
}

// Return the folder row if `email` is the owner or a shared member, else null.
async function accessibleFolder(folderId, email) {
  const rows = await sql`
    SELECT * FROM email_folders WHERE id = ${folderId} AND archived_at IS NULL
  `;
  if (!rows.length) return null;
  const folder = rows[0];
  if ((folder.owner_email || '').toLowerCase() === email) return folder;
  const member = await sql`
    SELECT 1 FROM email_folder_members
    WHERE folder_id = ${folderId} AND LOWER(user_email) = ${email}
  `;
  return member.length ? folder : null;
}

// True if `email` may file emails / set tasks in the folder (owner or member).
// Used by the tasks route to authorize folder-scoped task creation.
export async function userCanAccessFolder(folderId, email) {
  await ensureEmailFoldersSchema();
  const folder = await accessibleFolder(folderId, (email || '').toLowerCase());
  return !!folder;
}

async function replaceMembers(folderId, ownerEmail, memberEmails) {
  const clean = Array.from(new Set(
    (Array.isArray(memberEmails) ? memberEmails : [])
      .map(lowerOrNull)
      .filter(Boolean)
      .filter((e) => e !== (ownerEmail || '').toLowerCase()),
  ));
  await sql`DELETE FROM email_folder_members WHERE folder_id = ${folderId}`;
  if (clean.length) {
    await sql`
      INSERT INTO email_folder_members (folder_id, user_email)
      SELECT ${folderId}, unnest(${clean}::text[])
      ON CONFLICT DO NOTHING
    `;
  }
  return clean;
}

export async function emailFoldersRoute(req, res, id, action, user) {
  await ensureEmailFoldersSchema();
  const email = (user.email || '').toLowerCase();

  // ---- Collection: list / create ----
  if (!id) {
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT ef.*,
          (SELECT COUNT(*) FROM email_thread_folders tf WHERE tf.folder_id = ef.id) AS thread_count,
          (SELECT COUNT(*) FROM tasks t WHERE t.folder_id = ef.id AND t.done_at IS NULL) AS open_task_count,
          (SELECT COALESCE(ARRAY_AGG(m.user_email ORDER BY m.added_at), '{}')
             FROM email_folder_members m WHERE m.folder_id = ef.id) AS member_emails
        FROM email_folders ef
        WHERE ef.archived_at IS NULL
          AND (LOWER(ef.owner_email) = ${email}
               OR EXISTS (SELECT 1 FROM email_folder_members m
                          WHERE m.folder_id = ef.id AND LOWER(m.user_email) = ${email}))
        ORDER BY LOWER(ef.name) ASC
      `;
      return res.status(200).json(rows.map((r) => serialiseFolder(r, {
        threadCount: Number(r.thread_count) || 0,
        openTaskCount: Number(r.open_task_count) || 0,
        memberEmails: (r.member_emails || []).filter(Boolean),
        isOwner: (r.owner_email || '').toLowerCase() === email,
      })));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const name = trimOrNull(body.name);
      if (!name) return res.status(400).json({ error: 'name is required' });
      const newId = makeId('emlfolder');
      const color = trimOrNull(body.color);
      await sql`
        INSERT INTO email_folders (id, name, color, owner_email)
        VALUES (${newId}, ${name}, ${color}, ${user.email})
      `;
      const members = await replaceMembers(newId, user.email, body.memberEmails);
      return res.status(201).json(serialiseFolder(
        { id: newId, name, color, owner_email: user.email, created_at: new Date().toISOString() },
        { threadCount: 0, openTaskCount: 0, memberEmails: members, isOwner: true },
      ));
    }
    return res.status(405).end();
  }

  // ---- Which folders is a given thread filed in (for the email side panel) ----
  if (id === 'for-thread') {
    if (req.method !== 'GET') return res.status(405).end();
    const tid = trimOrNull(req.query.gmailThreadId);
    if (!tid) return res.status(200).json([]);
    const rows = await sql`
      SELECT ef.id, ef.name, ef.color, ef.owner_email
      FROM email_thread_folders tf
      JOIN email_folders ef ON ef.id = tf.folder_id
      WHERE tf.gmail_thread_id = ${tid} AND ef.archived_at IS NULL
        AND (LOWER(ef.owner_email) = ${email}
             OR EXISTS (SELECT 1 FROM email_folder_members m
                        WHERE m.folder_id = ef.id AND LOWER(m.user_email) = ${email}))
      ORDER BY LOWER(ef.name)
    `;
    return res.status(200).json(rows.map((r) => ({ id: r.id, name: r.name, color: r.color || null })));
  }

  // Everything below operates on a specific folder — access-gate once.
  const folder = await accessibleFolder(id, email);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  const isOwner = (folder.owner_email || '').toLowerCase() === email;

  // ---- File / unfile a thread ----
  if (action === 'file') {
    if (req.method === 'POST') {
      const body = req.body || {};
      const gmailThreadId = trimOrNull(body.gmailThreadId);
      if (!gmailThreadId) return res.status(400).json({ error: 'gmailThreadId is required' });
      // Upsert a minimal thread row so the folder view can show the subject/date
      // even for threads that haven't been synced through the deal machinery.
      const subject = trimOrNull(body.subject);
      const participant = lowerOrNull(body.participantEmail);
      const lastAt = body.lastMessageAt ? new Date(body.lastMessageAt).toISOString() : new Date().toISOString();
      await sql`
        INSERT INTO email_threads (gmail_thread_id, user_email, subject, last_message_at, participant_emails)
        VALUES (${gmailThreadId}, ${user.email}, ${subject}, ${lastAt}, ${participant ? [participant] : []})
        ON CONFLICT (gmail_thread_id) DO UPDATE SET
          subject = COALESCE(email_threads.subject, EXCLUDED.subject),
          last_message_at = GREATEST(COALESCE(email_threads.last_message_at, '-infinity'::timestamptz), EXCLUDED.last_message_at)
      `;
      await sql`
        INSERT INTO email_thread_folders (gmail_thread_id, folder_id, filed_by)
        VALUES (${gmailThreadId}, ${id}, ${user.email})
        ON CONFLICT (gmail_thread_id, folder_id) DO NOTHING
      `;
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'DELETE') {
      const gmailThreadId = trimOrNull(req.query.gmailThreadId);
      if (!gmailThreadId) return res.status(400).json({ error: 'gmailThreadId is required' });
      await sql`
        DELETE FROM email_thread_folders
        WHERE gmail_thread_id = ${gmailThreadId} AND folder_id = ${id}
      `;
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  }

  // ---- Folder detail ----
  if (req.method === 'GET') {
    const members = await sql`
      SELECT user_email FROM email_folder_members WHERE folder_id = ${id} ORDER BY added_at
    `;
    const threads = await sql`
      SELECT tf.gmail_thread_id, tf.filed_at,
             et.subject, et.last_message_at, et.participant_emails
      FROM email_thread_folders tf
      LEFT JOIN email_threads et ON et.gmail_thread_id = tf.gmail_thread_id
      WHERE tf.folder_id = ${id}
      ORDER BY COALESCE(et.last_message_at, tf.filed_at) DESC
    `;
    const tasks = await sql`
      SELECT t.*,
        (SELECT COALESCE(ARRAY_AGG(ta.user_email ORDER BY ta.assigned_at), '{}')
         FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_emails
      FROM tasks t
      WHERE t.folder_id = ${id}
      ORDER BY t.done_at NULLS FIRST, t.due_at ASC NULLS LAST
    `;
    return res.status(200).json(serialiseFolder(folder, {
      isOwner,
      memberEmails: members.map((m) => m.user_email).filter(Boolean),
      threads: threads.map(serialiseFiledThread),
      tasks: tasks.map(serialiseTask),
    }));
  }

  // ---- Rename / recolor / set members (owner only) ----
  if (req.method === 'PATCH') {
    if (!isOwner) return res.status(403).json({ error: 'Only the owner can edit this folder' });
    const body = req.body || {};
    const name = 'name' in body ? (trimOrNull(body.name) || folder.name) : folder.name;
    const color = 'color' in body ? trimOrNull(body.color) : folder.color;
    await sql`UPDATE email_folders SET name = ${name}, color = ${color} WHERE id = ${id}`;
    let memberEmails;
    if ('memberEmails' in body) {
      memberEmails = await replaceMembers(id, folder.owner_email, body.memberEmails);
    } else {
      const rows = await sql`SELECT user_email FROM email_folder_members WHERE folder_id = ${id} ORDER BY added_at`;
      memberEmails = rows.map((m) => m.user_email).filter(Boolean);
    }
    const counts = await sql`
      SELECT
        (SELECT COUNT(*) FROM email_thread_folders tf WHERE tf.folder_id = ${id}) AS thread_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.folder_id = ${id} AND t.done_at IS NULL) AS open_task_count
    `;
    return res.status(200).json(serialiseFolder(
      { ...folder, name, color },
      {
        isOwner: true,
        memberEmails,
        threadCount: Number(counts[0]?.thread_count) || 0,
        openTaskCount: Number(counts[0]?.open_task_count) || 0,
      },
    ));
  }

  // ---- Delete the folder (owner only) ----
  if (req.method === 'DELETE') {
    if (!isOwner) return res.status(403).json({ error: 'Only the owner can delete this folder' });
    // Detach the folder's tasks (keep them in the creator's task list) then
    // remove the folder — cascades members + thread links.
    await sql`UPDATE tasks SET folder_id = NULL WHERE folder_id = ${id}`;
    await sql`DELETE FROM email_folders WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
