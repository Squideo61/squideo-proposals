// The video brief, as questions.
//
// ONE definition, imported by both the API (to render a submitted brief into
// something the team can read) and by src/portal/pages/Brief.jsx (to draw it).
// Pure data with no imports, so the browser bundle can pull it in directly —
// the alternative is two copies that drift, which is how a brief ends up with
// answers nobody can map back to a question.
//
// Derived from Squideo's existing "Video Brief Template" PDF, restructured:
//   · The PDF's "Your Details" section is gone. Name, email, phone, company and
//     website are all on the account already — five fields removed for free.
//   · Questions carry `why`, tied to the video guide where relevant. Someone
//     who has watched video 2 recognises the one-message rule and answers it
//     properly; someone who hasn't gets taught it at the moment it matters.
//   · Placement is asked BEFORE length, because length is a consequence of
//     where a video plays and asking it first invites a number pulled from air.
//   · Budget is bands, never an open field. Open budget fields come back blank
//     or anchored low.
//   · The script section is last, collapsed, and explicitly optional. Most
//     people should skip it, and saying so is what stops them abandoning.
//
// `key` is a stable identifier stored in client_briefs.answers. NEVER rename
// one — old briefs would lose that answer. Add new keys instead.

export const LENGTH_BY_PLACEMENT = {
  social_short: '30-60',
  social_feed: '30-60',
  ads: 'under-30',
  homepage: '60-90',
  landing: '60-90',
  email: '30-60',
  sales: '90-120',
  event: 'under-30',
  internal: '120-plus',
};

