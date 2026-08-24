import { describe, it, expect } from 'vitest';
import { parseQuoteRequestEmail, bodyToText } from '../api/_lib/crm/quoteEmailParser.js';

const OURS = ['squideo.co.uk', 'squideo.com'];

// The real thing, verbatim from a 2026 notification.
const REAL = `New Quote Request Received!
________________________________

CONTACT INFORMATION:
👤 Name: Lauren
📧 Email: lauren@tb-projects.co.uk
📱 Phone: 77758 664 96
🏢 Company: TB Projects
Opt In? false

PROJECT DETAILS:
📋 Description: We would like to create a 2D animated explainer video to explain our Design & Build service

60-90 seconds with a voiceover & royalty free music
We'd like to use this on our website, email to clients and social media
🎬 Video Length:

TIMELINE & BUDGET:
⏰ Timeline: 6-8 weeks - I'm happy to slot into Squideo's normal production schedule
💰 Budget: Unsure - please advise. Looking for something cost effective but still polished.

ADDITIONAL INFO:
📎 Uploaded Files:

📅 Submitted: 2026-02-18T14:00:09.532Z
🆔 Form Session: null`;

describe('a real quote-request notification', () => {
  const parsed = parseQuoteRequestEmail({
    subject: 'Quote Request', body: REAL, internalDomains: OURS,
  });

  it('finds the enquirer, not us', () => {
    // The From address on these is our own — reading the sender gets you
    // yourself, which is the whole reason this parser exists.
    expect(parsed.email).toBe('lauren@tb-projects.co.uk');
    expect(parsed.name).toBe('Lauren');
  });

  it('reads the rest of the contact block', () => {
    expect(parsed.phone).toBe('77758 664 96');
    expect(parsed.company).toBe('TB Projects');
  });

  it('reads the marketing tick as the false it is', () => {
    // Getting this wrong would put someone on a marketing list who said no.
    expect(parsed.optIn).toBe(false);
  });

  it('keeps the whole brief, not just the first line', () => {
    expect(parsed.description).toContain('2D animated explainer video');
    expect(parsed.description).toContain('60-90 seconds with a voiceover');
    expect(parsed.description).toContain('website, email to clients and social media');
    // …and stops before the next section.
    expect(parsed.description).not.toContain('Timeline');
    expect(parsed.description).not.toContain('Submitted');
  });

  it('does not swallow the "PROJECT DETAILS" heading as the description', () => {
    // The heading sits immediately above the real Description line and matches
    // the same label list. Taking it leaves the description empty and drags the
    // "📋 Description:" label into the text instead.
    expect(parsed.description.startsWith('We would like')).toBe(true);
    expect(parsed.description).not.toMatch(/Description\s*:/i);
    expect(parsed.description).not.toContain('📋');
  });

  it('reports the fields the template left blank as blank', () => {
    // "🎬 Video Length:" with nothing after it must not pick up the next line.
    expect(parsed.videoLength).toBe(null);
  });

  it('reads timeline and budget', () => {
    expect(parsed.timeline).toContain('6-8 weeks');
    expect(parsed.budget).toContain('Unsure - please advise');
  });

  it('dates the enquiry from the form, not from the email', () => {
    expect(parsed.submittedAt).toBe('2026-02-18T14:00:09.532Z');
  });

  it('treats the template\'s literal "null" as nothing', () => {
    expect(parsed.formSession).toBe(null);
    expect(parsed.videoLength).toBe(null);
    expect(parsed.files).toBe(null);
  });
});

describe('older and messier versions of the template', () => {
  it('copes with no emoji and different labels', () => {
    const parsed = parseQuoteRequestEmail({
      subject: 'New Enquiry',
      body: [
        'Name: Jo Blogs',
        'E-mail: jo@beta.co.uk',
        'Telephone: 01482 000000',
        'Organisation: Beta Ltd',
        'Message: Need a 30 second promo',
        'Budget: £5k',
      ].join('\n'),
      internalDomains: OURS,
    });
    expect(parsed.email).toBe('jo@beta.co.uk');
    expect(parsed.name).toBe('Jo Blogs');
    expect(parsed.phone).toBe('01482 000000');
    expect(parsed.company).toBe('Beta Ltd');
    expect(parsed.budget).toBe('£5k');
  });

  it('takes an address out of an html body', () => {
    const parsed = parseQuoteRequestEmail({
      subject: 'Quote Request',
      html: '<div><p>CONTACT INFORMATION:</p><p>Name: Kit Ray</p>'
        + '<p>Email: <a href="mailto:kit@gamma.io">kit@gamma.io</a></p>'
        + '<p>Opt In? true</p></div>',
      internalDomains: OURS,
    });
    expect(parsed.email).toBe('kit@gamma.io');
    expect(parsed.name).toBe('Kit Ray');
    expect(parsed.optIn).toBe(true);
  });

  it('unwraps a name-and-address value', () => {
    const parsed = parseQuoteRequestEmail({
      subject: 'Quote Request',
      body: 'CONTACT INFORMATION:\nEmail: Lauren <lauren@tb-projects.co.uk>',
      internalDomains: OURS,
    });
    expect(parsed.email).toBe('lauren@tb-projects.co.uk');
  });

  it('falls back to the first non-Squideo address when nothing is labelled', () => {
    const parsed = parseQuoteRequestEmail({
      subject: 'New Quote Request',
      body: 'Opt In? no\nSomebody at pat@delta.com wants a video, replies go to adam@squideo.co.uk',
      internalDomains: OURS,
    });
    expect(parsed.email).toBe('pat@delta.com');
  });

  it('dates from the message when the body has no Submitted line', () => {
    const parsed = parseQuoteRequestEmail({
      subject: 'Quote Request',
      body: 'CONTACT INFORMATION:\nEmail: sam@acme.com',
      fallbackAt: '2019-06-01T10:00:00.000Z',
      internalDomains: OURS,
    });
    expect(parsed.submittedAt).toBe('2019-06-01T10:00:00.000Z');
  });
});

describe('what it refuses to treat as an enquiry', () => {
  it('ignores ordinary mail that merely mentions a quote', () => {
    expect(parseQuoteRequestEmail({
      subject: 'Re: your quote for the scaffolding',
      body: 'Hi Adam, here is our quote, regards Dave',
      internalDomains: OURS,
    })).toBe(null);
  });

  it('will not invent an enquiry from our own address alone', () => {
    // A notification whose only address is ours is a broken one, not a lead.
    expect(parseQuoteRequestEmail({
      subject: 'Quote Request',
      body: 'CONTACT INFORMATION:\nEmail: adam@squideo.co.uk\nOpt In? false',
      internalDomains: OURS,
    })).toBe(null);
  });

  it('ignores an empty body', () => {
    expect(parseQuoteRequestEmail({ subject: 'Quote Request', body: '', internalDomains: OURS })).toBe(null);
  });

  it('rejects a nonsense submitted date rather than trusting it', () => {
    const parsed = parseQuoteRequestEmail({
      subject: 'Quote Request',
      body: 'Email: sam@acme.com\nSubmitted: not a date',
      fallbackAt: '2020-01-01T00:00:00.000Z',
      internalDomains: OURS,
    });
    expect(parsed.submittedAt).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('html flattening', () => {
  it('keeps the line breaks the labels depend on', () => {
    expect(bodyToText('<p>Name: Sam</p><p>Email: sam@acme.com</p>'))
      .toContain('Name: Sam\nEmail: sam@acme.com');
  });
});
