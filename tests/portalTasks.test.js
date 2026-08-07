import { describe, it, expect } from 'vitest';
import { deriveProjectTasks, countOpenTasks, bellTaskRows } from '../api/_lib/portal/tasks.js';

// The portal "Your tasks" checklist. Tasks unlock only once the PM has launched
// them (sent the intro email → deal.client_tasks_launched_at) or the project is
// already in production. PO is task #1 for PO-route deals.

const launched = { id: 'd1', client_tasks_launched_at: '2026-07-27T10:00:00Z' };

describe('deriveProjectTasks — gating', () => {
  it('shows nothing until the PM launches the tasks', () => {
    const deal = { id: 'd1', client_tasks_launched_at: null, production_phase: null, payment_terms: 'po' };
    expect(deriveProjectTasks({ deal, videos: [{ id: 'v1' }], hasVoiceover: true })).toEqual([]);
  });

  it('unlocks once the intro email has been sent', () => {
    const deal = { ...launched, payment_terms: null };
    const tasks = deriveProjectTasks({ deal, videos: [{ id: 'v1' }], hasVoiceover: true });
    expect(tasks.map((t) => t.key)).toEqual(['brand', 'script', 'voiceover', 'kickoff']);
  });

  it('also unlocks for a project already in production (pre-feature deals)', () => {
    const deal = { id: 'd1', client_tasks_launched_at: null, production_phase: 'pre_pro' };
    const tasks = deriveProjectTasks({ deal, videos: [{ id: 'v1' }], hasVoiceover: true });
    expect(tasks.length).toBe(4);
  });
});

describe('deriveProjectTasks — PO task', () => {
  it('is first, and todo, for a PO deal without a PO number', () => {
    const deal = { ...launched, payment_terms: 'po', po_number: null };
    const tasks = deriveProjectTasks({ deal, videos: [{ id: 'v1' }], hasVoiceover: true });
    expect(tasks[0].key).toBe('po');
    expect(tasks[0].status).toBe('todo');
    expect(tasks[0].cta.action).toBe('po-number');
    expect(tasks.map((t) => t.key)).toEqual(['po', 'brand', 'script', 'voiceover', 'kickoff']);
  });

  it('detects the PO route from the signature payment option too', () => {
    const deal = { ...launched, payment_terms: null, po_number: null };
    const tasks = deriveProjectTasks({ deal, videos: [], hasVoiceover: false, sigPaymentOption: 'po' });
    expect(tasks[0].key).toBe('po');
  });

  it('marks the PO task done once the number lands', () => {
    const deal = { ...launched, payment_terms: 'po', po_number: 'PO-1234' };
    const tasks = deriveProjectTasks({ deal, videos: [], hasVoiceover: false });
    expect(tasks[0].status).toBe('done');
    expect(tasks[0].detail).toContain('PO-1234');
  });

  it('is absent for a non-PO deal', () => {
    const deal = { ...launched, payment_terms: 'full' };
    const tasks = deriveProjectTasks({ deal, videos: [{ id: 'v1' }], hasVoiceover: true });
    expect(tasks.map((t) => t.key)).not.toContain('po');
  });
});

describe('deriveProjectTasks — voiceover task', () => {
  it('is omitted when the project has no voiceover', () => {
    const deal = { ...launched, payment_terms: null };
    const tasks = deriveProjectTasks({ deal, videos: [{ id: 'v1' }], hasVoiceover: false });
    expect(tasks.map((t) => t.key)).toEqual(['brand', 'script', 'kickoff']);
  });

  it('is todo until every video has an artist, then done', () => {
    const deal = { ...launched, payment_terms: null };
    const partial = deriveProjectTasks({
      deal,
      videos: [{ id: 'v1', voiceover_artist_id: 'a1' }, { id: 'v2', voiceover_artist_id: null }],
      hasVoiceover: true,
    });
    expect(partial.find((t) => t.key === 'voiceover').status).toBe('todo');

    const all = deriveProjectTasks({
      deal,
      videos: [{ id: 'v1', voiceover_artist_id: 'a1' }, { id: 'v2', voiceover_artist_id: 'a2' }],
      hasVoiceover: true,
    });
    expect(all.find((t) => t.key === 'voiceover').status).toBe('done');
  });
});

describe('deriveProjectTasks — brand assets task', () => {
  it('always appears once launched, todo when we have no brand assets', () => {
    const deal = { ...launched, payment_terms: null };
    const tasks = deriveProjectTasks({ deal, videos: [], hasVoiceover: false });
    const brand = tasks.find((t) => t.key === 'brand');
    expect(brand).toBeTruthy();
    expect(brand.status).toBe('todo');
    expect(brand.cta.href).toBe('#/documents');
  });

  it('is done ("we already have these") when the org has brand assets on file', () => {
    const deal = { ...launched, payment_terms: null };
    const tasks = deriveProjectTasks({ deal, videos: [], hasVoiceover: false, hasBrandAssets: true });
    const brand = tasks.find((t) => t.key === 'brand');
    expect(brand.status).toBe('done');
    expect(brand.detail).toContain('already have');
  });
});

