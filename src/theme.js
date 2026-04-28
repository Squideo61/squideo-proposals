export const BRAND = {
  blue: '#2BB8E6',
  ink: '#0F2A3D',
  paper: '#FAFBFC',
  border: '#E5E9EE',
  muted: '#6B7785'
};

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
