// A whole client portal, invented.
//
// Staff need to see what a client sees at each point in the relationship —
// before signing, mid-production, at review, once it's delivered — and the only
// way to do that used to be seeding a demo company, a demo deal and a demo
// portal invite into the live database. That put a fake customer in the
// pipeline, in Finance and in the activity feed, and it could only ever be in
// ONE state at a time: to see the "waiting on your storyboard" screen you had
// to drag the fake project into that stage and then drag it back.
//
// So this is fixtures, following the same reasoning as the sample project in
// ./fixtures.js: NOTHING HERE TOUCHES THE DATABASE. Demo mode intercepts the
// portal's API client (src/portal/api.js) and answers from these objects
// instead, so every real page renders against them with no special cases. The
// state is a switch, not a migration — flipping from "prospect" to "delivered"
// is instant and reversible because there was never anything to migrate.
//
// The shapes here must match what api/portal.js actually returns. Where they
// drift the demo shows an empty state rather than a crash, which is the right
// failure: a demo that lies about a screen is worse than one that admits it
// hasn't got that screen.

const now = Date.now();
const ago = (mins) => new Date(now - mins * 60000).toISOString();
const soon = (mins) => new Date(now + mins * 60000).toISOString();

export const DEMO_QUERY_KEY = 'demo';

// The five moments worth looking at. Each is a point where the portal shows a
// materially different thing, not just a different label.
export const DEMO_STATES = [
  {
    id: 'prospect',
    label: 'Prospect',
    blurb: 'No project yet. The video guide and the brief builder are the whole portal — this is what a lead magnet signup sees.',
  },
  {
    id: 'signed',
    label: 'Just signed',
    blurb: 'Deposit paid, nothing filmed. Their task list is at its longest: brand files, script, voiceover, kick-off call.',
  },
  {
    id: 'production',
    label: 'In production',
    blurb: 'Storyboard is with them for sign-off. The ball is in their court and the portal says so.',
  },
  {
    id: 'revisions',
    label: 'In revisions',
    blurb: 'First cut is up for review. Extras are being offered, and the final download is still locked behind the balance.',
  },
  {
    id: 'delivered',
    label: 'Delivered',
    blurb: 'Signed off, paid, downloadable. Library populated, and the portal starts nudging toward the next video.',
  },
];

export const DEFAULT_DEMO_STATE = 'signed';
const isState = (id) => DEMO_STATES.some((s) => s.id === id);

// ── mode ─────────────────────────────────────────────────────────────────────
// Read from the URL and ONLY from the URL. It was briefly held in
// sessionStorage, which is wrong in a way worth writing down: an iframe
// shares its parent tab's sessionStorage, and window.open copies it into the
// new tab. So the admin panel embedding this demo would leave a "you are in
// demo mode" flag lying around in the same tab a staff member then opens a
// REAL client's portal preview from — and a real portal quietly answering
// from fixtures is the single worst bug this feature could have.
//
// The query string survives hash navigation, so the URL carries it for free.
let cached;

export function readDemoStateFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has(DEMO_QUERY_KEY)) return null;
    const v = params.get(DEMO_QUERY_KEY);
    return isState(v) ? v : DEFAULT_DEMO_STATE;
  } catch { return null; }
}

// Resolved once per page load: demo mode cannot start or stop mid-session,
// and re-parsing the URL on every API call would be work for an answer that
// never changes.
export function getDemoState() {
  if (cached === undefined) cached = readDemoStateFromUrl();
  return cached;
}

// Exposed for the entry point, which resolves the mode before React mounts.
export function setDemoState(state) {
  cached = state && isState(state) ? state : null;
}

export const isDemoMode = () => !!getDemoState();

