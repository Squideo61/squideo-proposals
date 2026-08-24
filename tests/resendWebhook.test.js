import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
  batchWrite: async () => {},
}));

const suppressed = [];
vi.mock('../api/_lib/emailSuppression.js', () => ({
  suppress: async (args) => { suppressed.push(args); return true; },
}));

import handler from '../api/resend-webhook.js';
import { setSqlHandler, resetSqlMock } from './helpers/mockDb.js';

const SECRET = 'whsec_' + Buffer.from('a-test-signing-key').toString('base64');

beforeEach(() => {
  resetSqlMock();
  setSqlHandler(() => []);
  suppressed.length = 0;
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
});

// A request as Resend sends it: raw bytes, Svix headers, valid signature.
function makeReq(payload, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000), id = 'msg_1' } = {}) {
  const body = JSON.stringify(payload);
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  const req = {
    method: 'POST',
    headers: { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${sig}` },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
  return req;
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}

const bounce = (type = 'Permanent', subType = 'General') => ({
  type: 'email.bounced',
  data: { email_id: 'res_1', to: ['dead@nowhere.com'], bounce: { type, subType } },
});

describe('who is allowed to post here', () => {
  it('accepts a correctly signed event', async () => {
    const res = makeRes();
    await handler(makeReq(bounce('Permanent', 'NoEmail')), res);
    expect(res.statusCode).toBe(200);
  });

  it('rejects a forged signature', async () => {
    const res = makeRes();
    await handler(makeReq(bounce(), { secret: 'whsec_' + Buffer.from('wrong-key').toString('base64') }), res);
    expect(res.statusCode).toBe(401);
    expect(suppressed).toHaveLength(0);
  });

  it('rejects a replayed request from hours ago', async () => {
    const res = makeRes();
    const old = Math.floor(Date.now() / 1000) - 3600;
    await handler(makeReq(bounce(), { timestamp: old }), res);
    expect(res.statusCode).toBe(401);
  });

  it('refuses to run at all without a configured secret', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = makeRes();
    await handler(makeReq(bounce()), res);
    expect(res.statusCode).toBe(500);
  });
});

describe('what a bounce does', () => {
  it('suppresses an address that does not exist', async () => {
    await handler(makeReq(bounce('Permanent', 'NoEmail')), makeRes());
    expect(suppressed).toEqual([{
      email: 'dead@nowhere.com', scope: 'all', reason: 'hard_bounce', source: 'resend',
    }]);
  });

  it('understands the words the provider actually uses', async () => {
    // Resend passes SES's vocabulary through: "Permanent" and "Transient".
    // Matching only on "hard"/"soft" classified every real hard bounce as soft
    // and suppressed nothing — the endpoint failing without saying so.
    await handler(makeReq(bounce('Permanent', 'General')), makeRes());
    expect(suppressed.map((s) => s.reason)).toEqual(['hard_bounce']);
  });

  it('also understands the friendlier wording', async () => {
    await handler(makeReq(bounce('hard', '')), makeRes());
    expect(suppressed.map((s) => s.reason)).toEqual(['hard_bounce']);
  });

  it('suppresses a non-existent recipient whatever the type says', async () => {
    await handler(makeReq(bounce('', 'suppressed')), makeRes());
    expect(suppressed.map((s) => s.reason)).toEqual(['hard_bounce']);
  });

  it('does NOT suppress a full mailbox', async () => {
    // A soft bounce is temporary. Dropping someone from the list because their
    // inbox was full for an afternoon loses a real customer for good.
    await handler(makeReq(bounce('Transient', 'MailboxFull')), makeRes());
    expect(suppressed).toHaveLength(0);
  });

  it('treats an unrecognised bounce shape as soft', async () => {
    // Wrongly suppressing someone costs more than one extra bounce.
    await handler(makeReq({ type: 'email.bounced', data: { to: ['x@y.com'], bounce: {} } }), makeRes());
    expect(suppressed).toHaveLength(0);
  });
});

describe('what a spam complaint does', () => {
  it('suppresses immediately and globally', async () => {
    await handler(makeReq({
      type: 'email.complained', data: { email_id: 'res_2', to: ['cross@person.com'] },
    }), makeRes());
    expect(suppressed).toEqual([{
      email: 'cross@person.com', scope: 'all', reason: 'complaint', source: 'resend',
    }]);
  });
});

describe('everything else', () => {
  it('acknowledges events it has no use for, so they are not retried forever', async () => {
    const res = makeRes();
    await handler(makeReq({ type: 'email.delivery_delayed', data: { to: ['x@y.com'] } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ignored).toBe('email.delivery_delayed');
    expect(suppressed).toHaveLength(0);
  });

  it('still answers 200 when the database is unhappy', async () => {
    // A webhook that errors gets retried; a retry storm on top of a database
    // problem is the last thing anyone needs.
    setSqlHandler(() => { throw new Error('db down'); });
    const res = makeRes();
    await handler(makeReq(bounce('Permanent', 'NoEmail')), res);
    expect(res.statusCode).toBe(200);
  });
});
