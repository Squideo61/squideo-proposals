// The staff activity log's two pure decisions: what counts as a loggable write,
// and what a before → after diff should say. Both feed an audit trail, so the
// interesting cases are the ones where getting it wrong is quietly misleading —
// a secret in the diff, a blob rendered as gibberish, machine chatter drowning
// the feed.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', () => ({ default: vi.fn() }));

const { diffRows, describeWrite, isLoggableWrite } = await import('../api/_lib/crm/staffActivity.js');

describe('isLoggableWrite', () => {
  it('ignores reads', () => {
    expect(isLoggableWrite('deals', 'd1', 'GET')).toBe(false);
    expect(isLoggableWrite('deals', 'd1', 'PATCH')).toBe(true);
  });

  it('ignores machine chatter that would bury the feed', () => {
    for (const r of ['tracking', 'stats', 'analytics', 'sales-insights', 'resolve-client']) {
      expect(isLoggableWrite(r, null, 'POST')).toBe(false);
    }
  });

  it('logs sending an email but not mailbox plumbing', () => {
    expect(isLoggableWrite('gmail', 'send', 'POST')).toBe(true);
    expect(isLoggableWrite('gmail', 'sync', 'POST')).toBe(false);
  });

  it('never logs reads of the log itself', () => {
    expect(isLoggableWrite('activity', null, 'POST')).toBe(false);
  });
});

describe('diffRows', () => {
  it('reports only what actually changed', () => {
    const changes = diffRows(
      { id: 'd1', title: 'Explainer', value: 4000, stage: 'sold' },
      { id: 'd1', title: 'Explainer', value: 5000, stage: 'sold' },
    );
    expect(changes).toEqual([{ field: 'value', from: '4000', to: '5000' }]);
  });

  it('treats timestamps the write bumps by itself as noise', () => {
    const changes = diffRows(
      { title: 'A', updated_at: new Date('2026-07-01'), last_activity_at: new Date('2026-07-01') },
      { title: 'A', updated_at: new Date('2026-07-30'), last_activity_at: new Date('2026-07-30') },
    );
    expect(changes).toEqual([]);
  });

  it('never puts a secret or a token version in the trail', () => {
    const changes = diffRows(
      { password_hash: 'old', totp_secret: 'A', token_version: 1, name: 'Jess' },
      { password_hash: 'new', totp_secret: 'B', token_version: 2, name: 'Jess Smith' },
    );
    expect(changes).toEqual([{ field: 'name', from: 'Jess', to: 'Jess Smith' }]);
  });

  it('skips binary columns rather than rendering them', () => {
    const changes = diffRows(
      { logo: Buffer.from([1, 2, 3]), name: 'Acme' },
      { logo: Buffer.from([4, 5, 6]), name: 'Acme Ltd' },
    );
    expect(changes.map((c) => c.field)).toEqual(['name']);
  });

  it('records a value appearing and disappearing', () => {
    expect(diffRows({ po_number: null }, { po_number: 'PO-99' }))
      .toEqual([{ field: 'po_number', from: null, to: 'PO-99' }]);
    expect(diffRows({ po_number: 'PO-99' }, { po_number: null }))
      .toEqual([{ field: 'po_number', from: 'PO-99', to: null }]);
  });

  it('clips a long value instead of storing an essay', () => {
    const [change] = diffRows({ notes: 'a' }, { notes: 'b'.repeat(500) });
    expect(change.to.length).toBeLessThanOrEqual(161);
    expect(change.to.endsWith('…')).toBe(true);
  });

  it('compares dates by value, not by object identity', () => {
    const changes = diffRows(
      { due_at: new Date('2026-08-01T09:00:00Z') },
      { due_at: new Date('2026-08-01T09:00:00Z') },
    );
    expect(changes).toEqual([]);
  });
});

describe('describeWrite', () => {
  it('names the record so the line still reads after it is deleted', () => {
    const d = describeWrite({
      resource: 'deals', id: 'd1', action: null, method: 'PATCH',
      body: {}, before: { title: 'The Christie — Explainer' },
    });
    expect(d).toMatchObject({
      action: 'deals.update',
      entity: 'deals',
      entityLabel: 'The Christie — Explainer',
      summary: 'updated deal',
    });
  });

  it('takes the label from the body on a create, when there is no row yet', () => {
    const d = describeWrite({
      resource: 'companies', id: null, action: null, method: 'POST',
      body: { name: 'University of Birmingham' }, before: null,
    });
    expect(d.summary).toBe('created organisation');
    expect(d.entityLabel).toBe('University of Birmingham');
  });

  it('names a created record from the response when the request had no id', () => {
    const d = describeWrite({
      resource: 'deals', id: null, action: null, method: 'POST',
      body: {}, before: null, result: { id: 'deal_9', title: 'Explainer — series of 3' },
    });
    expect(d.entityLabel).toBe('Explainer — series of 3');
    expect(d.summary).toBe('created deal');
  });

  it('prefers the record over the request body for the name', () => {
    const d = describeWrite({
      resource: 'contacts', id: 'c1', action: null, method: 'PATCH',
      body: { name: 'typo' }, before: { name: 'Jess Whitaker', email: 'jess@x.com' },
    });
    expect(d.entityLabel).toBe('Jess Whitaker');
  });

  it('says which part of a record a sub-route touched', () => {
    const d = describeWrite({ resource: 'deals', id: 'd1', action: 'assignees', method: 'POST', body: {}, before: null });
    expect(d.action).toBe('deals.assignees.create');
    expect(d.summary).toBe('created deal assignees');
  });

  it('describes an email by who it went to', () => {
    const d = describeWrite({
      resource: 'gmail', id: 'send', action: null, method: 'POST',
      body: { to: ['jess@christie.nhs.uk'], subject: 'Your portal invite' }, before: null,
    });
    expect(d.action).toBe('gmail.send');
    expect(d.summary).toBe('sent an email to jess@christie.nhs.uk');
  });

  it('falls back to a readable sentence for a resource it has no noun for', () => {
    const d = describeWrite({ resource: 'quote-requests', id: 'q1', action: null, method: 'DELETE', body: {}, before: null });
    expect(d.summary).toBe('deleted quote requests');
  });
});