export const SCREENS = [
  {
    key: 'video',
    title: 'The video',
    blurb: "Five questions. If you're not sure on any of them, say so — \"not sure\" is a useful answer and we'd rather have it than a guess.",
    questions: [
      {
        key: 'projectName', type: 'text', required: true,
        label: 'What shall we call this project?',
        placeholder: 'e.g. Onboarding explainer, Series A launch film',
        why: "Just so we both know which video we're talking about. You can change it later.",
      },
      {
        key: 'goal', type: 'chips', required: true,
        label: 'What is this video for?',
        options: [
          { value: 'explain', label: 'Explaining a product or service' },
          { value: 'sell', label: 'Winning new customers' },
          { value: 'onboard', label: 'Onboarding or training' },
          { value: 'recruit', label: 'Recruitment' },
          { value: 'awareness', label: 'Raising awareness' },
          { value: 'other', label: 'Something else' },
        ],
        why: 'Pick the single biggest one. A video built for two jobs usually does neither — the structure that explains well is not the structure that sells well.',
      },
      {
        key: 'goalDetail', type: 'text',
        label: 'Anything to add to that?',
        placeholder: 'Optional — one line is plenty',
      },
      {
        key: 'oneAction', type: 'textarea', rows: 3, required: true,
        label: 'If someone watches this and does one thing afterwards, what is it?',
        placeholder: 'e.g. Book a demo. Understand what we actually do. Stop emailing support about it.',
        why: 'Video 2 — the one-message rule. A video that asks for three things gets none of them. This single answer shapes the whole script.',
        videoRef: 2,
      },
      {
        key: 'successMetric', type: 'text',
        label: "What's the one number that would tell you it worked?",
        placeholder: 'e.g. Demo bookings, support tickets, trial signups, time-to-onboard',
        why: "Video 6 — metrics that matter. Views aren't a result. Picking the number now means we can build towards it, and you can tell afterwards whether it was worth the money.",
        videoRef: 6,
      },
      {
        key: 'successBaseline', type: 'text',
        label: 'And roughly what is that number today?',
        placeholder: 'Optional — a rough figure is fine',
      },
    ],
  },

  {
    key: 'audience',
    title: "Who it's for",
    blurb: 'The more specific you can be, the better the script. "Everyone" is the hardest audience to write for.',
    questions: [
      {
        key: 'audience', type: 'textarea', rows: 4, required: true,
        label: 'Describe the person you want watching this',
        placeholder: 'Their job, what they are trying to get done, what they already tried, what annoys them.',
        why: "Write it as one real person rather than a segment. It's much easier to hold one person in your head while writing a script.",
      },
      {
        key: 'awareness', type: 'chips',
        label: 'How much do they already know about you?',
        options: [
          { value: 'cold', label: "Never heard of us" },
          { value: 'problem', label: 'Knows they have the problem' },
          { value: 'comparing', label: 'Comparing us with others' },
        ],
        why: 'This decides where the video starts. A cold viewer needs the problem explained; someone already comparing options finds that patronising and clicks away.',
      },
      {
        key: 'placements', type: 'multi',
        label: 'Where will it actually be seen?',
        options: [
          { value: 'homepage', label: 'Our homepage' },
          { value: 'landing', label: 'A landing page' },
          { value: 'social_feed', label: 'LinkedIn / Facebook' },
          { value: 'social_short', label: 'Instagram / TikTok / Shorts' },
          { value: 'ads', label: 'Paid ads' },
          { value: 'email', label: 'Email' },
          { value: 'sales', label: 'Sales meetings' },
          { value: 'event', label: 'Events and trade shows' },
          { value: 'internal', label: 'Internal / training' },
          { value: 'unsure', label: 'Not sure yet' },
        ],
        why: "Video 5 — distribution. Most projects decide this after the video is made, which is why so many good videos get watched by nobody. It also changes the edit: a video for a silent autoplay feed needs subtitles and a hook in the first second.",
        videoRef: 5,
      },
      {
        key: 'length', type: 'chips',
        label: 'How long should it be?',
        options: [
          { value: 'under-30', label: 'Under 30 seconds' },
          { value: '30-60', label: '30–60 seconds' },
          { value: '60-90', label: '60–90 seconds' },
          { value: '90-120', label: '90 seconds – 2 minutes' },
          { value: '120-plus', label: 'Over 2 minutes' },
          { value: 'unsure', label: 'Not sure — recommend one' },
        ],
        why: "We suggest one based on where you said it'll be seen. Change it if you disagree — you know your audience.",
        suggestFrom: 'placements',
      },
    ],
  },

  {
    key: 'message',
    title: 'The message',
    questions: [
      {
        key: 'oneMessage', type: 'textarea', rows: 3, required: true,
        label: 'In one sentence, what must they remember?',
        placeholder: 'If they forgot everything else in the video but kept this one thing, what would it be?',
        why: 'This becomes the spine of the script. Everything that survives the edit is here to support this sentence.',
        videoRef: 2,
      },
      {
        key: 'keyPoints', type: 'textarea', rows: 5,
        label: 'Anything else worth covering?',
        placeholder: 'Bullet points are perfect. We can work from as little as a list of key points.',
      },
      {
        key: 'mustInclude', type: 'textarea', rows: 3,
        label: 'Anything that has to be in it?',
        placeholder: 'Legal wording, a disclaimer, a specific product name, a stat you need to land.',
      },
      {
        key: 'mustAvoid', type: 'textarea', rows: 3,
        label: 'Anything that must not be?',
        placeholder: 'Claims you can\'t make, a competitor you\'d rather not name, jargon your audience hates.',
        why: 'Genuinely useful — this is usually the stuff that causes a re-edit when nobody mentioned it up front.',
      },
    ],
  },

  {
    key: 'style',
    title: 'Look and feel',
    blurb: '"Not sure — recommend one" is a completely legitimate answer to all of these. Recommending is most of what we do.',
    questions: [
      {
        key: 'characters', type: 'chips',
        label: 'Should it have characters or people in it?',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No — graphics and text' },
          { value: 'unsure', label: 'Not sure — recommend one' },
        ],
      },
      {
        // NO PRICE HERE, deliberately. Budget is asked once, as a band, in
        // Practicalities. A cost signal attached to an option mid-brief makes
        // people self-downgrade before they've decided what the video needs,
        // and the answer stops describing the video and starts describing
        // their nerve. Saying "an upgrade" in the why-we-ask is enough to stop
        // the quote being a surprise without anchoring the choice.
        key: 'voiceover', type: 'chips',
        label: 'Voiceover?',
        options: [
          { value: 'ai', label: 'AI voice — your standard' },
          { value: 'pro', label: 'A professional voice artist' },
          { value: 'client', label: 'Someone on our side will record it' },
          { value: 'none', label: 'No voiceover — text on screen' },
          { value: 'unsure', label: 'Not sure — recommend one' },
        ],
        why: "Every video comes with a latest-generation AI voice as standard, and it's good enough now that most videos ship with one. A professional artist is an upgrade worth considering when the video is customer-facing and the voice is doing emotional work rather than just narrating. Say \"not sure\" and we'll tell you which we'd use.",
      },
      {
        key: 'music', type: 'chips',
        label: 'Music?',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'unsure', label: 'Not sure — recommend one' },
        ],
      },
      {
        key: 'references', type: 'textarea', rows: 5,
        label: 'Any videos you like the look of?',
        placeholder: 'Paste links — and, more usefully, say what you like about each one. "The pacing" and "the colours" send us in completely different directions.',
        why: 'The what-you-like-about-it half matters more than the link. Ours are at squideo.com/video-examples if it helps to point at one.',
        videoRef: 4,
      },
      {
        key: 'brandAssets', type: 'chips',
        label: 'What brand material do you have?',
        options: [
          { value: 'guidelines', label: 'Full brand guidelines' },
          { value: 'logo_colours', label: 'Logo and colours' },
          { value: 'logo', label: 'Just a logo' },
          { value: 'none', label: 'Nothing yet' },
        ],
      },
    ],
  },

  {
    key: 'practical',
    title: 'Practicalities',
    questions: [
      {
        key: 'deadline', type: 'text',
        label: 'When do you need it?',
        placeholder: 'A date, a month, or "no fixed deadline"',
      },
      {
        key: 'deadlineDriver', type: 'text',
        label: "What's driving that date?",
        placeholder: 'e.g. A launch, an event, a board meeting, the start of the quarter',
        why: "If a date is tied to something real we'll plan back from it. If it's a guess, we'll tell you honestly what's comfortable.",
      },
      {
        // Asked BEFORE budget, because it changes what the budget answer means:
        // "£5-10k" for one video and "£5-10k for the first of six" are entirely
        // different projects. It's also the question that decides whether this
        // is a one-off or the start of a programme — the thing that makes
        // buying production time in bulk sensible later.
        //
        // Deliberately framed as a CREATIVE question, with no mention of credit
        // or price. It genuinely changes how you build the first video (shared
        // assets, a reusable style), and the commercial signal is a free side
        // effect. Naming a rate here would reintroduce exactly the anchoring
        // the note at the top of this file exists to prevent.
        key: 'volume', type: 'chips',
        label: 'Is this a one-off, or the first of a few?',
        options: [
          { value: 'one', label: 'Just this one' },
          { value: 'few', label: 'Two or three over the next year' },
          { value: 'programme', label: 'A steady stream — several a quarter' },
          { value: 'unsure', label: 'Not sure yet' },
        ],
        why: "If there's more coming we'll build this one so the rest are faster and cheaper to make — same style, same assets, no starting from scratch every time. It changes how we'd approach the first one, so it's worth saying now.",
      },
      {
        key: 'budget', type: 'chips',
        label: 'Roughly what budget are you working to?',
        options: [
          { value: 'under-2k', label: 'Under £2,000 ex VAT' },
          { value: '2-5k', label: '£2,000 – £5,000 ex VAT' },
          { value: '5-10k', label: '£5,000 – £10,000 ex VAT' },
          { value: '10-20k', label: '£10,000 – £20,000 ex VAT' },
          { value: '20k-plus', label: '£20,000+ ex VAT' },
          { value: 'unsure', label: 'No idea — tell us what it costs' },
        ],
        why: "A band, not a number. It tells us what's realistic to propose so we don't waste your time designing something you were never going to buy. If you said more are coming above, answer for this first one.",
      },
      {
        key: 'approvers', type: 'textarea', rows: 3,
        label: 'Who needs to approve this?',
        placeholder: 'Names or job titles. Include anyone who could ask for changes late on.',
        why: "Video 7 — the feedback trap. This is quietly the most valuable question here. Most expensive re-edits happen because someone who wasn't in the room saw it at version 3. Knowing now means we get them in early instead.",
        videoRef: 7,
      },
    ],
  },

  {
    key: 'script',
    title: 'Script and visuals',
    optional: true,
    blurb: 'Most people skip this, and that is completely fine — writing the script is our job. It only helps if you already have specific wording in mind.',
    questions: [
      {
        key: 'scriptRows', type: 'scriptTable',
        label: 'Rough script',
        why: 'A rule of thumb if you do write one: about 140 words per minute is comfortable narration. Much past that and it starts to feel rushed.',
      },
    ],
  },

  {
    key: 'closing',
    title: 'One last thing',
    questions: [
      {
        key: 'worthIt', type: 'textarea', rows: 4,
        label: 'What would make you look back and say this was money well spent?',
        placeholder: "Anything. It doesn't have to be a number.",
        why: "This is the single most useful line a producer can have, and it's the one nobody normally asks for. It's what we'll check the finished video against.",
      },
    ],
  },
];

