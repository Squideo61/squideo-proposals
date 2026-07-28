// The portal's "Your tasks for this project" list. Like nextStep.js, it's a
// pure, server-side derivation from deal + video state so the project page, the
// dashboard and the ball-in-court banner always agree. No DB access here — the
// caller gathers the bundle.
//
// It's a registry: each producer inspects the bundle and returns a task (or
// null). Adding a task later is one entry. A task is:
//   { key, title, detail, status: 'todo'|'done'|'locked', cta: { href } | { action } }
// Tasks only appear once the PM has launched them by sending the client's intro
// email (deal.client_tasks_launched_at) — that's the "here are your tasks" email.

const TASK_PRODUCERS = [
  // Send us your purchase order. PO-route deals only, first in the list, until
  // the PO number lands. (Mirrors the PO rule in nextStep.js.)
  ({ deal, sigPaymentOption }) => {
    const isPo = sigPaymentOption === 'po' || deal.payment_terms === 'po';
    if (!isPo) return null;
    const done = !!deal.po_number;
    return {
      key: 'po',
      title: 'Send us your purchase order',
      detail: done
        ? `PO ${deal.po_number} received — thank you.`
        : 'Share your PO number (and upload the PO document if you have one) so we can raise the invoice.',
      status: done ? 'done' : 'todo',
      cta: { label: done ? 'View' : 'Submit PO', action: 'po-number' },
    };
  },
  // Choose a voiceover artist for each video. Only when the project actually
  // includes a voiceover (the standard AI VO can be removed from the proposal).
  ({ deal, videos, hasVoiceover }) => {
    if (!hasVoiceover || !videos.length) return null;
    const remaining = videos.filter((v) => !v.voiceover_artist_id).length;
    return {
      key: 'voiceover',
      title: 'Choose your voiceover',
      detail: remaining === 0
        ? 'A voice is picked for every video.'
        : videos.length > 1
          ? `Pick a voice for ${remaining} of your ${videos.length} videos.`
          : 'Have a listen and pick the voice for your video.',
      status: remaining === 0 ? 'done' : 'todo',
      cta: { label: remaining === 0 ? 'Review voiceovers' : 'Choose voiceover', href: `#/voiceover/${deal.id}` },
    };
  },
  // Book the project kick-off call.
  ({ deal, hasKickoffBooking }) => ({
    key: 'kickoff',
    title: 'Book your kick-off call',
    detail: hasKickoffBooking
      ? 'Your kick-off call is booked — see you there.'
      : 'Grab a time to meet the team and get your project moving.',
    status: hasKickoffBooking ? 'done' : 'todo',
    cta: { label: hasKickoffBooking ? 'View call' : 'Book kick-off', href: `#/kickoff/${deal.id}` },
  }),
];

// Returns the ordered task list, or [] until the PM has launched the client's
// tasks (sent the intro email). A project already in production counts too — it
// implies onboarding happened even if the flag predates this feature.
export function deriveProjectTasks(bundle = {}) {
  const { deal } = bundle;
  if (!deal || (!deal.client_tasks_launched_at && !deal.production_phase)) return [];
  const tasks = [];
  for (const produce of TASK_PRODUCERS) {
    let task = null;
    try { task = produce(bundle); } catch { task = null; }
    if (task) tasks.push(task);
  }
  return tasks;
}

// Convenience: how many tasks still need the client (for the dashboard badge).
export function countOpenTasks(tasks = []) {
  return tasks.filter((t) => t.status === 'todo').length;
}

// Pure cadence decision for the automatic reminder cron (kept DB-free so it's
// unit-testable). We remind when: tasks have launched, there's still ≥1 open
// task, we're under the reminder cap, and the cadence window has elapsed since
// the last reminder (or since launch, for the first one).
export function shouldRemind({ launchedAt, remindedAt, count = 0, everyDays = 3, maxReminders = 3, openCount = 0, now = new Date() }) {
  if (!launchedAt) return false;
  if (openCount <= 0) return false;
  if (count >= maxReminders) return false;
  const since = remindedAt ? new Date(remindedAt) : new Date(launchedAt);
  const dueAt = since.getTime() + Math.max(1, everyDays) * 24 * 60 * 60 * 1000;
  return now.getTime() >= dueAt;
}
