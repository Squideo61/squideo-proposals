// "Record signed proposal" — the staff path for a client who accepted away from
// the link (a signed PDF returned by email or post).
//
// The endpoint it reuses, POST /api/signatures/:id, is PUBLIC: it's the same one
// a client's own click posts to, with no session. So the whole design rests on
// the `recordedOffline` marker being staff-only and stamped server-side — if a
// client could send it, they could suppress their own confirmation email and put
// a colleague's name against their acceptance. These tests hold that line, plus
// the two things a paper deal must not inherit from an online one: a "thanks for
// signing, pay now" email pointing at a link they couldn't open, and a team
// alert that reads as though someone clicked Sign.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqlMock, setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';

vi.mock('../api/_lib/db.js', () => ({ default: sqlMock, batchWrite: async () => {} }));

let session = null;               // what optionalAuth resolves to
let permitted = true;             // what hasPermission answers
vi.mock('../api/_lib/middleware.js', () => ({
  cors: () => {},
  optionalAuth: async () => session,
  requireAuth: async () => session,
}));
vi.mock('../api/_lib/userRoles.js', () => ({ getRole: async () => ({ id: 'sales' }) }));
vi.mock('../api/_lib/permissions.js', () => ({ hasPermission: () => permitted }));

const sentMail = [];
const notifications = [];
vi.mock('../api/_lib/email.js', () => ({
  APP_URL: 'https://app.squideo.com',
  sendMail: async (m) => { sentMail.push(m); },
  signedHtml: () => '<p>signed</p>',
  clientSignedThanksHtml: () => '<p>thanks</p>',
}));
vi.mock('../api/_lib/notifications.js', () => ({
  sendNotification: async (key, payload) => { notifications.push({ key, ...payload }); },
}));

const stageCalls = [];
vi.mock('../api/_lib/dealStage.js', () => ({
  advanceStage: async (dealId, to, opts) => { stageCalls.push({ dealId, to, opts }); },
  regressStage: async () => {},
  dealIdForProposal: async () => 'deal_1',
  ensureDealForProposal: async () => 'deal_1',
  logDealEvent: async () => {},
}));
vi.mock('../api/_lib/crm/deals.js', () => ({ computeProposalTotalExVat: () => 2000 }));
vi.mock('../api/_lib/xero.js', () => ({ voidInvoice: async () => {} }));

const portalWelcomes = [];
vi.mock('../api/_lib/portal/onboarding.js', () => ({
  sendPortalWelcome: async (a) => { portalWelcomes.push(a); },
}));

const handler = (await import('../api/signatures/[id].js')).default;

const STAFF = { email: 'adam@squideo.co.uk', name: 'Adam Shelton', role: 'admin' };

// No existing signature, an owner row for the permission check, and an empty
// proposal payload for the alert. Everything else answers as a bare write.
function withCleanProposal({ ownerEmail = 'adam@squideo.co.uk' } = {}) {
  setSqlHandler((text) => {
    if (text.includes('SELECT 1 FROM signatures')) return [];
    if (text.includes('owner_email')) return ownerEmail ? [{ owner_email: ownerEmail }] : [];
    if (text.includes('SELECT data FROM proposals')) return [{ data: { proposalTitle: 'Explainer', vatRate: 0.2 } }];
    return [];
  });
}

