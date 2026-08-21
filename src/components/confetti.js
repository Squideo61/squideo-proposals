// Confetti, in two sizes.
//
// One module because the quote form and the brief builder are the same product
// to the person filling both in — one as a prospect, the other as a client —
// and two copies of a celebration drift into two different celebrations.
//
// TWO SIZES, AND THE DIFFERENCE MATTERS. `fireConfetti` is three cannons and
// 220 pieces: that is for finishing, and it should feel like finishing.
// `burstFrom` is twenty small pieces out of the button you just pressed, for
// moving on a step. A brief has twenty of those. If every one of them threw the
// full celebration, the full celebration would be worth nothing by question
// four, and the form would be exhausting to fill in.
//
// LOADED ON DEMAND. canvas-confetti is ~7KB gzipped and nobody needs it until
// they press something, so it arrives with the first burst rather than in the
// initial bundle. The first click may land a frame or two late; every one after
// it is instant, and no burst is worth delaying a page load for.
//
// The palette is the brand's. It used to be the old green plus gold, orange and
// two colours from nowhere, which was left behind when the forms were restyled
// — confetti in a palette the product no longer uses reads as someone else's
// widget firing on your page.

let loading = null;
function confettiLib() {
  if (!loading) loading = import('canvas-confetti').then((m) => m.default).catch(() => null);
  return loading;
}

/**
 * Fetch the library without firing anything.
 *
 * For the two marketing forms, where success fires the confetti and then
 * redirects 1.2 seconds later: if the chunk were still in flight the visitor
 * would be sent to the thank-you page having seen nothing. Called on mount, so
 * it lands during idle time after first paint rather than on the critical path.
 * The brief builder does not need it — twenty Next clicks come first.
 */
export function warmConfetti() { confettiLib(); }

// Brand blue, the blue it deepens to, the green that now means "done", a mint
// to lift it off white, one gold so it reads as celebration rather than as UI,
// and the ink so there is something dark in the mix — an all-pastel burst on a
// white card half-disappears.
const COLORS = ['#2BB8E6', '#1FA4D1', '#16A34A', '#7ED9A6', '#F5C451', '#0F2A3D'];

/** The big one: finishing a form. Three cannons, low and wide. */
export function fireConfetti() {
  confettiLib().then((confetti) => {
    if (!confetti) return;
    const defaults = {
      zIndex: 2147483647,
      disableForReducedMotion: false,
      colors: COLORS,
      startVelocity: 45,
      gravity: 0.9,
      ticks: 200,
    };
    confetti({ ...defaults, particleCount: 60, spread: 60, angle: 60, origin: { x: 0, y: 0.7 } });
    confetti({ ...defaults, particleCount: 60, spread: 60, angle: 120, origin: { x: 1, y: 0.7 } });
    confetti({ ...defaults, particleCount: 100, spread: 90, origin: { x: 0.5, y: 0.6 } });
  });
}

/**
 * The little one: moving on a step.
 *
 * Thrown from the element you pressed rather than from the edges of the screen,
 * so it reads as a response to the button instead of as an event happening to
 * the page. Twenty small pieces, gone in under a second.
 *
 * Honours prefers-reduced-motion, unlike the success burst. Somebody who has
 * asked for less motion can live with one celebration at the end; twenty of
 * them on the way there is precisely what they turned it off to avoid.
 */
export function burstFrom(el) {
  confettiLib().then((confetti) => {
    if (!confetti) return;
    // Centre of the button, in viewport fractions. A detached or hidden element
    // measures 0×0 at the top-left, which would fire the burst into the corner
    // — fall back to the middle of the page instead.
    let origin = { x: 0.5, y: 0.62 };
    const r = el?.getBoundingClientRect?.();
    if (r && (r.width || r.height)) {
      origin = {
        x: (r.left + r.width / 2) / window.innerWidth,
        y: (r.top + r.height / 2) / window.innerHeight,
      };
    }
    confetti({
      zIndex: 2147483647,
      disableForReducedMotion: true,
      colors: COLORS,
      origin,
      particleCount: 20,
      spread: 62,
      startVelocity: 26,
      // Small, and heavy enough to fall out of frame quickly. Confetti still
      // drifting down while someone reads the next question is confetti in the
      // way of the next question.
      scalar: 0.72,
      gravity: 1.15,
      decay: 0.9,
      ticks: 90,
    });
  });
}