// Flat list, for progress counting and for rendering a submitted brief.
export const ALL_QUESTIONS = SCREENS.flatMap((s) =>
  s.questions.map((q) => ({ ...q, screenKey: s.key, screenTitle: s.title, screenOptional: !!s.optional })));

export const REQUIRED_KEYS = ALL_QUESTIONS.filter((q) => q.required).map((q) => q.key);

// Whitespace is not an answer. Without the trim, a stray space bar counts as a
// completed required question and lets a blank brief be sent.
const isEmpty = (v) =>
  v == null ||
  (typeof v === 'string' && !v.trim()) ||
  (Array.isArray(v) && (v.length === 0 || v.every((r) => !r || (typeof r === 'object'
    ? !String(r.script || '').trim() && !String(r.visual || '').trim()
    : !String(r).trim()))));

// Progress counts the questions that carry weight, not every box. Counting the
// optional script table would mean a finished brief showing 90%, which reads as
// unfinished and stops people sending it.
export function briefProgress(answers = {}) {
  const counted = ALL_QUESTIONS.filter((q) => !q.screenOptional);
  const done = counted.filter((q) => !isEmpty(answers[q.key])).length;
  return { done, total: counted.length, pct: counted.length ? Math.round((done / counted.length) * 100) : 0 };
}