function res() {
  const r = { statusCode: null, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.writeHead = (c) => { r.statusCode = c; return r; };
  return r;
}

const post = (body) => ({ method: 'POST', query: { id: 'id_1' }, headers: {}, body, url: '/api/signatures/id_1' });

const CLIENT_SIG = { name: 'Elaine Chan', email: 'elaine@carrkamasa.co.uk', paymentOption: '5050', total: 2400 };
const OFFLINE = { method: 'pdf', note: 'Signed copy in the Drive folder' };

// The row the handler wrote, parsed back out of the INSERT's JSON parameter.
function insertedSignature() {
  const insert = getSqlCalls().find((c) => c.text.includes('INSERT INTO signatures'));
  if (!insert) return null;
  const [, , , signedAt, dataJson] = insert.values;
  return { signedAt, data: JSON.parse(dataJson) };
}

beforeEach(() => {
  resetSqlMock();
  sentMail.length = 0;
  notifications.length = 0;
  stageCalls.length = 0;
  portalWelcomes.length = 0;
  session = STAFF;
  permitted = true;
});

describe('who may record an offline acceptance', () => {
  it('refuses a recordedOffline marker with no session', async () => {
    session = null;
    withCleanProposal();
    const r = res();
    await handler(post({ ...CLIENT_SIG, signedAt: '2026-09-01T12:00:00.000Z', recordedOffline: OFFLINE }), r);
    expect(r.statusCode).toBe(401);
    // Nothing was written — a rejected record must not half-sign the proposal.
    expect(insertedSignature()).toBeNull();
  });

  it('refuses a team member who neither owns the deal nor manages signatures', async () => {
    session = { email: 'someone.else@squideo.co.uk', name: 'Someone Else', role: 'producer' };
    permitted = false;
    withCleanProposal({ ownerEmail: 'adam@squideo.co.uk' });
    const r = res();
    await handler(post({ ...CLIENT_SIG, signedAt: '2026-09-01T12:00:00.000Z', recordedOffline: OFFLINE }), r);
    expect(r.statusCode).toBe(403);
    expect(insertedSignature()).toBeNull();
  });

  it('lets any signed-in member record a proposal that has no deal owner yet', async () => {
    session = { email: 'someone.else@squideo.co.uk', name: 'Someone Else', role: 'producer' };
    permitted = false;
    withCleanProposal({ ownerEmail: null });
    const r = res();
    await handler(post({ ...CLIENT_SIG, signedAt: '2026-09-01T12:00:00.000Z', recordedOffline: OFFLINE }), r);
    expect(r.statusCode).toBe(201);
  });

  it('leaves the client sign path untouched — no session, no marker, still signs', async () => {
    session = null;
    withCleanProposal();
    const r = res();
    await handler(post({ ...CLIENT_SIG, signedAt: '2026-09-01T12:00:00.000Z' }), r);
    expect(r.statusCode).toBe(201);
    expect(insertedSignature().data.recordedOffline).toBeUndefined();
  });
});

describe('what gets stamped on the record', () => {
  it('takes the recorder from the session, never from the body', async () => {
    withCleanProposal();
    await handler(post({
      ...CLIENT_SIG,
      signedAt: '2026-09-01T12:00:00.000Z',
      // A forged stamp: someone else's name, and a method we don't offer.
      recordedOffline: { ...OFFLINE, by: 'victim@squideo.co.uk', byName: 'Victim', method: 'telepathy' },
    }), res());
    const { recordedOffline } = insertedSignature().data;
    expect(recordedOffline.by).toBe('adam@squideo.co.uk');
    expect(recordedOffline.byName).toBe('Adam Shelton');
    expect(recordedOffline.method).toBe('pdf');       // unknown method falls back
    expect(recordedOffline.note).toBe('Signed copy in the Drive folder');
    expect(recordedOffline.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('stores the date the client signed, not the date it was typed in', async () => {
    withCleanProposal();
    await handler(post({ ...CLIENT_SIG, signedAt: '2026-09-01T12:00:00.000Z', recordedOffline: OFFLINE }), res());
    const row = insertedSignature();
    expect(row.signedAt).toBe('2026-09-01T12:00:00.000Z');
    // …while the stamp records when we learned of it, which is later.
    expect(new Date(row.data.recordedOffline.at).getTime()).toBeGreaterThan(new Date(row.signedAt).getTime());
  });

  it('falls back to now rather than storing a null signed_at', async () => {
    withCleanProposal();
    await handler(post({ ...CLIENT_SIG, signedAt: 'not a date', recordedOffline: OFFLINE }), res());
    // A null signed_at reads as "never signed" in every downstream query — the
    // proposal list derives _signature from it, so the deal would look unsigned
    // moments after being recorded.
    expect(insertedSignature().signedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('carries the marker into the deal history so the stage change is attributable', async () => {
    withCleanProposal();
    await handler(post({ ...CLIENT_SIG, signedAt: '2026-09-01T12:00:00.000Z', recordedOffline: OFFLINE }), res());
    expect(stageCalls[0].to).toBe('signed');
    expect(stageCalls[0].opts.actorEmail).toBe('adam@squideo.co.uk');
    expect(stageCalls[0].opts.payload.recordedOffline.by).toBe('adam@squideo.co.uk');
  });
});

describe('what the client and the team are told', () => {
  it('does not email the client a "thanks for signing, pay now" link', async () => {
    withCleanProposal();
    await handler(post({ ...CLIENT_SIG, signedAt: '2026-09-01T12:00:00.000Z', recordedOffline: OFFLINE }), res());
    // They signed on paper — often *because* the link didn't work for them.
    expect(sentMail).toHaveLength(0);
  });

  it('still emails a client who signed the link themselves', async () => {
    session = null;
    withCleanProposal();
    await handler(post({ ...CLIENT_SIG, signedAt: '2026-09-01T12:00:00.000Z' }), res());
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].to).toBe('elaine@carrkamasa.co.uk');
  });

  it('tells the team it was recorded, by whom, and that no money moved', async () => {
    withCleanProposal();
    await handler(post({ ...CLIENT_SIG, signedAt: '2026-09-01T12:00:00.000Z', recordedOffline: OFFLINE }), res());
    const alert = notifications[0];
    expect(alert.subject).toContain('Recorded as signed');
    expect(alert.subject).not.toContain('🎉');
    expect(alert.text).toContain('Adam Shelton');
    expect(alert.text).toContain('signed PDF returned');
    expect(alert.text).toContain('No online payment has been taken');
    expect(alert.inApp.body).toContain('recorded by Adam Shelton');
  });

  it('leaves the ordinary signed alert alone', async () => {
    session = null;
    withCleanProposal();
    await handler(post({ ...CLIENT_SIG, signedAt: '2026-09-01T12:00:00.000Z' }), res());
    expect(notifications[0].subject).toContain('🎉 Signed:');
  });

  it('still invites the client to the portal — the deal is real either way', async () => {
    withCleanProposal();
    await handler(post({ ...CLIENT_SIG, signedAt: '2026-09-01T12:00:00.000Z', recordedOffline: OFFLINE }), res());
    expect(portalWelcomes).toHaveLength(1);
  });
});

describe('what the client can see of it', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(resolve(root, 'api/signatures/[id].js'), 'utf8');

  it('keeps recordedOffline off the public signature view', () => {
    // The client's own copy of a signed proposal reads the allowlisted fields
    // only. Who on our team keyed it in, and when, is ours — not theirs.
    const allowlist = source.slice(source.indexOf('const PUBLIC_SIGNATURE_FIELDS'), source.indexOf('function publicSignatureView'));
    expect(allowlist).not.toContain('recordedOffline');
  });
});

describe('the record flow in ClientView', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const view = readFileSync(resolve(root, 'src/components/ClientView.jsx'), 'utf8');

  it('persists before the preview branch, not after it', () => {
    // Record mode runs inside the staff preview (isPreview is true — there's no
    // real Stripe behind it), so if the preview branch were reached first it
    // would simulate the signature and return. The feature would appear to work
    // and save nothing. Order is the whole contract.
    const recordBranch = view.indexOf('if (recordMode) {');
    const previewBranch = view.indexOf('setPreviewSigned(sig);');
    expect(recordBranch).toBeGreaterThan(-1);
    expect(previewBranch).toBeGreaterThan(-1);
    expect(recordBranch).toBeLessThan(previewBranch);
  });

  it('does not demand a drawn signature from the person recording', () => {
    // A team member drawing the client's mark would be forging it; the signed
    // block and the PDF both already render without an image.
    expect(view).toContain('if (!sigImage && !recordMode) {');
  });

  it('awaits the write so a refusal surfaces instead of passing silently', () => {
    expect(view).toContain('await actions.recordSignature(id, sig)');
  });
});
