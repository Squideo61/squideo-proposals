// Newcastle University holds a separate credit balance per NHS study. On the
// "Rivivial x2 Sandip" deal, a producer opening the credit card should already
// be looking at the Rivival study's remaining minutes — not a total that adds
// Establish's unspent credit to it, which is what made the card unreadable.
//
// This is only the DROPDOWN'S STARTING VALUE — a wrong guess costs a click, and
// no guess at all falls back to the combined view. So what's pinned here is
// mostly the restraint: match on a distinctive word the two names share, and
// stay out of the way otherwise.
import { describe, it, expect } from 'vitest';
import { guessPool } from '../src/components/crm/ClientCreditCard.jsx';

const NEWCASTLE = [
  { clientKey: 'establish', name: 'NHS Establish Study' },
  { clientKey: 'rivival', name: 'NHS Rivival Study' },
];

describe('guessPool', () => {
  it('picks the study the project is named after', () => {
    expect(guessPool(NEWCASTLE, 'Rivivial x2 Sandip')).toBe('rivival');
    expect(guessPool(NEWCASTLE, 'NHS Establish Study — 3 videos')).toBe('establish');
  });

  it('survives the spelling drifting between the two systems', () => {
    // The deal really is spelled "Rivivial" and the credit client "Rivival".
    expect(guessPool(NEWCASTLE, 'Rivivial explainer')).toBe('rivival');
  });

  it('is not fooled by the filler both study names carry', () => {
    // "NHS" and "Study" appear in both, so a project mentioning only those must
    // not pick one arbitrarily — that would be a confident wrong answer.
    expect(guessPool(NEWCASTLE, 'NHS study videos')).toBe(null);
  });

  it('gives up rather than guessing when nothing matches', () => {
    expect(guessPool(NEWCASTLE, 'Onboarding animation')).toBe(null);
    expect(guessPool(NEWCASTLE, '')).toBe(null);
    expect(guessPool(NEWCASTLE, null)).toBe(null);
    expect(guessPool([], 'Rivivial x2 Sandip')).toBe(null);
  });
});
