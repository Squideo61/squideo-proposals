// The portal's "Your tasks for this project" list. Like nextStep.js, it's a
// pure, server-side derivation from deal + video state so the project page, the
// dashboard and the ball-in-court banner always agree. No DB access here — the
// caller gathers the bundle.
//
// It's a registry: each producer inspects the bundle and returns a task (or
// null). Adding a task later is one entry. A task is:
//   { key, title, detail, status: 'todo'|'done'|'locked', cta: { href } }
// Tasks only appear once a project is actually in production (production_phase
// set) — that's when the PM sends the "here are your tasks" email.

const TASK_PRODUCERS = [
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

// Returns the ordered task list, or [] when the project isn't in production yet.
export function deriveProjectTasks(bundle = {}) {
  const { deal } = bundle;
  if (!deal || !deal.production_phase) return [];
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
