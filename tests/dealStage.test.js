import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
}));

import {
  advanceStage,
  regressStage,
  dealIdForProposal,
  logDealEvent,
  isValidStage,
  STAGES,
} from '../api/_lib/dealStage.js';
import {
  setSqlHandler,
  setSqlSequence,
  resetSqlMock,
  getSqlCalls,
} from './helpers/mockDb.js';

beforeEach(() => resetSqlMock());

describe('isValidStage', () => {
  it('accepts every stage in STAGES', () => {
    for (const s of STAGES) expect(isValidStage(s)).toBe(true);
  });

  it('rejects unknown / empty / null stage', () => {
    expect(isValidStage('foo')).toBe(false);
    expect(isValidStage('')).toBe(false);
    expect(isValidStage(null)).toBe(false);
    expect(isValidStage(undefined)).toBe(false);
  });
});

describe('advanceStage', () => {
  it('no-deal: falsy dealId short-circuits before any SQL', async () => {
    const result = await advanceStage(null, 'responded');
    expect(result).toEqual({ changed: false, reason: 'no-deal' });
    expect(getSqlCalls()).toHaveLength(0);
  });

  it('invalid-stage: unknown stage rejected without SQL', async () => {
    const result = await advanceStage('d1', 'banana');
    expect(result).toEqual({ changed: false, reason: 'invalid-stage' });
    expect(getSqlCalls()).toHaveLength(0);
  });

  it('deal-not-found: empty SELECT returns deal-not-found', async () => {
    setSqlSequence([[]]);
    const result = await advanceStage('d1', 'responded');
    expect(result).toEqual({ changed: false, reason: 'deal-not-found' });
    expect(getSqlCalls()).toHaveLength(1);
  });

  it('forward: lead → responded writes UPDATE + stage_change event', async () => {
    setSqlSequence([
      [{ id: 'd1', stage: 'lead' }],
      [],
      [],
    ]);
    const result = await advanceStage('d1', 'responded', {
      actorEmail: 'a@x.com',
      payload: { source: 'reply' },
    });
    expect(result).toEqual({ changed: true, from: 'lead', to: 'responded' });
    const calls = getSqlCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0].text).toContain('SELECT id, stage FROM deals');
    expect(calls[1].text).toContain('UPDATE deals');
    expect(calls[2].text).toContain('INSERT INTO deal_events');
    // INSERT values are (deal_id, payload_json, actor_email) — event_type is
    // the literal 'stage_change' in the SQL, not a parameter.
    expect(calls[2].values[0]).toBe('d1');
    expect(calls[2].values[2]).toBe('a@x.com');
    const eventPayload = JSON.parse(calls[2].values[1]);
    expect(eventPayload).toEqual({ from: 'lead', to: 'responded', source: 'reply' });
  });

  it('forward: bigger jump (lead → signed) still allowed', async () => {
    setSqlSequence([
      [{ id: 'd1', stage: 'lead' }],
      [],
      [],
    ]);
    const result = await advanceStage('d1', 'signed');
    expect(result).toEqual({ changed: true, from: 'lead', to: 'signed' });
  });

  it('lost: any stage → lost is permitted', async () => {
    setSqlSequence([
      [{ id: 'd1', stage: 'signed' }],
      [],
      [],
    ]);
    const result = await advanceStage('d1', 'lost');
    expect(result).toEqual({ changed: true, from: 'signed', to: 'lost' });
  });

  it('long_term: any stage → long_term is permitted', async () => {
    setSqlSequence([
      [{ id: 'd1', stage: 'paid' }],
      [],
      [],
    ]);
    const result = await advanceStage('d1', 'long_term');
    expect(result).toEqual({ changed: true, from: 'paid', to: 'long_term' });
  });

  it('long_term: bidirectional — long_term → responded allowed', async () => {
    setSqlSequence([
      [{ id: 'd1', stage: 'long_term' }],
      [],
      [],
    ]);
    const result = await advanceStage('d1', 'responded');
    expect(result).toEqual({ changed: true, from: 'long_term', to: 'responded' });
  });

  it('no-advance: signed → viewed refused and reports current stage', async () => {
    setSqlSequence([[{ id: 'd1', stage: 'signed' }]]);
    const result = await advanceStage('d1', 'viewed');
    expect(result).toEqual({ changed: false, reason: 'no-advance', current: 'signed' });
    expect(getSqlCalls()).toHaveLength(1);
  });

  it('no-advance: lead → lead refused (no lost/long_term escape hatch)', async () => {
    setSqlSequence([[{ id: 'd1', stage: 'lead' }]]);
    const result = await advanceStage('d1', 'lead');
    expect(result).toEqual({ changed: false, reason: 'no-advance', current: 'lead' });
  });

  it('same-stage: lost → lost is a no-op via the lost escape hatch', async () => {
    setSqlSequence([[{ id: 'd1', stage: 'lost' }]]);
    const result = await advanceStage('d1', 'lost');
    expect(result).toEqual({ changed: false, reason: 'same-stage' });
    expect(getSqlCalls()).toHaveLength(1);
  });
});