// ── the cast ─────────────────────────────────────────────────────────────────
// Named people, not "User 1". Presence, activity feeds and comment threads are
// only legible when the names read like colleagues.
// EVERY NAME IN HERE MUST BE UNMISTAKABLY INVENTED, and must not collide with
// a real client or a real project. The first version called the project
// "CareConnect launch film", which is the name of an actual live project for
// an actual care client — so the demo looked exactly like their portal, and
// the one thing a demo must never do is leave someone unsure whose data they
// are reading. The banner saying "nothing here is real" cannot outshout a
// name they recognise.
//
// Hence Northwind: a sample-data name for as long as sample data has existed,
// with .example addresses (a reserved TLD that can never be registered) and a
// product named after the invented company, so it cannot drift onto a real
// one later.
const COMPANY = { id: 'demo-co', name: 'Northwind Care Group', prospect: false, creditVisible: true, logoUrl: null };

// The org as the SELECTED state sees it. A prospect — someone who signed
// themselves up off a landing page and has no project yet — gets a portal that
// is genuinely shaped differently: the rail splits under "When your project
// starts", the header offers the brief rather than "New video", and the rate
// card is gone. The demo has to reproduce that, or the one state that shows the
// newest visitor's experience is the one state that shows it wrong.
const companyFor = (state) => (state === 'prospect'
  ? { ...COMPANY, prospect: true, creditVisible: false }
  : COMPANY);
// hasPassword:false on purpose — the demo cast are self-serve signups, which
// is what makes the 'set a password' offer on the finished brief visible here.
const ME = { id: 'demo-me', name: 'Alex Morgan', email: 'alex@northwindcare.example', jobTitle: 'Marketing Lead', hasPassword: false };
const PRIYA = { id: 'demo-priya', name: 'Priya Shah', email: 'priya@northwindcare.example' };
const TOM = { id: 'demo-tom', name: 'Tom Ellery', email: 'tom@northwindcare.example' };

const DEAL_ID = 'demo-deal';

// The guide, as api/portal.js's courseRoute returns it. Titles and numbers are
// the real ones so that "Video 6 — metrics that matter" in a brief question
// opens something that says the same thing; only the watch history is invented.
//
// There is no playable file here and there is not meant to be: mediaUrl() is not
// intercepted by demo mode, so a src would be a real request for a real blob on
// behalf of a client who does not exist. GuidePlayer shows a placeholder in demo
// mode instead — see src/portal/GuideVideo.jsx.
const COURSE_MODULES = [
  { n: 1, slug: 'what-a-video-can-do', title: 'What a video can actually do', seconds: 52, watched: true },
  { n: 2, slug: 'the-one-message-rule', title: 'The one-message rule', seconds: 61, watched: true },
  { n: 3, slug: 'who-you-are-talking-to', title: 'Who you are talking to', seconds: 47, watched: true },
  { n: 4, slug: 'look-and-feel', title: 'Look and feel, without the guesswork', seconds: 44, watched: false },
  { n: 5, slug: 'where-it-gets-seen', title: 'Where it gets seen', seconds: 39, watched: false },
  { n: 6, slug: 'metrics-that-matter', title: 'Metrics that matter', seconds: 55, watched: false },
  { n: 7, slug: 'the-feedback-trap', title: 'The feedback trap', seconds: 58, watched: false },
  { n: 8, slug: 'what-happens-next', title: 'What happens next', seconds: 32, watched: false },
];

const courseFixture = () => {
  const modules = COURSE_MODULES.map((m) => ({
    id: `demo-course-${m.n}`,
    slug: m.slug,
    moduleNumber: m.n,
    title: m.title,
    subtitle: null,
    description: null,
    durationSeconds: m.seconds,
    posterUrl: null,
    resumeSeconds: 0,
    completed: m.watched,
    started: m.watched,
  }));
  const completed = modules.filter((m) => m.completed).length;
  return {
    modules,
    completedCount: completed,
    totalCount: modules.length,
    percentComplete: Math.round((completed / modules.length) * 100),
    continueSlug: (modules.find((m) => !m.completed) || null)?.slug || null,
    allComplete: completed === modules.length,
  };
};

