// The sample project.
//
// Shaped byte-for-byte like the real `pollPublicRevision` response (see the
// allowlist at the bottom of api/revisions/[action].js) so the REAL review
// surface renders it with no special cases. The client is genuinely using the
// same component their own video will be reviewed in — that's the whole point,
// and it's why this is a fixture rather than a mock-up screenshot.
//
// WHY A FIXTURE AND NOT REAL ROWS:
// A shared demo project living in the database would take writes through the
// public, token-authorised /api/revisions/* endpoints — which sit outside the
// portal router and are reachable un-authed. Making that safe means correctly
// guarding seven write actions across two files, and getting one wrong turns
// the sample project into a graffiti wall every prospect can see. It would also
// put a fake company in Finance, the pipeline and the staff activity feed.
// Nothing here touches the database at all.
//
// The video and the storyboard PDF are both configured in Admin → Crash course,
// so Ben's explainer can be re-recorded and the sample storyboard swapped
// without a deploy.

export const DEMO_TOKEN = 'demo-sample-project';
export const DEMO_SB_TOKEN = 'demo-sample-storyboard';

const now = Date.now();
const ago = (mins) => new Date(now - mins * 60000).toISOString();

// Pre-seeded comments. Deliberately written as a real client's notes rather
// than "Comment 1" — the point is to show what a review thread FEELS like, and
// the second one being a reply is what demonstrates threading.
const SEED_COMMENTS = [
  {
    id: 'demo-c1', versionId: 'demo-v2', parentId: null,
    timecodeSeconds: 8.4, anchorX: 0.62, anchorY: 0.31,
    body: 'Love this opening. Could the logo hold for another second before it clears?',
    authorName: 'Priya Shah', authorEmail: null, createdAt: ago(240),
    attachmentUrl: null, attachmentName: null, attachmentType: null, mine: false,
  },
  {
    id: 'demo-c2', versionId: 'demo-v2', parentId: 'demo-c1',
    timecodeSeconds: null, anchorX: null, anchorY: null,
    body: "Done — that's in the next version. Good spot.",
    authorName: 'Ben Underwood', authorEmail: null, createdAt: ago(228),
    attachmentUrl: null, attachmentName: null, attachmentType: null, mine: false,
  },
  {
    id: 'demo-c3', versionId: 'demo-v2', parentId: null,
    timecodeSeconds: 21.0, anchorX: null, anchorY: null,
    body: 'Can we swap "solutions" for "software" here? Legal prefer it.',
    authorName: 'Priya Shah', authorEmail: null, createdAt: ago(190),
    attachmentUrl: null, attachmentName: null, attachmentType: null, mine: false,
  },
];

// `config` comes from settings.demo_project via the portal API, so the video
// can be swapped without a deploy. The fixture still renders if it's missing —
// an unconfigured demo shows the review furniture with an empty player rather
// than a crash, which is a much easier thing to notice and fix.
export function buildDemoData(config = {}) {
  const videoUrl = config.videoUrl || null;
  return {
    title: config.title || 'Sample project — how this works',
    clientName: 'Your company',
    callUrl: null,
    videos: [
      {
        id: 'demo-video-1',
        title: config.videoTitle || 'Welcome to your portal',
        approvedAt: null,
        approvedBy: null,
        feedbackSubmittedAt: null,
        versions: [
          // Two versions on purpose: one version hides the version switcher,
          // and the switcher is half of what makes a review feel like a review.
          {
            id: 'demo-v2', videoId: 'demo-video-1', versionNumber: 2,
            label: 'With the opening retimed',
            mimeType: 'video/mp4', videoUrl, createdAt: ago(300),
          },
          {
            id: 'demo-v1', videoId: 'demo-video-1', versionNumber: 1,
            label: 'First cut', mimeType: 'video/mp4', videoUrl, createdAt: ago(2880),
          },
        ],
      },
    ],
    comments: SEED_COMMENTS.map((c) => ({ ...c })),
    activeViewers: [],
  };
}

export const DEMO_SEED_COMMENT_IDS = SEED_COMMENTS.map((c) => c.id);

