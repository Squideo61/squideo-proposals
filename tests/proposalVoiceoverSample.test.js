import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlMock, setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';

vi.mock('../api/_lib/db.js', () => ({ default: sqlMock, batchWrite: async () => {} }));
vi.mock('@vercel/blob', () => ({ put: vi.fn(), del: vi.fn(), get: vi.fn() }));

const { resolveProposalSampleArtist, serialiseProposalSample } = await import('../api/_lib/voiceover.js');

// Which AI voice a client can play under the "Latest-generation AI voiceover
// artist" line on their proposal. It resolves on the UNAUTHENTICATED proposal
// read, so the rules that matter are: never play a voice the proposal didn't
// ask for, and never fail the read.

const AI_INCLUSION = { title: 'Latest-generation AI voiceover artist', description: 'Delivered at an optimum rate of 140wpm.' };

const artist = (id, name, extra = {}) => ({
  id, name, category: 'ai', description: null, blob_url: 'https://blob/' + id,
  mime_type: 'audio/mpeg', size_bytes: 1234, ...extra,
});

// Answer the resolver's two query shapes: the AI catalogue and the settings row.
function withCatalogue(rows, settings = null) {
  setSqlHandler((text) => {
    if (text.includes('FROM voiceover_artists')) {
      if (text.includes('WHERE id =')) return rows.filter((r) => !r.__missing);
      return rows;
    }
    if (text.includes('FROM settings')) return settings ? [{ proposal_voiceover: settings }] : [{}];
    return [];
  });
}

beforeEach(() => resetSqlMock());

describe('resolveProposalSampleArtist', () => {
  it('plays nothing when the proposal includes no AI voiceover', async () => {
    withCatalogue([artist('a1', 'Alexander')]);
    const sample = await resolveProposalSampleArtist({ baseInclusions: [{ title: 'Licensed music & sound effects' }] });
    expect(sample).toBeNull();
    expect(getSqlCalls()).toHaveLength(0);   // no DB work for a proposal without the line
  });

  it('plays nothing when the proposal switched the sample off', async () => {
    withCatalogue([artist('a1', 'Alexander')]);
    const sample = await resolveProposalSampleArtist({ baseInclusions: [AI_INCLUSION], voiceoverSample: { off: true } });
    expect(sample).toBeNull();
  });

  it('falls back to Alexander rather than whichever voice sorts first', async () => {
    withCatalogue([artist('a1', 'Dan'), artist('a2', 'Alexander'), artist('a3', 'Amelia')]);
    const sample = await resolveProposalSampleArtist({ baseInclusions: [AI_INCLUSION] });
    expect(sample.id).toBe('a2');
  });

  it('prefers the voice an admin picked over the name fallback', async () => {
    withCatalogue([artist('a1', 'Dan'), artist('a2', 'Alexander')], { artistId: 'a1' });
    const sample = await resolveProposalSampleArtist({ baseInclusions: [AI_INCLUSION] });
    expect(sample.id).toBe('a1');
  });

  it('ignores an admin pick that is no longer in the catalogue', async () => {
    withCatalogue([artist('a1', 'Dan'), artist('a2', 'Alexander')], { artistId: 'gone' });
    const sample = await resolveProposalSampleArtist({ baseInclusions: [AI_INCLUSION] });
    expect(sample.id).toBe('a2');
  });

  it("uses the proposal's own override", async () => {
    setSqlHandler((text) => (text.includes('WHERE id =') ? [artist('a9', 'Grace')] : []));
    const sample = await resolveProposalSampleArtist({ baseInclusions: [AI_INCLUSION], voiceoverSample: { artistId: 'a9' } });
    expect(sample.id).toBe('a9');
  });

  it('plays nothing when a hand-picked voice has been deleted — never a substitute', async () => {
    setSqlHandler(() => []);
    const sample = await resolveProposalSampleArtist({ baseInclusions: [AI_INCLUSION], voiceoverSample: { artistId: 'deleted' } });
    expect(sample).toBeNull();
  });

  it('resolves to no sample instead of throwing when the catalogue query fails', async () => {
    setSqlHandler(() => { throw new Error('relation "voiceover_artists" does not exist'); });
    await expect(resolveProposalSampleArtist({ baseInclusions: [AI_INCLUSION] })).resolves.toBeNull();
  });
});

describe('serialiseProposalSample', () => {
  it('carries only what the player needs — never the blob URL', () => {
    const out = serialiseProposalSample(artist('a1', 'Alexander', { description: 'British, warm' }));
    expect(out).toEqual({ artistId: 'a1', name: 'Alexander', description: 'British, warm', v: 1234 });
  });

  it('is null for no artist', () => {
    expect(serialiseProposalSample(null)).toBeNull();
  });
});