// EVERY KEY HERE MUST BE A REAL QUESTION KEY, and every chip value a real
// option value — see api/_lib/brief/questions.js. An invented key is not an
// error anywhere: the brief simply renders that question as unanswered, and the
// demo quietly shows a less complete brief than it claims to. This set used to
// carry `action`, `metric`, `problem`, `message` and `tone`, none of which
// exist, plus volume: '1' where the option is 'one'.
//
// Deliberately stops part-way through the message screen, so the demo opens on
// the welcome-back banner with answered rows behind it — the state most people
// are in when they come back to a brief, and the one worth looking at.
export const DEMO_BRIEF_ANSWERS = {
  projectName: 'Northwind Ordering launch film',
  goal: 'onboard',
  goalDetail: 'Introducing the ordering portal to existing care-home customers.',
  oneAction: 'Contact their account manager to book a demonstration.',
  successMetric: 'Demo bookings',
  successBaseline: 'About four a month',
  audience: 'The people responsible for purchasing, budgets and operational efficiency in care homes — owners, group directors, home managers, finance teams and senior administrators.',
  awareness: 'problem',
  placements: ['homepage', 'sales'],
  length: '60-90',
  oneMessage: 'Ordering, budgets and approvals in one place, so nothing is chased twice.',
  deadline: 'Mid-October, ahead of the regional conference',
  deadlineDriver: 'The regional care conference — we exhibit and want it on the stand.',
  budget: '5-10k',
  volume: 'one',
};

// A brief three people have been through, which is the whole point of the
// activity feed — one person's brief has nothing to show.
const BRIEF_ACTIVITY = [
  { id: 'd-e6', actorName: 'Priya Shah', portalUserId: PRIYA.id, eventKey: 'answer.changed', questionKey: 'metric', questionLabel: "What's the one number that would tell you it worked?", summary: 'Demo bookings', text: 'Priya Shah answered “What’s the one number that would tell you it worked?”', at: ago(9) },
  { id: 'd-e5', actorName: 'Tom Ellery', portalUserId: TOM.id, eventKey: 'answer.changed', questionKey: 'budget', questionLabel: 'Roughly what budget do you have in mind?', summary: '£5,000 – £10,000', text: 'Tom Ellery updated “Roughly what budget do you have in mind?”', at: ago(52) },
  { id: 'd-e4', actorName: 'Alex Morgan', portalUserId: ME.id, eventKey: 'answer.changed', questionKey: 'audience', questionLabel: 'Describe the person you want watching this', summary: 'The people responsible for purchasing, budgets and operational…', text: 'Alex Morgan updated “Describe the person you want watching this”', at: ago(96) },
  { id: 'd-e3', actorName: 'Priya Shah', portalUserId: PRIYA.id, eventKey: 'answer.changed', questionKey: 'tone', questionLabel: 'How should it feel?', summary: 'Warm and human', text: 'Priya Shah answered “How should it feel?”', at: ago(140) },
  { id: 'd-e2', actorName: 'Alex Morgan', portalUserId: ME.id, eventKey: 'brief.attached', questionKey: null, questionLabel: null, summary: null, text: 'Alex Morgan linked this brief to Northwind Ordering launch film', at: ago(190) },
  { id: 'd-e1', actorName: 'Alex Morgan', portalUserId: ME.id, eventKey: 'brief.created', questionKey: null, questionLabel: null, summary: null, text: 'Alex Morgan started this brief', at: ago(240) },
];

// Someone else mid-sentence, so the presence indicator has something to show.
const BRIEF_PRESENCE = [
  { portalUserId: PRIYA.id, name: 'Priya Shah', questionKey: 'problem', at: ago(0) },
  { portalUserId: TOM.id, name: 'Tom Ellery', questionKey: null, at: ago(1) },
];

