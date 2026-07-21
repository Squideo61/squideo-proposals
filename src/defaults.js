import { CONFIG } from './theme.js';
export { SQUIDEO_LOGO } from './_logo_tmp.js';

export const VARIANT_ELIGIBLE_IDS = new Set(['translatedsubs', 'fulltranslate']);
export function extraHasVariants(extra) {
  if (!extra) return false;
  if (!VARIANT_ELIGIBLE_IDS.has(extra.id)) return false;
  if (typeof extra.variantsEnabled === 'boolean') return extra.variantsEnabled;
  return true;
}

// Blueprint for the "Content Credit" proposal template — a one-off bulk credit
// purchase aimed at larger organisations with a fixed budget to allocate (e.g.
// an NHS body with a £10k budget who enquired about a single 3-min video, but
// could pre-buy several minutes of content credit at a bulk discount for future
// use). Takes the current default proposal as its base so it inherits the
// workspace's own intro/team/inclusions, then swaps the recurring Partner
// Programme for the one-off credit variant and leads with the Purchase Order
// payment route (the usual path for these organisations).
export const CONTENT_CREDIT_TEMPLATE_NAME = 'Content Credit (one-off)';
export function makeContentCreditTemplate(base) {
  const tpl = JSON.parse(JSON.stringify(base || DEFAULT_PROPOSAL));
  delete tpl.clientName;
  delete tpl.contactBusinessName;
  delete tpl.clientLogo;
  delete tpl.projectVision;
  delete tpl._number;
  delete tpl._views;
  delete tpl._createdAt;
  tpl.name = CONTENT_CREDIT_TEMPLATE_NAME;
  tpl.proposalTitle = tpl.proposalTitle || 'Content Credit Proposal';
  const ratePerMin = tpl.partnerProgramme?.standardRatePerMin || 1250;
  // Credit-only: the main section quotes an amount of minutes, and the tier
  // discount rewards only the extra minutes added on the proposal.
  tpl.requirement = 'Animated video content';
  tpl.requirementSummary = '';
  tpl.basePrice = ratePerMin;
  tpl.partnerProgramme = {
    ...(tpl.partnerProgramme || {}),
    enabled: true,
    mode: 'oneoff',
    creditOnly: true,
    quotedMinutes: 1,
    standardRatePerMin: ratePerMin,
    // A steeper ladder than the subscription default — the whole point is to
    // reward a bigger single commitment, so the discount keeps climbing further.
    discountRate: 0.15,
    extraDiscountPerCredit: 0.03,
    maxDiscount: 0.30,
    description: 'Content Credit lets you lock in a block of production time now and draw it down whenever you\'re ready.\n- Add extra minutes on top of your quote at a bulk-discounted rate\n- Use it on this content, split it across smaller pieces, or save it for later\n- You have 2 years to use your credit – no monthly commitment, no rush to spend\n\nWhy organisations use it:\n- Maximise a fixed budget – the more minutes you add, the lower the rate on them\n- One approval, one Purchase Order – simpler procurement than commissioning piece by piece\n- Consistency – the same team and style across everything you make',
  };
  // Purchase Order first: these are typically larger organisations who raise a
  // PO rather than pay by card. All three routes stay available.
  tpl.paymentOptions = ['po', 'full', '5050'];
  return tpl;
}

export const NEXT_STEPS = [
  'Accept this quote to guarantee a production slot in our creative schedule.',
  "We'll invoice your initial payment or arrange supplier setup with you for Purchase Orders.",
  'Your Production Manager will reach out to arrange an introduction meeting with our Delivery Team.',
];

