// Content for the /reviews embed (the scrolling banner iframed into squideo.com).
//
// Deliberately a hand-edited list rather than a live Google Places call: no API
// key to leak, no quota, no per-render latency on a marketing page, and we keep
// control of which reviews run and how they're trimmed. Adding one is a two-line
// edit + redeploy.
//
// `source` drives the little provider badge on the card. Leave it null if you
// aren't certain where a review came from — an unbadged card is fine, a card
// wrongly badged "Google" is a misattribution.
//
//   name   — reviewer, as they wrote it
//   stars  — 1-5
//   text   — verbatim. Keep it short; long ones get visually clamped anyway,
//            so trim by hand to a natural sentence end rather than letting CSS
//            cut mid-word.
//   source — 'google' | 'trustpilot' | null
//   photo  — optional. A same-origin path like '/reviews/kate-hughes.jpg'
//            (drop the file in public/reviews/). Omit it and the card falls
//            back to coloured initials, which is a fine resting state — don't
//            add a photo just to have one.
//
//            Keep these same-origin. The CSP for this page is img-src 'self'
//            data:, deliberately: hotlinking lh3.googleusercontent.com would
//            mean widening it for URLs that rot the moment a reviewer changes
//            their picture. When the Business Profile sync lands it'll copy
//            reviewer.profilePhotoUrl through our own origin and fill this
//            same field.

export const SUMMARY = {
  rating: '5.0',
  count: 115,
  source: 'google',
  href: 'https://www.google.com/search?q=squideo+reviews'
};

export const REVIEWS = [
  {
    name: 'Monika Romanik',
    stars: 5,
    source: 'google',
    text: 'Working with Squideo is a breeze! They are very organised, attentive and super creative. From the initial storyboarding to the final tweaks on my animated videos, they were collaborative and happy to go the extra mile. 5 stars from me!'
  },
  {
    name: 'Daniel Puckrin',
    stars: 5,
    source: 'google',
    text: 'Top company to work with. They deliver on time and are more than happy to help with any additional issues that crop up. We’re delighted with the final video.'
  },
  {
    name: 'Jeff Doyle',
    stars: 5,
    source: null,
    text: 'I cannot recommend Squideo enough. The video they produced for my new venture is out of this world.'
  },
  {
    name: 'Kate Hughes',
    stars: 5,
    source: null,
    text: 'Really pleased with our first ever animated video produced by Squideo. So much so, we’re working with them on a second one!'
  },
  {
    name: 'Justin Clarke',
    stars: 5,
    source: null,
    text: 'The team at Squideo took the time to understand what we were looking for and really did turn our ideas into reality.'
  },
  {
    name: 'Jessica Stones',
    stars: 5,
    source: null,
    text: 'Squideo provided us with an extremely high quality, professional service, with a quick turnaround.'
  },
  {
    name: 'Gary Brett',
    stars: 5,
    source: null,
    text: 'Great service, this is our 2nd video project with Squideo and they are very friendly and patient.'
  },
  {
    name: 'Amy Soffe',
    stars: 5,
    source: null,
    text: 'The final product we received is better than what we had thought it would be and all for such an affordable price!'
  },
  {
    name: 'Let Alliance',
    stars: 5,
    source: null,
    text: 'Great experience with the Squideo team. Their creative input was much appreciated despite the amount of amendments.'
  },
  {
    name: 'Five Minute Box',
    stars: 5,
    source: null,
    text: 'They took time to understand our product and I’m really pleased with the result.'
  }
];