describe('regressStage', () => {
  it('no-deal: falsy dealId short-circuits before any SQL', async () => {
    const result = await regressStage(null, 'signed', 'proposal_sent');
    expect(result).toEqual({ changed: false, reason: 'no-deal' });
    expect(getSqlCalls()).toHaveLength(0);
  });

  it('invalid-stage: unknown from/to rejected without SQL', async () => {
    expect(await regressStage('d1', 'banana', 'proposal_sent')).toEqual({ changed: false, reason: 'invalid-stage' });
    expect(await regressStage('d1', 'signed', 'banana')).toEqual({ changed: false, reason: 'invalid-stage' });
    expect(getSqlCalls()).toHaveLength(0);
  });

  it('deal-not-found: empty SELECT returns deal-not-found', async () => {
    setSqlSequence([[]]);
    const result = await regressStage('d1', 'signed', 'proposal_sent');
    expect(result).toEqual({ changed: false, reason: 'deal-not-found' });
  });

  it('stage-mismatch: deal at "paid" is not dragged back from "signed"', async () => {
    setSqlSequence([[{ stage: 'paid' }]]);
    const result = await regressStage('d1', 'signed', 'proposal_sent');
    expect(result).toEqual({ changed: false, reason: 'stage-mismatch', current: 'paid' });
    expect(getSqlCalls()).toHaveLength(1);
  });

  it('signed → proposal_sent: writes UPDATE + stage_change event with reason', async () => {
    setSqlSequence([
      [{ stage: 'signed' }],
      [],
      [],
    ]);
    const result = await regressStage('d1', 'signed', 'proposal_sent', {
      actorEmail: 'a@x.com',
      reason: 'signature-unmarked',
      payload: { proposalId: 'p1' },
    });
    expect(result).toEqual({ changed: true, from: 'signed', to: 'proposal_sent' });
    const calls = getSqlCalls();
    expect(calls).toHaveLength(3);
    expect(calls[1].text).toContain('UPDATE deals');
    expect(calls[2].text).toContain('INSERT INTO deal_events');
    expect(calls[2].values[2]).toBe('a@x.com');
    const eventPayload = JSON.parse(calls[2].values[1]);
    expect(eventPayload).toEqual({
      from: 'signed',
      to: 'proposal_sent',
      reason: 'signature-unmarked',
      proposalId: 'p1',
    });
  });
});

describe('dealIdForProposal', () => {
  it('returns null for falsy proposalId without DB call', async () => {
    expect(await dealIdForProposal(null)).toBeNull();
    expect(getSqlCalls()).toHaveLength(0);
  });

  it('returns deal_id when proposal is found', async () => {
    setSqlSequence([[{ deal_id: 'd42' }]]);
    expect(await dealIdForProposal('p1')).toBe('d42');
  });

  it('returns null when proposal is not found', async () => {
    setSqlSequence([[]]);
    expect(await dealIdForProposal('p1')).toBeNull();
  });

  it('returns null when proposal exists but deal_id column is empty', async () => {
    setSqlSequence([[{ deal_id: null }]]);
    expect(await dealIdForProposal('p1')).toBeNull();
  });
});

describe('logDealEvent', () => {
  it('writes the event then bumps last_activity_at', async () => {
    setSqlSequence([[], []]);
    await logDealEvent('d1', 'note', {
      actorEmail: 'a@x.com',
      payload: { body: 'hi' },
    });
    const calls = getSqlCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].text).toContain('INSERT INTO deal_events');
    expect(calls[0].values[1]).toBe('note');
    expect(JSON.parse(calls[0].values[2])).toEqual({ body: 'hi' });
    expect(calls[0].values[3]).toBe('a@x.com');
    expect(calls[1].text).toContain('UPDATE deals SET last_activity_at');
  });

  it('no-ops without DB calls when dealId is falsy', async () => {
    await logDealEvent(null, 'note');
    expect(getSqlCalls()).toHaveLength(0);
  });
});
