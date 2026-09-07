import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
  batchWrite: async () => {},
}));

import { FOLDER_TEMPLATE_TOP_LEVEL, folderTemplateIsSafeToApply } from '../api/_lib/googleDrive.js';

// Marking a deal "Good to go" now lays the standard production folder structure
// down in Drive automatically, so nobody has to press "Set up folders". The one
// thing it must never do is scaffold over a folder tree somebody built by hand.

describe('folderTemplateIsSafeToApply', () => {
  it('scaffolds an empty deal folder', () => {
    expect(folderTemplateIsSafeToApply([])).toBe(true);
  });

  it('tops up a partially-created template (a scaffold that failed halfway)', () => {
    expect(folderTemplateIsSafeToApply(['1. Resources'])).toBe(true);
    expect(folderTemplateIsSafeToApply(FOLDER_TEMPLATE_TOP_LEVEL)).toBe(true);
  });

  it('leaves a hand-made layout alone', () => {
    expect(folderTemplateIsSafeToApply(['Client assets'])).toBe(false);
    // Our folders plus one of theirs is still theirs — they've already set up.
    expect(folderTemplateIsSafeToApply([...FOLDER_TEMPLATE_TOP_LEVEL, 'Invoices'])).toBe(false);
  });

  it('holds the template names the deal folder is checked against', () => {
    expect(FOLDER_TEMPLATE_TOP_LEVEL).toEqual([
      '1. Resources', '2. Pre-Production', '3. Video', '4. Signed Off',
    ]);
  });
});