describe('deriveProjectTasks — script & visual direction task', () => {
  const deal = { ...launched, payment_terms: null };
  const scriptTask = (bundle) =>
    deriveProjectTasks({ deal, videos: [], hasVoiceover: false, ...bundle }).find((t) => t.key === 'script');

  it('is todo, and deep-links to its own page, until we have something', () => {
    const t = scriptTask({});
    expect(t.status).toBe('todo');
    expect(t.cta.href).toBe('#/script/d1');
  });

  it('is done once the client has uploaded a file, and invites a new version', () => {
    const t = scriptTask({ scriptFileCount: 2 });
    expect(t.status).toBe('done');
    expect(t.detail).toContain('2 files');
    expect(t.detail).toContain('updated version');
  });

  it('is done when staff tick "we already have it" — the pre-sale email case', () => {
    const t = scriptTask({ scriptStatus: 'received' });
    expect(t.status).toBe('done');
    expect(t.detail).toContain('already have');
  });

  it('is done when the client asks us to write it', () => {
    const t = scriptTask({ scriptStatus: 'squideo' });
    expect(t.status).toBe('done');
    expect(t.detail).toContain('write it');
  });

  it('reports "we’re refining your draft" when staff tick that', () => {
    const t = scriptTask({ scriptStatus: 'refining', scriptFileCount: 1 });
    expect(t.status).toBe('done');
    expect(t.detail).toContain('refining your draft');
  });

  it('keeps the refining wording ahead of the plain "we’ve got your files" line', () => {
    // A draft we're actively polishing outranks the generic upload count, even
    // after the client sends another version.
    const t = scriptTask({ scriptStatus: 'refining', scriptFileCount: 3 });
    expect(t.detail).not.toContain('3 files');
  });

  it('lets an upload override "we’ll write it"', () => {
    const t = scriptTask({ scriptStatus: 'squideo', scriptFileCount: 1 });
    expect(t.detail).toContain('1 file');
  });
});

describe('deriveProjectTasks — kick-off task', () => {
  it('flips to done once a kick-off booking exists', () => {
    const deal = { ...launched, payment_terms: null };
    const before = deriveProjectTasks({ deal, videos: [], hasVoiceover: false });
    expect(before.find((t) => t.key === 'kickoff').status).toBe('todo');

    const after = deriveProjectTasks({ deal, videos: [], hasVoiceover: false, hasKickoffBooking: true });
    expect(after.find((t) => t.key === 'kickoff').status).toBe('done');
  });
});

describe('countOpenTasks', () => {
  it('counts only the todo tasks', () => {
    const deal = { ...launched, payment_terms: 'po', po_number: null };
    const tasks = deriveProjectTasks({
      deal,
      videos: [{ id: 'v1', voiceover_artist_id: 'a1' }],
      hasVoiceover: true,
      hasKickoffBooking: true,
      hasBrandAssets: true,
      scriptStatus: 'received',
    });
    // PO todo; brand, script, voiceover and kickoff all done → 1 open
    expect(countOpenTasks(tasks)).toBe(1);
  });
});

// The bell lists outstanding tasks one per line, derived on every read rather
// than stored — so the rules about what makes the list, and where each row
// goes when clicked, are the whole contract.
describe('bellTaskRows', () => {
  const deal = { id: 'd1', title: 'Brand Video' };
  const todo = { key: 'brand', title: 'Upload your brand guidelines & logo', detail: 'Share your logo…', status: 'todo', cta: { label: 'Upload', href: '#/documents' } };
  const done = { key: 'kickoff', title: 'Book your kick-off call', detail: 'Booked', status: 'done', cta: { label: 'View call', href: '#/kickoff/d1' } };

  it('lists only what is still open', () => {
    const rows = bellTaskRows([{ deal, tasks: [todo, done] }]);
    expect(rows.map((r) => r.title)).toEqual(['Upload your brand guidelines & logo']);
  });

  it('carries the task straight to where it gets done', () => {
    expect(bellTaskRows([{ deal, tasks: [todo] }])[0].link).toBe('#/documents');
  });

  it('sends an in-page action to the project that hosts the form', () => {
    // The PO task's CTA is an action, not a link — the bell can only navigate,
    // so it must land them on the page with the form rather than nowhere.
    const po = { key: 'po', title: 'Send us your purchase order', status: 'todo', cta: { label: 'Submit PO', action: 'po-number' } };
    expect(bellTaskRows([{ deal, tasks: [po] }])[0].link).toBe('#/project/d1');
  });

  it('keeps the same task on two projects as two rows', () => {
    const other = { id: 'd2', title: 'Recruitment Video' };
    const rows = bellTaskRows([{ deal, tasks: [todo] }, { deal: other, tasks: [todo] }]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(rows.map((r) => r.dealTitle)).toEqual(['Brand Video', 'Recruitment Video']);
  });

  it('survives the shapes an empty or half-loaded project produces', () => {
    expect(bellTaskRows()).toEqual([]);
    expect(bellTaskRows([{ deal, tasks: [] }])).toEqual([]);
    expect(bellTaskRows([{ deal: null, tasks: [todo] }])).toEqual([]);
    expect(bellTaskRows([{ deal }])).toEqual([]);
  });
});
