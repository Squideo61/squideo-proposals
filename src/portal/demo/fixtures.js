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
// The video itself is configured in Admin → Crash course, so Ben's explainer
// can be re-recorded without a deploy.

export const DEMO_TOKEN = 'demo-sample-project';

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