export const DEFAULT_PROPOSAL = {
  clientName: '',
  contactBusinessName: '',
  clientLogo: null,
  proposalTitle: '',
  date: new Date().toLocaleDateString('en-GB'),
  preparedBy: 'Adam Shelton',
  preparedByTitle: 'Partnership Lead',
  showIntro: true,
  introHeading: '',
  intro: "Squideo is a UK-based animation studio with over a decade of experience delivering engaging, results-driven video content. Having produced more than 5,000 videos, we've earned a reputation for combining creativity with clarity, helping leading organisations communicate complex ideas with precision and impact.\n\nOur clients include the NHS, UK government departments, and global brands.\n\nThis proposal outlines how we'll apply that expertise to bring your message to life with strategic storytelling, design, and seamless production.",
  showDeliveryTeam: true,
  team: CONFIG.defaultTeam.map(m => ({ ...m })),
  requirement: '1 x HD Animated explainer video - up to 60 seconds in length',
  // Free-text brief shown as "Your Requirement" just above Your Quote on the
  // proposal (works in both single and option mode). Empty by default.
  requirementSummary: '',
  projectVision: '',
  basePrice: 1250,
  videoOptions: [],
  baseInclusions: [
    { title: 'Complete creative support', description: '' },
    { title: 'Team creative meeting', description: '' },
    { title: 'Project kick-off meeting', description: 'With our project manager, creative director and copywriter (if assistance is needed with script development).' },
    { title: 'Tailored production timeline', description: 'Based on 5–6 weeks turnaround. Estimate is from project kick-off call and assumes we have all the information required to start. Your feedback is required to move forward through each stage of production.' },
    { title: 'Unlimited revisions at every stage of production', description: 'As many revisions as necessary until you are happy to proceed.' },
    { title: 'Complete script development or copywriter assistance', description: 'As much help as you need with your script.' },
    { title: 'Utilisation of up to 140 words of your provided script narrative', description: '' },
    { title: 'Latest-generation AI voiceover artist', description: 'Delivered at an optimum rate of 140wpm.' },
    { title: 'Licensed music & sound effects', description: '' },
    { title: 'Visual direction assistance (if required)', description: 'Many partner artists to choose from, in a variety of styles to match your messaging.' },
    { title: 'Visual style development', description: 'Development of a unique visual style to work seamlessly with your brand and tone.' },
    { title: 'Storyboard visual slide deck', description: 'Scene-by-scene overview stills in line with your approved visual direction.' },
    { title: 'Access to our easy-to-use, shareable review platform', description: 'Leave unlimited comments and suggestions in line with your approved storyboard.' },
    { title: 'Team follow-up video revisions meeting', description: 'A comprehensive review of your revisions, ensuring we understand exactly what needs changing.' },
    { title: 'Bespoke animated version of your logo', description: 'Included within the video.' },
    { title: 'Ownership rights of final video version', description: '' },
    { title: 'Futureproofing - 24 months editable file storage', description: 'During this time ongoing updates can be made at any time.' }
  ],
  partnerProgramme: {
    enabled: true,
    // 'subscription' — recurring monthly content credit, first month charged on
    // sign, cancel any time (the original programme). 'oneoff' — a single upfront
    // purchase of content credit for future use, priced on the same tier ladder
    // (more minutes = bigger discount) but paid once. See makeContentCreditTemplate.
    mode: 'subscription',
    // Credit-only proposals quote the main deliverable as an amount of minutes
    // rather than free text, and the tier discount applies ONLY to the extra
    // minutes the client adds on the proposal — the quoted minutes stay at the
    // standard rate. Kept as a sub-flag of mode:'oneoff' (rather than a third
    // mode) so all the existing one-off plumbing — PO payment route, Xero credit
    // lines, Stripe metadata, credits dashboard — keeps working untouched.
    creditOnly: false,
    // Minutes quoted in single-option mode. Per-option minutes live on each
    // videoOptions entry, mirroring how price/basePrice already work.
    quotedMinutes: 1,
    standardRatePerMin: 1250,
    discountRate: 0.15,
    extraDiscountPerCredit: 0.025,
    maxDiscount: 0.20,
    description: 'Content credit is a pre-agreed way to allocate budget to ongoing video production.\n- Spend all credits on a single piece\n- Split credits across several smaller pieces\n- Roll credits forward for a larger video later\n\nWhy it\'s better:\n- More cost-effective – less procurement/admin each time\n- Faster delivery – streamlined production process utilising reserved capacity\n- Consistency – the same style can be reused and extended'
  },
  optionalExtras: [
    { id: 'voiceover', label: 'Professional human voiceover artist', price: 125, description: 'Partner artists in a variety of styles to match your messaging.' },
    { id: 'shortedit', label: 'Short edit - cut from main content', price: 300, description: 'Ideal where attention spans are lowest. Cost is per edit.' },
    { id: 'subtitles', label: 'Hard-coded English subtitled version', price: 125, description: 'Subtitles burned into the video for guaranteed accuracy.' },
    { id: 'translatedsubs', label: 'Professionally translated subtitles', price: 200, description: 'Available in over 100 languages. Cost is per language.', variantsEnabled: true },
    { id: 'fulltranslate', label: 'Fully translated version', price: 550, description: 'Translation, native voiceover, all on-screen text synced.', variantsEnabled: true },
    { id: 'bsl', label: 'BSL (British Sign Language) version', price: 550, description: 'Includes professional sign artist overlay.' },
    { id: 'portrait', label: 'Mobile-friendly 9:16 portrait version', price: 400, description: 'For Instagram reels, TikTok, Snapchat.' },
    { id: 'thumbnail', label: 'Video thumbnail imagery', price: 40, description: 'Static thumbnail to maximise click-through.' },
    { id: 'assetpack', label: 'Bespoke asset pack', price: 500, description: 'Vector assets for unrestricted use. Adds 7 days to turnaround.' },
    { id: 'valuepack', label: 'Extras value pack - save 30%', price: 675.50, description: 'Portrait, short, subtitled and thumbnail bundled at 30% discount.' },
    { id: 'additional', label: 'Additional video at 25% discount', price: 937.50, description: 'Additional video at 25% off. Must be paid upfront.' },
    { id: 'priority', label: 'Priority delivery - 4 week turnaround', price: 595, description: 'Prioritises your project in our schedule.' }
  ],
  processVideoUrl: 'https://vimeo.com/625502459',
  showProcessVideo: true,
  // Notable examples — up to 3 Vimeo links shown on the proposal between the
  // production-process video and pricing. Off by default. Each entry:
  // { id, url, title }. Title auto-fills from Vimeo but is editable.
  showNotableExamples: false,
  notableExamples: [],
  vatRate: 0.20,
  // Simple manual discount on the project base price (extras stay full price).
  // Applies only on the standard flow — ignored when the client opts into the
  // Partner Programme. value <= 0 means no discount. type: 'percent' | 'amount'.
  discount: { type: 'percent', value: 0, label: '' },
  validityDays: 28,
  paymentOptions: ['5050', 'full'],
  paymentOptionDescs: {}
};