// ── The sample storyboard ───────────────────────────────────────────────────
// Same idea, same reasons, shaped like /api/storyboards/public instead.
//
// Storyboard comments are per-slide and render flat (no threading in that
// surface), so the "reply" here is simply Ben's note landing after Priya's on
// the same slide — which is exactly how a real thread reads there.
const SB_SEED_COMMENTS = [
  {
    id: 'demo-s1', versionId: 'demo-sb-v2', parentId: null,
    pageNumber: 1, anchorX: 0.36, anchorY: 0.44,
    body: 'This is the frame that sells it. Could the product sit a touch higher so the strapline has room to breathe?',
    authorName: 'Priya Shah', authorEmail: null, createdAt: ago(260),
    attachmentUrl: null, attachmentName: null, attachmentType: null, mine: false,
  },
  {
    id: 'demo-s2', versionId: 'demo-sb-v2', parentId: null,
    pageNumber: 1, anchorX: null, anchorY: null,
    body: "Noted — we'll lift it and re-balance the text in the next draft.",
    authorName: 'Ben Underwood', authorEmail: null, createdAt: ago(244),
    attachmentUrl: null, attachmentName: null, attachmentType: null, mine: false,
  },
  {
    id: 'demo-s3', versionId: 'demo-sb-v2', parentId: null,
    pageNumber: 2, anchorX: 0.6, anchorY: 0.52,
    body: 'Can we show the dashboard here rather than the logo? It makes the benefit obvious.',
    authorName: 'Priya Shah', authorEmail: null, createdAt: ago(200),
    attachmentUrl: null, attachmentName: null, attachmentType: null, mine: false,
  },
];

// `pageCount: null` on purpose — StoryboardRevision reads the real slide count
// out of the PDF when it isn't stored, so swapping the file in Admin can never
// leave the rail claiming a slide that doesn't exist.
export function buildDemoStoryboardData(config = {}) {
  const pdfUrl = config.storyboardPdfUrl || null;
  // An optional earlier draft. When there's only one file both versions point
  // at it: the switcher still demonstrates the idea, and the alternative —
  // hiding the switcher entirely — loses half of what makes a review a review.
  const earlierPdfUrl = config.storyboardPdfUrlV1 || pdfUrl;
  return {
    title: config.title || 'Sample project — how this works',
    clientName: 'Your company',
    callUrl: null,
    storyboards: [
      {
        id: 'demo-sb-1',
        title: config.storyboardTitle || 'Explainer — storyboard',
        approvedAt: null,
        approvedBy: null,
        feedbackSubmittedAt: null,
        versions: [
          {
            id: 'demo-sb-v2', storyboardId: 'demo-sb-1', versionNumber: 2,
            label: 'With your first notes applied', mimeType: 'application/pdf',
            pageCount: null, pdfUrl, createdAt: ago(300),
          },
          {
            id: 'demo-sb-v1', storyboardId: 'demo-sb-1', versionNumber: 1,
            label: 'First draft', mimeType: 'application/pdf',
            pageCount: null, pdfUrl: earlierPdfUrl, createdAt: ago(2880),
          },
        ],
      },
    ],
    comments: SB_SEED_COMMENTS.map((c) => ({ ...c })),
    activeViewers: [],
  };
}

export const DEMO_SB_SEED_COMMENT_IDS = SB_SEED_COMMENTS.map((c) => c.id);

// ── The sample project's schedule ───────────────────────────────────────────
// Shaped like the output of clientSchedule() on the server, so the portal's
// real ProjectSchedule renders it with no special cases — same as everything
// else here.
//
// Dates are generated relative to today rather than written down, for one
// reason: a demo timeline with hard-coded dates is out of date within a month
// and then quietly argues the opposite of what it's there to prove. The offsets
// are chosen to straddle today, so a visitor sees ticked-off history, a "next
// up" marker, and dates still to come — which is what a timeline looks like on
// a project that's actually running.
const scheduleDay = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  // Weekends would read as sloppy planning on a page arguing we're organised.
  if (d.getDay() === 6) d.setDate(d.getDate() + 2);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const DEMO_MILESTONES = [
  ['kick_off', 'Kick off', 'Project starts', 'both', -21],
  ['script:deliveredBy', 'Script & Text Direction', 'With you', 'us', -16],
  ['script:feedbackBy', 'Script & Text Direction', 'Your feedback due', 'you', -13],
  ['storyboard:deliveredBy', 'Storyboard', 'With you', 'us', -6],
  ['storyboard:feedbackBy', 'Storyboard', 'Your feedback due', 'you', 2],
  ['storyboard:revisedBy', 'Storyboard', 'Revised version with you', 'us', 7],
  ['video:deliveredBy', 'Video', 'With you', 'us', 17],
  ['video:feedbackBy', 'Video', 'Your feedback due', 'you', 20],
  ['video:revisedBy', 'Video', 'Revised version with you', 'us', 25],
];

export function buildDemoSchedule() {
  return {
    kickOff: scheduleDay(-21),
    milestones: DEMO_MILESTONES.map(([key, label, event, who, offset]) => ({
      key, label, event, who, date: scheduleDay(offset),
    })),
  };
}