// ── per-state facts ──────────────────────────────────────────────────────────
// One table rather than five branches: adding a state means adding a row, and
// what differs between states stays visible side by side.
const STATE = {
  prospect: {
    hasProject: false,
    briefLocked: false,
    production: { phase: null, stage: null },
    stage: 'proposal_sent',
    nextStep: { court: 'you', title: 'Finish your video brief', detail: 'You’re 12 of 25 questions in.', cta: 'Open the brief', href: '#/brief' },
    tasks: [],
    videos: [],
    libraryCount: 0,
    extras: 0,
    unlocked: false,
  },
  signed: {
    hasProject: true,
    briefLocked: false,
    production: { phase: 'pre_pro', stage: 'kickoff' },
    stage: 'paid',
    nextStep: { court: 'you', title: 'Four things to send us', detail: 'Brand files, your script direction, a voiceover pick and a kick-off call.', cta: 'Open your tasks', href: `#/project/${DEAL_ID}` },
    tasks: [
      { key: 'brand', title: 'Upload your brand guidelines & logo', detail: 'Fonts, colours, logo files — whatever you have.', status: 'todo', cta: { action: 'documents', label: 'Upload' } },
      { key: 'script', title: 'Send us your script & visual direction', detail: 'Or tell us to write it — that’s an option too.', status: 'todo', cta: { action: 'script', label: 'Send' } },
      { key: 'voiceover', title: 'Choose your voiceover', detail: 'Listen to samples and pick the voice.', status: 'todo', cta: { action: 'voiceover', label: 'Listen' } },
      { key: 'kickoff', title: 'Book your kick-off call', detail: '30 minutes with your producer.', status: 'done', detailDone: 'Wed 26 Aug, 12:00' },
    ],
    videos: [{ stage: 'kickoff', phase: 'pre_pro' }],
    libraryCount: 0,
    extras: 6,
    unlocked: false,
  },
  production: {
    hasProject: true,
    briefLocked: true,
    production: { phase: 'production', stage: 'storyboard' },
    stage: 'paid',
    nextStep: { court: 'you', title: 'Your storyboard is ready to review', detail: 'Pin notes to any frame, then sign it off.', cta: 'Review the storyboard', href: `#/project/${DEAL_ID}` },
    tasks: [
      { key: 'brand', title: 'Upload your brand guidelines & logo', status: 'done', detailDone: '3 files' },
      { key: 'script', title: 'Send us your script & visual direction', status: 'done', detailDone: 'Received 4 Aug' },
      { key: 'voiceover', title: 'Choose your voiceover', status: 'done', detailDone: 'Erin — warm, British' },
      { key: 'storyboard', title: 'Review the storyboard', detail: 'Change it here and it costs nothing.', status: 'todo', cta: { action: 'storyboard', label: 'Review' } },
    ],
    videos: [{ stage: 'storyboard', phase: 'production' }],
    libraryCount: 0,
    extras: 6,
    unlocked: false,
  },
  revisions: {
    hasProject: true,
    briefLocked: true,
    production: { phase: 'production', stage: 'revisions' },
    stage: 'paid',
    nextStep: { court: 'you', title: 'Your first cut is ready', detail: 'Comment at the exact second, then approve.', cta: 'Review the video', href: `#/project/${DEAL_ID}` },
    tasks: [
      { key: 'review', title: 'Review the first cut', detail: 'Your whole team comments in one place.', status: 'todo', cta: { action: 'review', label: 'Open review' } },
    ],
    videos: [{ stage: 'revisions', phase: 'production' }],
    libraryCount: 0,
    extras: 6,
    unlocked: false,
  },
  delivered: {
    hasProject: true,
    briefLocked: true,
    production: { phase: 'completed', stage: 'delivered' },
    stage: 'paid',
    nextStep: { court: 'us', title: 'Your video is ready 🎉', detail: 'Download it in any format you need.', cta: 'Open your library', href: '#/library' },
    tasks: [],
    videos: [{ stage: 'delivered', phase: 'completed' }],
    libraryCount: 3,
    extras: 4,
    unlocked: true,
  },
};

