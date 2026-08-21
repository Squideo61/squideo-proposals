// The portal's navigation, as data.
//
// Its own module because it IS data — a list of sections and two rules about
// who sees them grouped how. Kept out of PortalApp.jsx so it can be reasoned
// about (and tested) without dragging in the whole portal: pdf.js, the pages,
// the provider. A filter over eleven objects should not need a DOM.
import {
  Home, Film, FolderOpen, Sparkles, Users, Settings as SettingsIcon,
  PlusCircle, Wallet, GraduationCap, FileText, Handshake,
} from 'lucide-react';
import { LEAD_MAGNET } from '../lib/leadMagnet.js';

// ── ORDER ────────────────────────────────────────────────────────────────────
// For the way people ARRIVE, not for how a long-standing client uses it. The
// brief builder leads because it IS the lead magnet — it is the button on
// squideo.com that sends most new accounts here, and a menu whose first item is
// not the thing you came through the door for reads as the wrong portal. The
// course led until the magnet changed; it is now second. Current projects sits
// below both: for a prospect that page is empty, and an empty first screen is a
// bad first impression.
//
// ── GROUPS ───────────────────────────────────────────────────────────────────
// `group: 'later'` marks a section that only means anything once there is a
// project in the account.
//
// For a CLIENT nothing changes: one list, this order, no headings. For a
// PROSPECT the rail splits in two and the later group sits under a heading
// saying when it starts working — see navGroups.
//
// NOTHING IS HIDDEN BY IT, which is the point. Someone who typed a name and an
// email to get a brief template was being handed ten equal rooms, six of them
// empty; that reads as an account they have not earned rather than as a portal
// waiting for them. But hiding the rooms would throw away the shop window —
// the sample project, and the prospect-specific empty states written into
// Library and Documents, are there on purpose. So the answer is to say WHEN,
// not to take it away. Every section stays clickable and every URL still works.
//
// ── PHONE ────────────────────────────────────────────────────────────────────
// `mobilePrimary` earns a section its own tab in the phone bar. The bar lays
// items out evenly with no scroll, so past about six they stop being tappable —
// everything else goes behind "More" rather than being dropped, because the
// portal is an installable PWA and every section has to be reachable at phone
// width. `prospectPrimary` is the same idea for someone with no project: three
// of the client primaries are in the later group, and a phone bar leading with
// empty rooms is the same mistake in less space.
//
// shortLabel is what that bar uses — "Current projects" doesn't fit under an
// icon, and the possessive labels ("Your Video Library") would wrap to three
// lines.
const NAV = [
  // "Online Brief Builder", not "Brief Builder": the rail has to read the same
  // as the button on squideo.com that sent them here — a name that changes at
  // the door makes people wonder whether they've landed on the right thing.
  // shortLabel stays "Brief": the tab bar fits one short word.
  { view: 'brief', label: 'Online Brief Builder', shortLabel: 'Brief', hash: '#/brief', Icon: FileText, mobilePrimary: true, prospectPrimary: true },
  // Named from LEAD_MAGNET so the rail, the landing page and the button on
  // squideo.com can't drift apart. "Free" is dropped in here: they've already
  // got it, and still selling it to someone who owns it reads badly.
  { view: 'course', label: LEAD_MAGNET.navLabel, shortLabel: LEAD_MAGNET.navShort, hash: '#/course', Icon: GraduationCap, mobilePrimary: true, prospectPrimary: true },
  // Shown to everyone, badged until they've opened it once. It was prospect-only
  // and buried in an empty state, which meant the best thing in the portal was
  // invisible to most of the people in it — including every client waiting on a
  // first draft, who is exactly the person wondering what reviewing one is like.
  // For a prospect it is the whole shop window, which is why it stays in the
  // first group and gets a phone tab of its own.
  { view: 'demo', label: 'Sample project', shortLabel: 'Sample', hash: '#/demo', Icon: Sparkles, needsSample: true, prospectPrimary: true },
  { view: 'home', label: 'Current projects', shortLabel: 'Projects', hash: '#/', Icon: Home, mobilePrimary: true, group: 'later' },
  { view: 'library', label: 'Your Video Library', shortLabel: 'Library', hash: '#/library', Icon: Film, mobilePrimary: true, group: 'later' },
  { view: 'video-credit', label: 'Video credit', hash: '#/video-credit', Icon: Wallet, group: 'later' },
  // Sits under Video credit because it's the same idea committed to monthly.
  // Unlike Video credit it shows no rate — the plan is scoped on a call — so
  // it needs no prospect gate, only the "later" grouping.
  { view: 'partner', label: 'Partner Programme', shortLabel: 'Partner', hash: '#/partner', Icon: Handshake, group: 'later' },
  { view: 'documents', label: 'Documents', hash: '#/documents', Icon: FolderOpen, group: 'later' },
  { view: 'request', label: 'New video', hash: '#/request', Icon: PlusCircle, highlight: true, mobilePrimary: true, group: 'later' },
  // Not 'later', even with nothing in the account: the brief is explicitly the
  // ORGANISATION's document, and getting the person who owns the budget into it
  // is a real thing to do on day one.
  { view: 'team', label: 'Your Team', shortLabel: 'Team', hash: '#/team', Icon: Users, prospectPrimary: true },
  { view: 'settings', label: 'Settings', hash: '#/settings', Icon: SettingsIcon },
];

// One filter, used by both the rail and the phone tab bar, so a section can't
// end up hidden in one and visible in the other.
//
// `video-credit` is the rate card, and it belongs to clients: credit is the rung
// AFTER a first project, when a style exists to repeat. A video-guide signup
// has a `prospect` org and shouldn't be shown £/min before we've scoped
// anything — that number would anchor every quote they get afterwards. The
// real enforcement is CLIENT_ONLY in api/portal.js; this is the door.
export function visibleNav(company, sampleAvailable = false) {
  // `creditVisible` is resolved server-side from the company's override plus
  // the default rule, so the nav can't disagree with the API guard. Undefined
  // (an older session payload) falls through to visible rather than hiding a
  // paying client's own balance.
  const hideCredit = company?.creditVisible === false;
  // The sample project appears for everyone, but only once there's something in
  // it — see the `sampleProject` flag on /api/portal/me.
  return NAV.filter((n) => !(hideCredit && n.view === 'video-credit'))
    .filter((n) => !(n.needsSample && !sampleAvailable));
}

// Is this org still a prospect — signed themselves up off a landing page and
// has no project yet? Mirrors isProspect in PortalContext, and defaults to
// FALSE the same way: an unknown flag must never show a paying client a rail
// telling them their project hasn't started.
export const isProspectCompany = (company) => company?.prospect === true;

/**
 * The rail, in one or two groups.
 *
 * A client gets exactly one group and no heading — the rail they have always
 * had. A prospect gets their own work first, then everything that needs a
 * project under a heading that says so.
 *
 * The heading is the entire mechanism. "When your project starts" turns six
 * empty rooms from "why do I have all this?" into "that's what's coming", at
 * the cost of one line of type and nothing taken away.
 */
export function navGroups(company, sampleAvailable = false) {
  const items = visibleNav(company, sampleAvailable);
  if (!isProspectCompany(company)) return [{ key: 'all', heading: null, items }];
  const now = items.filter((n) => n.group !== 'later');
  const later = items.filter((n) => n.group === 'later');
  return [
    { key: 'now', heading: null, items: now },
    // Dropped entirely rather than left as a bare heading if everything in it
    // happens to be hidden for this org.
    ...(later.length ? [{ key: 'later', heading: 'When your project starts', items: later, muted: true }] : []),
  ];
}
