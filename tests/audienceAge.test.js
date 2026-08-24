import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
  batchWrite: async () => {},
}));

import { audienceByAge } from '../api/_lib/crm/campaigns.js';

const at = (year, n) => Array.from({ length: n }, (_, i) => ({
  email: `${year}-${i}@x.com`, lastEnquiryAt: `${year}-06-01T00:00:00.000Z`,
}));

// A list carrying addresses back to 2018 is where dead addresses concentrate,
// and a dead address is not a wasted email — it's a bounce, which is what a
// sending domain gets scored on.
const LIST = [
  ...at(2018, 400), ...at(2019, 300), ...at(2020, 200), ...at(2025, 150),
  { email: 'unknown@x.com', lastEnquiryAt: null },
];

describe('how old the list is', () => {
  const shape = audienceByAge(LIST);

  it('counts people by the year we last heard from them', () => {
    expect(shape.years).toEqual([
      { year: 2018, count: 400, upToAndIncluding: 400 },
      { year: 2019, count: 300, upToAndIncluding: 700 },
      { year: 2020, count: 200, upToAndIncluding: 900 },
      { year: 2025, count: 150, upToAndIncluding: 1050 },
    ]);
  });

  it('gives the running total each cutoff would remove', () => {
    // "Everyone before 2021" is the question people actually ask.
    const y2020 = shape.years.find((y) => y.year === 2020);
    expect(y2020.upToAndIncluding - y2020.count).toBe(700);
  });

  it('treats an unknown date as unknown, not as old', () => {
    // Somebody with no enquiry on record isn't stale — guessing would exclude
    // exactly the wrong people.
    expect(shape.unknown).toBe(1);
    expect(shape.dated).toBe(1050);
  });

  it('ignores people already left out, so the counts match the buttons', () => {
    const withSkips = audienceByAge(LIST, new Set(['2018-0@x.com', '2018-1@x.com']));
    expect(withSkips.years.find((y) => y.year === 2018).count).toBe(398);
  });

  it('copes with a list nobody has a date for', () => {
    const none = audienceByAge([{ email: 'a@x.com', lastEnquiryAt: null }]);
    expect(none.years).toEqual([]);
    expect(none.unknown).toBe(1);
  });

  it('copes with an unparseable date rather than inventing a year', () => {
    const bad = audienceByAge([{ email: 'a@x.com', lastEnquiryAt: 'not a date' }]);
    expect(bad.years).toEqual([]);
    expect(bad.unknown).toBe(1);
  });
});
