// What we call the free video course, in one place.
//
// It has been renamed once (from "The Explainer Video Planning Crash Course")
// and the old name was written out longhand in a dozen files, so the rename
// meant hunting strings across the portal, the public landing page and the
// admin. Next time it's this file.
//
// Two forms, because the audience changes at the point of signup:
//   `name`       — before they have it. Matches the button on squideo.com
//                  exactly, so the page they land on confirms they clicked the
//                  right thing.
//   `portalName` — after. "Free" is a sales word; to someone who already owns
//                  it, it reads as though we're still selling.
//
// The API can't import from src/, so the few strings it owns (the unlock email
// subject, the signup alert) are written out there. Grep for LEAD_MAGNET if
// this changes again.
export const LEAD_MAGNET = {
  name: 'Free 6-Min Video Guide',
  portalName: '6-Min Video Guide',
  // The rail is 224px; anything longer than this wraps to two lines.
  navLabel: '6-Min Video Guide',
  navShort: 'Guide',
  tagline: 'Brief to Broadcast — everything we know about planning a video that works.',
  // Used where the sentence needs a noun rather than a title
  // ("watch the guide", "straight from the guide").
  shortNoun: 'the guide',
};
