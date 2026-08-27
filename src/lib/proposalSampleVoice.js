// Which AI artist's clip plays on a client proposal, under the "Latest-generation
// AI voiceover artist" inclusion. Mirror of resolveProposalSampleArtist in
// api/_lib/voiceover.js — the server always decides for real; this exists so the
// admin tab can badge the right row and the builder can name the default in its
// picker. Keep the two in step.
//
// Order: the proposal's own override (handled by the caller) → the voice an
// admin ticked in Admin → Voiceovers → the artist named Alexander → the first
// AI artist with a clip.
const HOUSE_SAMPLE_NAME_RE = /^alexander\b/i;

export function aiSampleArtists(artists) {
  return (artists || []).filter((a) => (a.category || 'human') === 'ai' && a.hasSample);
}

export function proposalSampleArtistId(artists, proposalVoiceover) {
  const ai = aiSampleArtists(artists);
  if (!ai.length) return null;
  const pick = proposalVoiceover?.artistId;
  if (pick && ai.some((a) => a.id === pick)) return pick;
  return (ai.find((a) => HOUSE_SAMPLE_NAME_RE.test((a.name || '').trim())) || ai[0]).id;
}
