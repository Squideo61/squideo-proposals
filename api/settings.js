import sql from './_lib/db.js';
import { cors, requireAuth } from './_lib/middleware.js';
import { getRole } from './_lib/userRoles.js';
import { hasPermission } from './_lib/permissions.js';

// Monthly targets for the Business → Performance graphs. Used when the settings
// row has no targets yet. `finance_targets` = Income performance (cash received);
// `sales_targets` = Sales performance (deals signed). Seeded from the owner's
// "Live Sales Sheet" monthly totals; fully editable in-app.
const DEFAULT_FINANCE_TARGETS = [
  { key: 'minimum', label: 'Minimum', amount: 27806.92, color: '#F59E0B' },
  { key: 't4k', label: '4k', amount: 30606.92, color: '#94A3B8' },
  { key: 'dream', label: 'Dream 5k', amount: 33406.92, color: '#EAB308' },
];

// Default fixed monthly CRM cost line items (Admin → Storage & CRM costs). Used
// when the settings row has no cost_items yet; fully editable in-app. Each item:
// { id, label, amountUsd, note }.
const DEFAULT_COST_ITEMS = [
  { id: 'vercel_pro', label: 'Vercel Pro', amountUsd: 20, note: 'Hosting + serverless functions' },
];

// Self-heal for db/migrations/20260603_finance_targets.sql + _sales_targets.sql
// (and the cost_items column for the costs tab) so the columns exist before any
// read/write below. Module-cached — runs once per cold start.
let financeTargetsColumnEnsured = null;
function ensureFinanceTargetsColumn() {
  if (financeTargetsColumnEnsured) return financeTargetsColumnEnsured;
  financeTargetsColumnEnsured = (async () => {
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS finance_targets JSONB`;
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS sales_targets JSONB`;
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS cost_items JSONB`;
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS default_proposal JSONB`;
    // Editable body for the PM's "here are your project tasks" portal email.
    // { subject, bodyHtml } — the live per-client portal button is appended at
    // send time. null until an admin saves one (server falls back to a default).
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS project_tasks_email JSONB`;
    // Voiceover upgrade pricing. { premiumPrice } — the single flat charge to
    // pick a Premium artist. null until an admin sets it (Premium section is
    // hidden from clients while unpriced).
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS voiceover_pricing JSONB`;
    // Automatic client-task reminder config (Admin → Task reminders).
    // { enabled, everyDays, maxReminders, subject, bodyHtml } — read by
    // cronClientTaskReminders. null until an admin saves one.
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS task_reminders JSONB`;
    // Video-guide nudge sequence config (Admin → Video guide). { enabled }
    // — read by cronCourseNudges. Off until an admin turns it on, so the
    // sequence can never start sending the moment it deploys.
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS course_emails JSONB`;
    // Sample project config (Admin → Video guide). { videoUrl, posterUrl,
    // title, videoTitle } — the demo itself is a fixture in the portal bundle;
    // this is only where the video lives, so it can be re-recorded and swapped
    // without a deploy.
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS demo_project JSONB`;
    // { url, title } — the video on the portal's Partner Programme page.
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS partner_video JSONB`;
  })().catch((err) => { financeTargetsColumnEnsured = null; throw err; });
  return financeTargetsColumnEnsured;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  await ensureFinanceTargetsColumn();

  if (req.method === 'GET') {
    const rows = await sql`SELECT extras_bank, inclusions_bank, notification_recipients, revision_call_url, finance_targets, sales_targets, cost_items, default_proposal, project_tasks_email, voiceover_pricing, task_reminders, course_emails, demo_project, partner_video FROM settings WHERE id = 1`;
    const row = rows[0];
    return res.status(200).json({
      extrasBank: row.extras_bank,
      inclusionsBank: row.inclusions_bank,
      notificationRecipients: row.notification_recipients,
      revisionCallUrl: row.revision_call_url || '',
      // Admin-editable base for every new proposal. null until an admin first
      // saves one — the frontend falls back to the hardcoded DEFAULT_PROPOSAL.
      defaultProposal: row.default_proposal || null,
      // Admin-editable body for the PM "email project tasks" action. null until
      // first saved — the send route falls back to a hardcoded default.
      projectTasksEmail: row.project_tasks_email || null,
      // Flat charge to pick a Premium voiceover artist. null until set.
      voiceoverPricing: row.voiceover_pricing || null,
      // Automatic client-task reminder cadence + copy. null until first saved.
      taskReminders: row.task_reminders || null,
      // Video-guide nudge sequence. null until first saved (cron treats that
      // as disabled).
      courseEmails: row.course_emails || null,
      // Where the sample project's video lives. null until one is uploaded.
      demoProject: row.demo_project || null,
      partnerVideo: row.partner_video || null,
      financeTargets: Array.isArray(row.finance_targets) && row.finance_targets.length
        ? row.finance_targets
        : DEFAULT_FINANCE_TARGETS,
      salesTargets: Array.isArray(row.sales_targets) && row.sales_targets.length
        ? row.sales_targets
        : DEFAULT_FINANCE_TARGETS,
      costItems: Array.isArray(row.cost_items)
        ? row.cost_items
        : DEFAULT_COST_ITEMS,
    });
  }

  if (req.method === 'PUT') {
    // Global settings — restricted. A compromised member account shouldn't
    // be able to redirect signed/paid notifications or pollute every new
    // proposal's defaults.
    if (!hasPermission(await getRole(user.role), 'settings.manage')) {
      return res.status(403).json({ error: 'You do not have permission to edit workspace settings' });
    }
    const { extrasBank, inclusionsBank, notificationRecipients, revisionCallUrl, financeTargets, salesTargets, costItems, defaultProposal, projectTasksEmail, voiceoverPricing, taskReminders, courseEmails, demoProject, partnerVideo } = req.body || {};
    await sql`
      UPDATE settings SET
        extras_bank             = COALESCE(${extrasBank ? JSON.stringify(extrasBank) : null}::jsonb, extras_bank),
        inclusions_bank         = COALESCE(${inclusionsBank ? JSON.stringify(inclusionsBank) : null}::jsonb, inclusions_bank),
        notification_recipients = COALESCE(${notificationRecipients ? JSON.stringify(notificationRecipients) : null}::jsonb, notification_recipients),
        revision_call_url       = COALESCE(${revisionCallUrl !== undefined ? String(revisionCallUrl) : null}, revision_call_url),
        finance_targets         = COALESCE(${financeTargets ? JSON.stringify(financeTargets) : null}::jsonb, finance_targets),
        sales_targets           = COALESCE(${salesTargets ? JSON.stringify(salesTargets) : null}::jsonb, sales_targets),
        cost_items              = COALESCE(${Array.isArray(costItems) ? JSON.stringify(costItems) : null}::jsonb, cost_items),
        default_proposal        = COALESCE(${defaultProposal ? JSON.stringify(defaultProposal) : null}::jsonb, default_proposal),
        project_tasks_email     = COALESCE(${projectTasksEmail ? JSON.stringify(projectTasksEmail) : null}::jsonb, project_tasks_email),
        voiceover_pricing       = COALESCE(${voiceoverPricing ? JSON.stringify(voiceoverPricing) : null}::jsonb, voiceover_pricing),
        task_reminders          = COALESCE(${taskReminders ? JSON.stringify(taskReminders) : null}::jsonb, task_reminders),
        course_emails           = COALESCE(${courseEmails ? JSON.stringify(courseEmails) : null}::jsonb, course_emails),
        demo_project            = COALESCE(${demoProject ? JSON.stringify(demoProject) : null}::jsonb, demo_project),
        partner_video           = COALESCE(${partnerVideo ? JSON.stringify(partnerVideo) : null}::jsonb, partner_video)
      WHERE id = 1
    `;
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
}