const PHASE_LABEL = {
  pre_pro: 'Pre-production', production: 'Production', completed: 'Completed',
};
const STAGE_LABEL = {
  kickoff: 'Kick-off', storyboard: 'Storyboard', revisions: 'Your review',
  signed_off: 'Signed off', delivered: 'Delivered',
};

function project(s) {
  return {
    id: DEAL_ID,
    title: 'Northwind Ordering launch film',
    companyId: COMPANY.id,
    companyName: COMPANY.name,
    stage: s.stage,
    stageLabel: s.stage === 'paid' ? 'Signed' : 'Proposal sent',
    paymentTerms: null,
    hasPoNumber: false,
    production: {
      phase: s.production.phase,
      phaseLabel: PHASE_LABEL[s.production.phase] || null,
      phaseColor: '#2BB8E6',
      stageLabel: STAGE_LABEL[s.production.stage] || null,
    },
    inProduction: !!s.production.phase,
    createdAt: ago(60 * 24 * 26),
    deliveryDeadline: soon(60 * 24 * 21),
    nextStep: s.nextStep,
    tasks: s.tasks,
    openTasks: s.tasks.filter((t) => t.status !== 'done').length,
    extrasAvailable: s.extras,
    videos: s.videos.map((v, i) => ({
      id: `demo-v${i + 1}`,
      title: 'Northwind Ordering launch film',
      reference: '2607-014-01',
      production: {
        phase: v.phase,
        phaseLabel: PHASE_LABEL[v.phase] || null,
        phaseColor: '#2BB8E6',
        stageLabel: STAGE_LABEL[v.stage] || null,
      },
    })),
  };
}

function briefSummary(s) {
  const answered = s.briefLocked ? 25 : 18;
  return {
    id: 'demo-brief',
    title: 'Northwind Ordering launch film',
    dealId: s.hasProject ? DEAL_ID : null,
    dealTitle: s.hasProject ? 'Northwind Ordering launch film' : null,
    dealReference: s.hasProject ? '2607-014' : null,
    completedAt: s.briefLocked ? ago(200) : null,
    submittedAt: s.briefLocked ? ago(198) : null,
    submittedBy: s.briefLocked ? 'Alex Morgan' : null,
    reopenedAt: null,
    locked: s.briefLocked,
    contributors: 3,
    createdAt: ago(60 * 30),
    updatedAt: ago(9),
    done: answered,
    total: 25,
    pct: Math.round((answered / 25) * 100),
  };
}

