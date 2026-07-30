// The invite email is composed by hand from a template, so the one thing that
// MUST survive is the link — a mangled or dropped {{portal_link}} sends a
// client an invite they can't accept.
import { describe, it, expect } from 'vitest';
import {
  portalInviteTemplate,
  fillPortalInvite,
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

describe('firstNameFor', () => {
  it('never renders an empty greeting', () => {
    expect(firstNameFor({})).toBe('there');
    expect(firstNameFor({ name: '   ' })).toBe('there');
  });
  it('capitalises a lowercase local part', () => {
    expect(firstNameFor({ email: 'adam@squideo.co.uk' })).toBe('Adam');
  });
});
