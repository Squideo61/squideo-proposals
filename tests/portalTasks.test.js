import { describe, it, expect } from 'vitest';
import { deriveProjectTasks, countOpenTasks } from '../api/_lib/portal/tasks.js';

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
    expect(tasks.map((t) => t.key)).toEqual(['voiceover', 'kickoff']);
  });

  it('also unlocks for a project already in production (pre-feature deals)', () => {
    const deal = { id: 'd1', client_tasks_launched_at: null, production_phase: 'pre_pro' };
    const tasks = deriveProjectTasks({ deal, videos: [{ id: 'v1' }], hasVoiceover: true });
    expect(tasks.length).toBe(2);
  });
});

describe('deriveProjectTasks — PO task', () => {
  it('is first, and todo, for a PO deal without a PO number', () => {
    const deal = { ...launched, payment_terms: 'po', po_number: null };
    const tasks = deriveProjectTasks({ deal, videos: [{ id: 'v1' }], hasVoiceover: true });
    expect(tasks[0].key).toBe('po');
    expect(tasks[0].status).toBe('todo');
    expect(tasks[0].cta.action).toBe('po-number');
    expect(tasks.map((t) => t.key)).toEqual(['po', 'voiceover', 'kickoff']);
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
    expect(tasks.map((t) => t.key)).toEqual(['kickoff']);
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
    });
    // PO todo, voiceover done, kickoff done → 1 open
    expect(countOpenTasks(tasks)).toBe(1);
  });
});
