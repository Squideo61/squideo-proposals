// Two public doors now create portal accounts: the crash course and the brief
// builder. They share one defensively-written signup, so what's pinned here is
// the part that differs — and the part that must NOT.
//
// The attribution carry is the whole reason both live in course_signups.
// createPortalQuoteRequest() reads the attr_* columns off this row when the
// eventual quote request is written, so a signup that loses them produces a
// lead with no campaign against it — invisible in ROAS, and impossible to
// reconstruct after the fact.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock };
});
vi.mock('../api/_lib/course/db.js', () => ({
  ensureCourseTables: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/_lib/disposableEmail.js', () => ({ isDisposableEmail: () => false }));
vi.mock('../api/_lib/notifications.js', () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
  ensureCourseSignupNotificationDefault: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/_lib/internalAccounts.js', () => ({
  internalEmails: async () => [],
  isInternalEmail: () => false,
}));
vi.mock('../api/_lib/portal/onboarding.js', () => ({
  companyNameFromEmail: (e) => String(e).split('@')[1] || null,
  resolveContactForSigner: async () => ({ id: 'ct-1' }),
}));

const applyTag = vi.fn().mockResolvedValue(undefined);
vi.mock('../api/_lib/crm/tags.js', () => ({ applyTag: (...a) => applyTag(...a) }));

import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';
import { createPortalSignup, createCourseSignup } from '../api/_lib/course/signup.js';

const ATTRIBUTION = {
  channel: 'paid_search',
  source: 'google',
  medium: 'cpc',
  campaign: 'brief-builder-uk',
  gclid: 'TEST-GCLID-123',
};

// No existing portal user, so every run takes the "brand new account" path.
function stubFreshSignup() {
  setSqlHandler((text) => {
    if (text.includes('FROM portal_users WHERE email')) return [];
    if (text.includes('FROM course_signup_throttle')) return [{ hour: 0, day: 0 }];
    if (text.includes('INSERT INTO course_signups')) return [{ id: 'csu-new' }];
    if (text.includes('FROM portal_users WHERE id')) {
      return [{ id: 'pu-1', email: 'jo@acme.co.uk', name: 'Jo', token_version: 0, disabled_at: null }];
    }
    return [];
  });
}

// Find the recorded call for a statement and pair its values with the query.
const callFor = (needle) => getSqlCalls().find((c) => c.text.includes(needle));

beforeEach(() => {
  resetSqlMock();
  applyTag.mockClear();
  stubFreshSignup();
});

describe('self-serve signup — per-source wiring', () => {
  it('stamps a brief signup as its own source, not the course', async () => {
    await createPortalSignup({
      source: 'brief', email: 'jo@acme.co.uk', name: 'Jo', ip: '1.2.3.4',
    });
    const row = callFor('INSERT INTO course_signups');
    expect(row.values).toContain('brief');          // signup_source
    expect(row.values).toContain('brief_landing');  // consent_source
    expect(row.values).not.toContain('course_landing');
  });

  it('still stamps a course signup as the course', async () => {
    await createCourseSignup({ email: 'jo@acme.co.uk', name: 'Jo', ip: '1.2.3.4' });
    const row = callFor('INSERT INTO course_signups');
    expect(row.values).toContain('course');
    expect(row.values).toContain('course_landing');
  });

  it('marks the prospect org and membership with the door they came through', async () => {
    await createPortalSignup({ source: 'brief', email: 'jo@acme.co.uk', name: 'Jo' });
    expect(callFor('INSERT INTO companies').values).toContain('brief');
    expect(callFor('INSERT INTO portal_memberships').values).toContain('system:brief');
  });

  it('tags the contact per source so the CRM can tell them apart', async () => {
    await createPortalSignup({ source: 'brief', email: 'jo@acme.co.uk', name: 'Jo' });
    expect(applyTag).toHaveBeenCalledWith('ct-1', 'brief-signup', expect.anything());

    applyTag.mockClear();
    resetSqlMock();
    stubFreshSignup();
    await createCourseSignup({ email: 'jo@acme.co.uk', name: 'Jo' });
    expect(applyTag).toHaveBeenCalledWith('ct-1', 'course-signup', expect.anything());
  });

  it('falls back to course for an unknown source rather than inventing a category', async () => {
    await createPortalSignup({ source: 'nonsense', email: 'jo@acme.co.uk', name: 'Jo' });
    const row = callFor('INSERT INTO course_signups');
    expect(row.values).toContain('course');
    expect(row.values).not.toContain('nonsense');
  });
});

describe('self-serve signup — what must NOT differ by source', () => {
  it('carries first-touch attribution through a brief signup', async () => {
    await createPortalSignup({
      source: 'brief', email: 'jo@acme.co.uk', name: 'Jo', attribution: ATTRIBUTION,
    });
    const row = callFor('INSERT INTO course_signups');
    // These are what createPortalQuoteRequest copies onto the quote request.
    expect(row.values).toContain('TEST-GCLID-123');
    expect(row.values).toContain('paid_search');
    expect(row.values).toContain('brief-builder-uk');
  });

  it('keeps the honeypot silent on every source', async () => {
    const r = await createPortalSignup({
      source: 'brief', email: 'bot@acme.co.uk', name: 'Bot', honeypot: 'http://spam',
    });
    expect(r.silent).toBe(true);
    expect(callFor('INSERT INTO course_signups')).toBeUndefined();
  });

  it('never resolves an existing company, whichever door is used', async () => {
    await createPortalSignup({ source: 'brief', email: 'jo@acme.co.uk', name: 'Jo' });
    const co = callFor('INSERT INTO companies');
    // TRUE is the `prospect` flag: a public form must only ever create a fresh
    // org, never drop a stranger into a real client's portal.
    expect(co.text).toContain('prospect');
    expect(co.values).toContain('brief');
  });
});
