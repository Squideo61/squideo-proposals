// Who a deal's portal invite is addressed to, and who is merely copied in.
//
// The rule is that the invite goes to the deal's PRIMARY contact. It used to
// pre-tick everyone who lacked access, which on a multi-contact deal made the
// main contact just another name on a list — and because the candidate query
// wasn't ordered, they could be left off entirely while a secondary contact got
// the invite instead.
//
// Pure and separate from the modal so the rule can be tested, and so the next
// person changing it can see it stated once rather than inferred from JSX.
export function pickInviteDefaults(candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  // Someone who already has access needs no invite, so they can't be the
  // addressee — but they're still worth copying in.
  const open = list.filter((c) => c && c.email && !c.hasAccess);
  const to = open.find((c) => c.primary) || open[0] || null;
  const cc = list
    .filter((c) => c && c.email && c.email !== to?.email)
    .map((c) => c.email);
  return { to, cc };
}
