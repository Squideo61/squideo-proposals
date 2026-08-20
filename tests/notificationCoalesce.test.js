import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
}));
vi.mock('../api/_lib/email.js', () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
  APP_URL: 'https://app.squideo.com',
  adminEmailsExcluding: vi.fn().mockResolvedValue([]),
}));

import { persistInApp } from '../api/_lib/notifications.js';
import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';

beforeEach(() => resetSqlMock());

// A client uploading a brand pack produced one "Client file: X" notification per
// file. Coalescing folds the burst into a single running summary row.

const COALESCE = {
  group: 'portal-upload:deal_1:file',
  summaryTitle: 'Client files: {n} uploaded',
  summaryBody: 'Heather Edgar · S&E Care Trade',
  windowMinutes: 180,
};

// Minimal in-memory stand-in for the coalescing UPDATE/INSERT pair.
function installDb({ existing }) {
  let row = existing ? { id: 7, count: existing } : null;
  setSqlHandler((text, values) => {
    if (/ALTER TABLE|CREATE INDEX/i.test(text)) return [];
    if (/^\s*UPDATE in_app_notifications/i.test(text)) {
      if (!row) return [];                       // nothing to fold into
      row.count += 1;
      const template = values.find((v) => typeof v === 'string' && v.includes('{n}'));
      return [{ id: row.id, title: template.replace('{n}', String(row.count)), body: 'b' }];
    }
    if (/INSERT INTO in_app_notifications/i.test(text)) { row = { id: 7, count: 1 }; return [{ id: 7 }]; }
    return [];
  });
}

const send = (title) => persistInApp('portal.doc_uploaded', ['pm@squideo.co.uk'], {
  subject: title,
  text: null,
  inApp: { title, body: 'Heather Edgar', link: '#/deal/deal_1', coalesce: COALESCE },
});

describe('in-app notification coalescing', () => {
  it('names the file on the first upload — one file is not a summary', async () => {
    installDb({ existing: 0 });
    await send('Client file: micro-extend.zip');
    const inserted = getSqlCalls().find((c) => /INSERT INTO in_app_notifications/i.test(c.text));
    expect(inserted).toBeTruthy();
    expect(inserted.values).toContain('Client file: micro-extend.zip');
    // The group is stored so later uploads can find this row.
    expect(inserted.values).toContain(COALESCE.group);
  });

  it('folds a later upload into the existing row instead of inserting again', async () => {
    installDb({ existing: 1 });
    await send('Client file: microlf.zip');
    const calls = getSqlCalls();
    expect(calls.some((c) => /^\s*UPDATE in_app_notifications/i.test(c.text))).toBe(true);
    expect(calls.some((c) => /INSERT INTO in_app_notifications/i.test(c.text))).toBe(false);
  });

  it('rewrites the row to a running count', async () => {
    installDb({ existing: 7 });
    await send('Client file: S&E Logo silver.png');
    const upd = getSqlCalls().find((c) => /^\s*UPDATE in_app_notifications/i.test(c.text));
    // 7 already folded + this one = 8, substituted into the {n} template.
    expect(upd.values).toContain(COALESCE.summaryTitle);
    expect(upd.text).toMatch(/replace\(\?::text, '\{n\}', \(coalesce_count \+ 1\)::text\)/);
  });

  it('only folds rows that are unread and inside the window', async () => {
    installDb({ existing: 1 });
    await send('Client file: a.png');
    const upd = getSqlCalls().find((c) => /^\s*UPDATE in_app_notifications/i.test(c.text));
    expect(upd.text).toMatch(/read_at IS NULL/);
    expect(upd.text).toMatch(/make_interval\(mins =>/);
    expect(upd.values).toContain(180);
  });

  it('leaves ordinary notifications completely alone', async () => {
    installDb({ existing: 0 });
    await persistInApp('deal.signed', ['pm@squideo.co.uk'], {
      subject: 'Signed: Heather Edgar', text: null,
      inApp: { title: 'Signed: Heather Edgar', link: '#/deal/deal_1' },
    });
    const calls = getSqlCalls();
    // No coalesce lookup, no schema self-heal, and the insert stays on the
    // original column list so it can't depend on the new columns existing.
    expect(calls.some((c) => /^\s*UPDATE in_app_notifications/i.test(c.text))).toBe(false);
    expect(calls.some((c) => /ALTER TABLE in_app_notifications/i.test(c.text))).toBe(false);
    const inserted = calls.find((c) => /INSERT INTO in_app_notifications/i.test(c.text));
    expect(inserted.text).not.toMatch(/coalesce_group/);
  });
});

// "Invoice requested" (client clicks send-me-an-invoice) and "Invoice issued"
// (they complete billing and Xero raises it) are one story, usually a minute
// apart. The second supersedes the first in place — but only while it's unread,
// so an abandoned request still stands on its own.
describe('cross-key supersede', () => {
  const GROUP = 'invoice-route:prop_1';

  const requested = () => persistInApp('invoice.client_requested', ['pm@squideo.co.uk'], {
    subject: 'Invoice requested', text: null,
    inApp: {
      title: '🧾 Invoice requested: Heather Edgar',
      body: 'wants to be invoiced rather than pay by card',
      link: '#/deal/deal_1',
      coalesce: { group: GROUP, summaryTitle: '🧾 Invoice requested: Heather Edgar', windowMinutes: 20160 },
    },
  });
  const issued = () => persistInApp('invoice.issued', ['pm@squideo.co.uk'], {
    subject: 'Invoice issued', text: null,
    inApp: {
      title: '📄 Invoice issued: Heather Edgar',
      body: 'invoiced (50% deposit)',
      link: '#/deal/deal_1',
      coalesce: {
        group: GROUP,
        summaryTitle: '📄 Invoice issued: Heather Edgar',
        summaryBody: 'invoiced (50% deposit)',
        windowMinutes: 20160,
      },
    },
  });

  it('matches on the group alone, so a different key can supersede', async () => {
    installDb({ existing: 1 });
    await issued();
    const upd = getSqlCalls().find((c) => /^\s*UPDATE in_app_notifications/i.test(c.text));
    expect(upd).toBeTruthy();
    // The lookup must NOT be narrowed by notification_key, or "issued" would
    // never find the "requested" row.
    expect(upd.text).not.toMatch(/WHERE user_email = \?\s*AND notification_key/);
    expect(upd.values).toContain(GROUP);
  });

  it('adopts the newer key so the row files under the right bell', async () => {
    installDb({ existing: 1 });
    await issued();
    const upd = getSqlCalls().find((c) => /^\s*UPDATE in_app_notifications/i.test(c.text));
    expect(upd.text).toMatch(/notification_key = \?/);
    expect(upd.values).toContain('invoice.issued');
  });

  it('stands alone when the client abandons at the billing form', async () => {
    installDb({ existing: 0 });
    await requested();
    const calls = getSqlCalls();
    expect(calls.some((c) => /INSERT INTO in_app_notifications/i.test(c.text))).toBe(true);
    const inserted = calls.find((c) => /INSERT INTO in_app_notifications/i.test(c.text));
    expect(inserted.values).toContain('🧾 Invoice requested: Heather Edgar');
  });

  it('issues its own row when there is nothing to supersede', async () => {
    // Staff raised the invoice without a client click, or the request was read.
    installDb({ existing: 0 });
    await issued();
    const inserted = getSqlCalls().find((c) => /INSERT INTO in_app_notifications/i.test(c.text));
    expect(inserted.values).toContain('📄 Invoice issued: Heather Edgar');
  });
});
