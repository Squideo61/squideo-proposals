export const BRAND = {
  blue: '#2BB8E6',
  ink: '#0F2A3D',
  paper: '#FAFBFC',
  border: '#E5E9EE',
  // Darkened from #6B7785. That value was 4.45:1 on white — under the 4.5
  // threshold for the 12–13px text it is mostly used for, so it was already
  // failing before the portal took a tinted background, which pushed it to
  // 3.8:1. This clears 4.5:1 on white AND on portalBg below. The shift is about
  // three percent of lightness: legible on a laptop in daylight, invisible as a
  // restyle.
  muted: '#5C6B77',
  // The portal's page background — brand-100 from the design system on
  // squideo.com, the tint one step off white. White cards on a white page have
  // to be outlined to exist at all; on this they read as objects sitting on a
  // surface, which is the whole reason the brief builder now looks like a
  // document rather than a region of the page.
  //
  // NOT `paper`, which stays near-white: that is the backdrop behind the video
  // and storyboard review players, and a blue wash behind someone's footage
  // would shift how they judge their own colour grade.
  portalBg: '#DCEEF7',
};

// Caps how wide the CRM content (and the top bar's inner row) can grow, so it
// stays readable and centred instead of stretching edge-to-edge on wide /
// ultrawide monitors. The document-style proposal builder & client preview opt
// out and keep their own full-bleed layout.
export const APP_MAX_WIDTH = 1600;

export const CONFIG = {
  company: { name: 'Squideo', website: 'squideo.com', phone: '01482 738 656', termsUrl: '' },
  defaultTeam: [
    { name: 'Callum', role: 'Production Manager', bio: "Callum has been with Squideo since the very beginning and remains one of the company's greatest assets. With extensive experience managing a wide range of projects across sectors, he ensures every production runs smoothly from start to finish. As your dedicated point of contact, Callum oversees each stage of the process to deliver the best possible outcome.", photo: null },
    { name: 'Chloe', role: 'Copywriter', bio: 'Chloe is our experienced copywriter, responsible for crafting and assisting with the narrative that brings every video to life. Chloe knows how to capture attention, communicate complex ideas clearly, and drive real results. Her creative flair and strategic approach ensure every video resonates with its audience and delivers measurable impact.', photo: null },
    { name: 'Hannah', role: 'Creative Director', bio: 'Hannah has been part of the Squideo visuals team for over five years and plays a key role in initial concept and design. With an exceptional eye for detail and a talent for producing outstanding storyboards, Hannah oversees the creative side of production, ensuring every project meets our visual and storytelling benchmarks.', photo: null },
    { name: 'Ben', role: 'Founder', bio: 'Ben is the Founder and Director of Squideo, leading the company since its inception over a decade ago. With a wealth of experience overseeing thousands of successful projects, Ben provides high-level direction and ensures every production aligns with Squideo\'s creative vision and commitment to excellence. He will be overseeing your project from a strategic perspective to ensure it delivers maximum impact.', photo: null }
  ],
  limits: { maxImageBytes: 5 * 1024 * 1024 },
  storageKey: 'squideo.store.v1'
};

export const DEFAULT_PHOTOS = {
  Callum: '/team-photos/callum.jpg',
  Chloe:  '/team-photos/chloe.jpg',
  Hannah: '/team-photos/hannah.jpg',
  Ben:    '/team-photos/ben.jpg',
  'Adam Shelton': '/team-photos/adam.jpg'
};