export function missingRequired(answers = {}) {
  return ALL_QUESTIONS.filter((q) => q.required && isEmpty(answers[q.key]));
}

const labelFor = (q, value) => {
  if (q.options) {
    const find = (v) => (q.options.find((o) => o.value === v)?.label) || v;
    return Array.isArray(value) ? value.map(find).join(', ') : find(value);
  }
  return value;
};

// The human label for one answer, for anywhere OUTSIDE the rendered brief that
// needs to show a chip answer to a person.
//
// This exists because storing the raw slug bites twice: the CRM shows a budget
// of "5-10k", and parseBudgetLower() (api/_lib/quoteRequestActions.js) scrapes
// numbers out of it and takes the minimum — turning "5-10k" into a £5 deal.
// The label parses to the correct lower bound of every band.
export function answerLabel(key, answers = {}) {
  const q = ALL_QUESTIONS.find((x) => x.key === key);
  const v = answers?.[key];
  if (!q || isEmpty(v)) return null;
  return labelFor(q, v);
}

// Suggest a length from where they said it will be seen. Shortest wins: a video
// that has to work as an ad can't be the two-minute cut.
const LENGTH_ORDER = ['under-30', '30-60', '60-90', '90-120', '120-plus'];
export function suggestedLength(answers = {}) {
  const places = Array.isArray(answers.placements) ? answers.placements : [];
  const candidates = places.map((p) => LENGTH_BY_PLACEMENT[p]).filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => LENGTH_ORDER.indexOf(a) - LENGTH_ORDER.indexOf(b))[0];
}

// Renders a submitted brief as plain text for quote_requests.project_details,
// which is what the team reads in the CRM and in the alert email. Built from
// the STORED answers rather than anything the client posts, so the document the
// team sees is always the document the client actually filled in.
export function renderBriefText(answers = {}) {
  const out = [];
  for (const screen of SCREENS) {
    const rows = [];
    for (const q of screen.questions) {
      const v = answers[q.key];
      if (isEmpty(v)) continue;
      if (q.type === 'scriptTable') {
        const lines = (Array.isArray(v) ? v : [])
          .filter((r) => r && (String(r.script || '').trim() || String(r.visual || '').trim()))
          .map((r, i) => `  ${i + 1}. ${String(r.script || '').trim() || '—'}\n     [visual] ${String(r.visual || '').trim() || '—'}`);
        if (lines.length) rows.push(`${q.label}:\n${lines.join('\n')}`);
        continue;
      }
      rows.push(`${q.label}\n  ${labelFor(q, v)}`);
    }
    if (rows.length) out.push(`── ${screen.title.toUpperCase()} ──\n\n${rows.join('\n\n')}`);
  }
  return out.join('\n\n');
}
