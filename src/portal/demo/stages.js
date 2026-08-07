// The two stages of the sample project, described once.
//
// Deliberately free of React and of the review components: the dashboard needs
// this list to render the sample as a project card, and importing it from
// DemoProject.jsx would drag StoryboardRevision — and therefore the ~425kB
// pdf.js chunk — into the bundle every client loads on sign-in.
//
// `ready` is answered by the admin config, so a half-configured tour offers the
// half that works rather than a dead button.

export const DEMO_STAGES = [
  {
    key: 'storyboard',
    step: 1,
    icon: 'storyboard',
    label: 'Storyboard sign-off',
    blurb: 'Before a single frame is animated, you see every scene drawn out. Change it here and it costs nothing.',
    doing: [
      'Click any spot on a slide to pin a note exactly where you mean it',
      'Compare the first draft against the redraw',
      'Sign it off in one button when the direction is right',
    ],
    cta: 'Try the storyboard review',
    // How it reads in a task list, where it has one line to make its case.
    taskTitle: 'Review the storyboard',
    taskDetail: 'Pin notes to the exact spot on any slide, compare drafts, then sign it off.',
    taskCta: 'Open storyboard',
    doneDetail: 'You pinned notes to the slides and signed it off — exactly how a real one works.',
    ready: (c) => !!(c && c.storyboardPdfUrl),
  },
  {
    key: 'video',
    step: 2,
    icon: 'video',
    label: 'Video review',
    blurb: "The cut lands here, not in an email chain. Your whole team comments in one place and we work straight from it.",
    doing: [
      'Click the video to leave a comment at that exact second',
      'Reply to a colleague — everyone sees one thread',
      'Switch between versions, then approve the final cut',
    ],
    cta: 'Try the video review',
    taskTitle: 'Review the video',
    taskDetail: 'Comment at the exact second, reply to your colleagues, then approve the cut.',
    taskCta: 'Open review',
    doneDetail: 'You commented on the timeline and approved the cut — exactly how a real one works.',
    ready: (c) => !!(c && c.videoUrl),
  },
];

// Is there enough uploaded for the tour to be worth offering at all?
export const demoConfigured = (config) => DEMO_STAGES.some((s) => s.ready(config));