// ── the fake server ──────────────────────────────────────────────────────────
// Keyed by the portal `action`. Anything absent falls through to `{}`, which
// every page treats as "nothing here" rather than crashing.
function respond(state, method, action, query, body) {
  const s = STATE[state] || STATE[DEFAULT_DEMO_STATE];

  switch (action) {
    case 'me':
      return {
        user: { ...ME, companies: [companyFor(state)] },
        sampleProject: { available: true },
        // Deliberately NOT flagged as a preview: preview chrome says "you're
        // looking at a real client's portal", and this is the opposite claim.
        // The demo banner is drawn by the portal shell from demo mode itself.
        preview: null,
      };

    case 'overview':
      return {
        company: companyFor(state),
        companies: [companyFor(state)],
        projects: s.hasProject ? [project(s)] : [],
        actionNeeded: s.hasProject && s.nextStep.court === 'you' ? 1 : 0,
        suggestCredit: state === 'delivered',
        brandFileCount: s.hasProject && state !== 'signed' ? 3 : 0,
        briefDraft: s.briefLocked ? null : {
          id: 'demo-brief',
          updatedAt: ago(9),
          projectName: DEMO_BRIEF_ANSWERS.projectName,
          ...briefSummary(s),
        },
      };

    case 'project':
      if (!s.hasProject) return { project: null };
      return {
        project: {
          ...project(s),
          finalReleaseUnlocked: s.unlocked,
          schedule: null,
          proposal: { id: 'demo-prop', signed: true },
          reviews: state === 'revisions' || state === 'delivered'
            ? [{ token: 'demo-sample-project', label: 'Northwind Ordering launch film' }] : [],
          storyboards: state === 'production'
            ? [{ token: 'demo-sample-storyboard', label: 'Northwind Ordering storyboard' }] : [],
          files: s.hasProject && state !== 'signed' ? [
            { id: 'demo-f1', filename: 'Northwind-brand-guidelines.pdf', mimeType: 'application/pdf', sizeBytes: 2_400_000, createdAt: ago(60 * 24 * 12) },
            { id: 'demo-f2', filename: 'northwind-logo-pack.zip', mimeType: 'application/zip', sizeBytes: 880_000, createdAt: ago(60 * 24 * 12) },
          ] : [],
          extras: state === 'delivered'
            ? [{ id: 'demo-x1', description: 'Mobile-friendly 9:16 portrait version', amount: 360, status: 'paid', createdAt: ago(60 * 24 * 4) }]
            : [],
          extrasAvailable: s.extras,
          extrasWindowOpen: s.hasProject && state !== 'delivered',
        },
      };

    case 'notifications':
      return {
        notifications: s.hasProject ? [
          { id: 'demo-n1', key: 'brief.changed', title: 'Priya Shah updated Northwind Ordering launch film', body: '3 changes — open the brief to see what moved.', link: '#/brief/demo-brief', createdAt: ago(9), readAt: null },
          { id: 'demo-n2', key: 'project.stage', title: 'Your storyboard is ready', body: 'Northwind Ordering launch film', link: `#/project/${DEAL_ID}`, createdAt: ago(60 * 20), readAt: ago(60 * 19) },
        ] : [],
        unreadCount: s.hasProject ? 1 : 0,
        tasks: s.tasks.filter((t) => t.status !== 'done').map((t) => ({
          key: `${DEAL_ID}:${t.key}`, title: t.title, detail: t.detail || null,
          dealId: DEAL_ID, dealTitle: 'Northwind Ordering launch film',
        })),
      };

    // ── the brief, which is the thing most worth demoing ──────────────────
    case 'brief': {
      const brief = briefSummary(s);
      if (query.get('id')) {
        return {
          brief: { ...brief, answers: DEMO_BRIEF_ANSWERS },
          // Colleagues only, exactly as the real route filters it — the demo is
          // no use for judging a screen if it shows a feed the client cannot
          // actually see. The cursor stays off the unfiltered list.
          activity: BRIEF_ACTIVITY.filter((e) => e.portalUserId && e.portalUserId !== ME.id),
          activityCursor: BRIEF_ACTIVITY[0]?.id || null,
          presence: brief.locked ? [] : BRIEF_PRESENCE,
          readOnly: false,
          canReopen: false,
        };
      }
      return {
        briefs: [brief],
        activeId: brief.id,
        projects: s.hasProject
          ? [{ id: DEAL_ID, title: 'Northwind Ordering launch film', reference: '2607-014', signed: true }]
          : [],
        readOnly: false,
      };
    }

    case 'brief-tick':
      return {
        presence: s.briefLocked ? [] : BRIEF_PRESENCE,
        events: [],
        answers: DEMO_BRIEF_ANSWERS,
        updatedAt: ago(9),
        locked: s.briefLocked,
      };

    case 'library':
      return {
        items: s.libraryCount ? [
          { id: 'demo-l1', title: 'Northwind Ordering launch film', kind: 'delivered', createdAt: ago(60 * 24 * 2), thumbnailUrl: null, downloadUrl: null },
          { id: 'demo-l2', title: 'Northwind Ordering launch film — 9:16', kind: 'delivered', createdAt: ago(60 * 24 * 2), thumbnailUrl: null, downloadUrl: null },
          { id: 'demo-l3', title: 'Northwind recruitment film (2025)', kind: 'past', createdAt: ago(60 * 24 * 400), thumbnailUrl: null, downloadUrl: null },
        ] : [],
      };

    case 'files':
      return {
        files: state === 'signed' || !s.hasProject ? [] : [
          { id: 'demo-f1', filename: 'Northwind-brand-guidelines.pdf', category: 'brand', mimeType: 'application/pdf', sizeBytes: 2_400_000, createdAt: ago(60 * 24 * 12) },
          { id: 'demo-f2', filename: 'northwind-logo-pack.zip', category: 'brand', mimeType: 'application/zip', sizeBytes: 880_000, createdAt: ago(60 * 24 * 12) },
        ],
      };

    case 'extras':
      return {
        dealId: DEAL_ID,
        dealTitle: 'Northwind Ordering launch film',
        windowOpen: s.hasProject && state !== 'delivered',
        discount: 0.1,
        offers: s.extras ? [
          { key: 'prop:vo', kind: 'proposal', title: 'Professional human voiceover artist', description: null, originalAmount: 125, amount: 112.5, hasQuantity: false, alreadyPurchased: false },
          { key: 'prop:short', kind: 'proposal', title: 'Short edit — cut from main content', description: null, originalAmount: 300, amount: 270, hasQuantity: false, alreadyPurchased: false },
          { key: 'prop:subs', kind: 'proposal', title: 'Hard-coded English subtitled version', description: null, originalAmount: 125, amount: 112.5, hasQuantity: false, alreadyPurchased: false },
          { key: 'prop:portrait', kind: 'proposal', title: 'Mobile-friendly 9:16 portrait version', description: null, originalAmount: 400, amount: 360, hasQuantity: false, alreadyPurchased: false },
        ].slice(0, s.extras) : [],
        accepted: state === 'delivered'
          ? [{ id: 'demo-x1', description: 'Mobile-friendly 9:16 portrait version', amount: 360, status: 'paid' }]
          : [],
      };

    case 'course':
      return courseFixture();

    case 'team':
      return {
        members: [
          { id: ME.id, name: ME.name, email: ME.email, jobTitle: ME.jobTitle, lastLoginAt: ago(3), disabledAt: null },
          { id: PRIYA.id, name: PRIYA.name, email: PRIYA.email, jobTitle: 'Operations Director', lastLoginAt: ago(40), disabledAt: null },
          { id: TOM.id, name: TOM.name, email: TOM.email, jobTitle: 'Finance', lastLoginAt: ago(60 * 30), disabledAt: null },
        ],
        invites: [],
      };

    case 'video-credit':
      return {
        balance: { issued: 0, used: 0, remaining: 0 },
        pricing: { ratePerMin: 950, tiers: [] },
        orders: [],
      };

    // Writes and telemetry: accepted and dropped. A demo that errors when you
    // click something is a demo of an error.
    case 'track':
    case 'course-progress':
    case 'demo-event':
      return { ok: true };

    default:
      return {};
  }
}

// Called by src/portal/api.js in place of fetch. Async so it matches the real
// client's contract exactly — a page that awaits is a page that awaits.
export async function demoRequest(method, path, body) {
  const state = getDemoState() || DEFAULT_DEMO_STATE;
  const qi = path.indexOf('?');
  const action = qi === -1 ? path : path.slice(0, qi);
  const query = new URLSearchParams(qi === -1 ? '' : path.slice(qi + 1));
  // A beat of latency, so loading states are visible rather than skipped —
  // staff reviewing the portal should see what a client sees, spinners included.
  await new Promise((r) => setTimeout(r, 120));
  return respond(state, method, action, query, body);
}
