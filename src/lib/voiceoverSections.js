// The three voiceover catalogue sections, shared by the admin catalogue tab and
// the client portal picker so labels + colours never drift. Each carries a
// subtle tinted background so the sections read as clearly separate:
//   ai      → green   (standard — an AI voice is included as standard)
//   human   → blue    (professional human artists — a paid upgrade from AI)
//   premium → orange  (premium human artists — a higher additional charge)
import { Sparkles, User, Crown } from 'lucide-react';

export const VOICEOVER_SECTIONS = [
  {
    key: 'ai',
    label: 'Latest-Generation AI Voiceovers',
    short: 'AI',
    hint: 'AI voices — usually named after the person (Dan, Amelia, …).',
    icon: Sparkles,
    accent: '#059669', tint: '#ECFDF5', border: '#A7F3D0',
  },
  {
    key: 'human',
    label: 'Professional Voiceover Artists',
    short: 'Human',
    hint: 'Human artists — usually named by style/accent (UK Female Corporate, …).',
    icon: User,
    accent: '#2563EB', tint: '#EFF6FF', border: '#BFDBFE',
  },
  {
    key: 'premium',
    label: 'Premium Voiceover Artists',
    short: 'Premium',
    hint: 'Top-tier human artists — carry an additional charge.',
    icon: Crown,
    accent: '#EA580C', tint: '#FFF7ED', border: '#FED7AA',
  },
];

export const VOICEOVER_SECTION_KEYS = VOICEOVER_SECTIONS.map((s) => s.key);
export const sectionFor = (key) => VOICEOVER_SECTIONS.find((s) => s.key === key) || VOICEOVER_SECTIONS[1];
