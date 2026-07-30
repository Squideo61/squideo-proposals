// The invite email is composed by hand from a template, so the one thing that
// MUST survive is the link — a mangled or dropped {{portal_link}} sends a
// client an invite they can't accept.
import { describe, it, expect } from 'vitest';
import {
  portalInviteTemplate,
  fillPortalInvite,
  unfillPortalInvite,
  wrapSignature,
  firstNameFor,
  PORTAL_INVITE_TEMPLATE_ID,
} from '../src/lib/portalInviteEmail.js';

const LINK = 'https://app.squideo.com/portal?invite=abc123_XYZ-token';

describe('portalInviteTemplate', () => {
  it('uses the saved template when it exists', () => {
    const t = portalInviteTemplate([
      { id: PORTAL_INVITE_TEMPLATE_ID, subject: 'Edited subject', bodyHtml: '<p>Edited</p>' },
    ]);
    expect(t.subject).toBe('Edited subject');
    expect(t.bodyHtml).toBe('<p>Edited</p>');
  });

  it('falls back when the template has been deleted', () => {
    expect(portalInviteTemplate([]).bodyHtml).toContain('{{portal_link}}');
    expect(portalInviteTemplate(null).subject).toBeTruthy();
  });

  it('ignores other templates', () => {
    const t = portalInviteTemplate([{ id: 'tpl_something_else', subject: 'Nope', bodyHtml: '<p>Nope</p>' }]);
    expect(t.subject).not.toBe('Nope');
  });
});

describe('fillPortalInvite', () => {
  const tpl = {
    subject: 'Your {{company}} portal',
    bodyHtml: '<p>Hi {{first_name}},</p><p><a href="{{portal_link}}">Set up your login</a></p>',
  };

  it('puts the invite link into the href intact', () => {
    const out = fillPortalInvite(tpl, { inviteUrl: LINK, email: 'jane@christie.nhs.uk', companyName: 'The Christie' });
    expect(out.bodyHtml).toContain(`href="${LINK}"`);
  });

  it('greets by first name, from the name when we have one', () => {
    const out = fillPortalInvite(tpl, { inviteUrl: LINK, email: 'j@x.com', name: 'Jane Smith' });
    expect(out.bodyHtml).toContain('Hi Jane,');
  });

  it('derives a first name from the address when we do not', () => {
    const out = fillPortalInvite(tpl, { inviteUrl: LINK, email: 'jane.smith@christie.nhs.uk' });
    expect(out.bodyHtml).toContain('Hi Jane,');
  });

  it('leaves the subject unescaped — it is plain text, not HTML', () => {
    const out = fillPortalInvite(tpl, { inviteUrl: LINK, email: 'a@b.com', companyName: 'Marks & Spencer' });
    expect(out.subject).toBe('Your Marks & Spencer portal');
  });

  it('escapes values in the body so they cannot break the markup', () => {
    const out = fillPortalInvite(
      { subject: 'x', bodyHtml: '<p>{{name}}</p>' },
      { inviteUrl: LINK, email: 'a@b.com', name: '<script>alert(1)</script>' },
    );
    expect(out.bodyHtml).not.toContain('<script>');
    expect(out.bodyHtml).toContain('&lt;script&gt;');
  });

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    const out = fillPortalInvite({ subject: '{{nope}}', bodyHtml: '<p>{{nope}}</p>' }, { inviteUrl: LINK, email: 'a@b.com' });
    expect(out.subject).toBe('{{nope}}');
    expect(out.bodyHtml).toContain('{{nope}}');
  });

  it('tolerates whitespace and case in the placeholder', () => {
    const out = fillPortalInvite({ subject: 's', bodyHtml: '<a href="{{ PORTAL_LINK }}">go</a>' }, { inviteUrl: LINK, email: 'a@b.com' });
    expect(out.bodyHtml).toContain(`href="${LINK}"`);
  });
});

// Saving an edited draft as the template must not bake in the person it was
// written for — least of all their one-time invite link, which would then go to
// every future client and be dead for all of them.
describe('unfillPortalInvite', () => {
  const vars = {
    inviteUrl: LINK,
    email: 'd.clark18@nhs.net',
    name: 'Dan Clark',
    companyName: 'The Christie NHS Foundation Trust',
  };

  it('puts the one-time link back as a placeholder', () => {
    const out = unfillPortalInvite(`<p><a href="${LINK}">Set up your login</a></p>`, vars);
    expect(out).not.toContain(LINK);
    expect(out).toContain('{{portal_link}}');
  });

  it('puts the greeting back as a placeholder', () => {
    expect(unfillPortalInvite('<p>Hi Dan,</p>', vars)).toBe('<p>Hi {{first_name}},</p>');
  });

  it('puts the company back as a placeholder', () => {
    const out = unfillPortalInvite('<p>for The Christie NHS Foundation Trust</p>', vars);
    expect(out).toContain('{{company}}');
  });

  it('drops the signature', () => {
    const body = `<p>Hi Dan,</p><br>${wrapSignature('<div>Adam Shelton<br>Partnership Lead</div>')}`;
    const out = unfillPortalInvite(body, vars);
    expect(out).not.toContain('Partnership Lead');
    expect(out).toContain('{{first_name}}');
  });

  it('matches the escaped form a body actually carries', () => {
    const out = unfillPortalInvite('<p>for Marks &amp; Spencer</p>', { ...vars, companyName: 'Marks & Spencer' });
    expect(out).toContain('{{company}}');
  });

  it('does not maul a longer word that merely starts with the name', () => {
    const out = unfillPortalInvite('<p>Hi Dan, this is standard practice.</p>', vars);
    expect(out).toContain('standard');
    expect(out).not.toContain('{{first_name}}dard');
  });

  it('round-trips: fill then unfill returns the template', () => {
    const tpl = { subject: 's', bodyHtml: '<p>Hi {{first_name}},</p><p><a href="{{portal_link}}">Log in</a></p>' };
    const filled = fillPortalInvite(tpl, vars);
    expect(unfillPortalInvite(filled.bodyHtml, vars)).toBe(tpl.bodyHtml);
  });

  it('leaves a body with nothing to substitute alone', () => {
    expect(unfillPortalInvite('<p>Nothing personal here.</p>', vars)).toBe('<p>Nothing personal here.</p>');
  });
});

describe('firstNameFor', () => {
  it('never renders an empty greeting', () => {
    expect(firstNameFor({})).toBe('there');
    expect(firstNameFor({ name: '   ' })).toBe('there');
  });
  it('capitalises a lowercase local part', () => {
    expect(firstNameFor({ email: 'adam@squideo.co.uk' })).toBe('Adam');
  });
});
