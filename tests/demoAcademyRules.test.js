import { describe, expect, it } from 'vitest';
import {
  ago, cleanDemoOpened, demoOpenedMessage, groupDemos, lastSeenText, loginsText, roleLabel,
} from '../api/_lib/crm/demoAcademyRules.js';

const NOW = new Date('2026-09-11T12:00:00Z');
const demo = (name, demoType, start = null) => ({
  id: name, name, demoType,
  lastVisit: start ? { start, end: start, device: 'Safari on iPhone', logins: [`${name.toLowerCase()}.demo@squideo.co.uk`] } : null,
});

describe('groupDemos', () => {
  const groups = groupDemos([
    demo('Juno', 'consent', '2026-09-11T08:00:00Z'),
    demo('ASH', 'training', '2026-09-10T08:00:00Z'),
    demo('Squideo', 'training', '2026-09-11T11:00:00Z'),
    demo('Gower', 'induction'),
    demo('Mystery', 'sales'),
  ]);

  it('puts inductions, consent and training in that order, then anything untyped', () => {
    expect(groups.map((g) => g.label)).toEqual(['Inductions', 'Consent', 'Training & e-learning', 'No type yet']);
  });

  it('shows the most recently opened first within a group', () => {
    expect(groups[2].demos.map((d) => d.name)).toEqual(['Squideo', 'ASH']);
  });

  it('leaves empty groups out unless asked', () => {
    expect(groupDemos([demo('Juno', 'consent')]).map((g) => g.type)).toEqual(['consent']);
    expect(groupDemos([], { keepEmpty: true })).toHaveLength(4);
  });
});

describe('how a visit reads', () => {
  it('says how long ago, in words', () => {
    expect(ago('2026-09-11T11:59:30Z', NOW)).toBe('just now');
    expect(ago('2026-09-11T11:48:00Z', NOW)).toBe('12 minutes ago');
    expect(ago('2026-09-11T09:00:00Z', NOW)).toBe('3 hours ago');
    expect(ago('2026-09-10T10:00:00Z', NOW)).toBe('yesterday');
    expect(ago('2026-08-01T10:00:00Z', NOW)).toBe('1 Aug');
    expect(ago(null, NOW)).toBeNull();
  });

  it('says when, as whom and on what — or that nobody has been in', () => {
    expect(lastSeenText(demo('Juno', 'consent', '2026-09-11T09:00:00Z'), NOW))
      .toBe('Opened 3 hours ago as juno.demo@squideo.co.uk, on Safari on iPhone');
    expect(lastSeenText(demo('Gower', 'induction'), NOW)).toBe('Not opened yet');
  });
});

describe('loginsText', () => {
  it('is ready to paste into an email', () => {
    expect(loginsText({
      name: 'Juno Genetics', url: 'https://juno.learn.squideo.com', password: 'junogenetics',
      logins: [{ email: 'juno.demo@squideo.co.uk', role: 'learner' }, { email: 'juno.admin@squideo.co.uk', role: 'admin' }],
    })).toBe('Juno Genetics demo\nhttps://juno.learn.squideo.com\n\nLearner: juno.demo@squideo.co.uk\nAdmin: juno.admin@squideo.co.uk\nPassword (all logins): junogenetics');
    expect(roleLabel('something')).toBe('Login');
  });
});

describe('the demo-opened event', () => {
  it('keeps what it needs and cleans the rest', () => {
    const e = cleanDemoOpened({
      tenantId: 't1', academyName: ' Gower Chemicals ', demoType: 'induction', login: 'gower.demo@squideo.co.uk',
      device: 'Chrome on Windows', at: '2026-09-11T10:00:00Z', crmDealId: 'deal_1', extra: 'ignored',
    });
    expect(e).toMatchObject({ tenantId: 't1', academyName: 'Gower Chemicals', demoType: 'induction', crmDealId: 'deal_1' });
    expect(e).not.toHaveProperty('extra');
  });

  it('refuses one with no academy, and survives a bad type or time', () => {
    expect(cleanDemoOpened({ tenantId: 't1' })).toBeNull();
    const e = cleanDemoOpened({ tenantId: 't1', academyName: 'X', demoType: 'nope', at: 'not a date' });
    expect(e.demoType).toBeNull();
    expect(Number.isFinite(new Date(e.at).getTime())).toBe(true);
  });

  it('writes the alert, naming the deal when there is one', () => {
    const e = cleanDemoOpened({ tenantId: 't1', academyName: 'Juno Genetics', login: 'juno.demo@squideo.co.uk', device: 'Safari on iPhone' });
    expect(demoOpenedMessage(e)).toEqual({
      subject: 'Juno Genetics has opened their demo',
      body: 'Signed in as juno.demo@squideo.co.uk, on Safari on iPhone.',
    });
    expect(demoOpenedMessage(e, { title: 'Juno Genetics – patient education' }).body).toMatch(/Deal: Juno Genetics – patient education\.$/);
  });
});
