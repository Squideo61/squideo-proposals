import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
  batchWrite: async () => {},
}));

import {
  renderMergeTags, htmlToText, stripUnsafeHtml, firstNameOf, wrapCampaignHtml,
  ctaButton, DEFAULT_CAMPAIGN_BODY,
} from '../api/_lib/crm/campaignHtml.js';
import { renderForRecipient } from '../api/_lib/crm/campaigns.js';

const CAMPAIGN = {
  id: 'camp_1',
  subject: 'A question for {{first_name|you}}',
  preheader: 'Two minutes, no pitch',
  bodyHtml: '<p>Hi {{first_name|there}}, is video still on the list at {{company|your company}}?</p>'
    + '<p><a href="https://squideo.com/pricing">See prices</a> or <a href="https://squideo.com/work">watch our work</a>.</p>',
};

describe('merge tags', () => {
  it('substitutes what it knows and falls back to what it does not', () => {
    const out = renderMergeTags('Hi {{first_name|there}} at {{company|your company}}', {
      name: 'Sam Taylor', companyName: '',
    });
    expect(out).toBe('Hi Sam at your company');
  });

  it('escapes the values — a contact name cannot inject markup', () => {
    const out = renderMergeTags('Hi {{name}}', { name: '<img src=x onerror=alert(1)>' });
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('leaves an unknown tag visible so a typo shows up in the test send', () => {
    expect(renderMergeTags('Hi {{firstname}}', { name: 'Sam' })).toBe('Hi {{firstname}}');
  });

  it('does not greet someone by their email address', () => {
    expect(firstNameOf('sam@acme.com')).toBe('');
    expect(renderMergeTags('Hi {{first_name|there}}', { name: 'sam@acme.com' })).toBe('Hi there');
  });
});

describe('body safety', () => {
  it('strips scripts and inline handlers the composer should never have sent', () => {
    const out = stripUnsafeHtml('<p onclick="steal()">hi</p><script>bad()</script><iframe src="x"></iframe>');
    expect(out).toBe('<p>hi</p>');
  });

  it('produces a readable text alternative', () => {
    expect(htmlToText('<p>Hello</p><ul><li>one</li><li>two</li></ul>')).toBe('Hello\n• one\n• two');
  });
});

describe('a rendered campaign email', () => {
  const recipient = { email: 'sam@acme.com', name: 'Sam Taylor', companyName: 'Acme Ltd' };
  const built = renderForRecipient(CAMPAIGN, recipient, 'tok123');

  it('personalises the subject line', () => {
    expect(built.subject).toBe('A question for Sam');
  });

  it('routes body links through the click tracker, in the order it reports them', () => {
    expect(built.links).toEqual(['https://squideo.com/pricing', 'https://squideo.com/work']);
    expect(built.html).toContain('/api/track/click?t=tok123&l=0');
    expect(built.html).toContain('/api/track/click?t=tok123&l=1');
    expect(built.html).not.toContain('href="https://squideo.com/pricing"');
  });

  it('carries the open pixel', () => {
    expect(built.html).toContain('/api/track/open?t=tok123');
  });

  it('always carries an unsubscribe link, and never routes it through the tracker', () => {
    // The one link that must work even if our redirector doesn't: a broken
    // unsubscribe is how a marketing email becomes a spam complaint.
    const match = built.html.match(/href="([^"]*email-prefs[^"]*)"/);
    expect(match).toBeTruthy();
    expect(match[1]).toContain('action=unsubscribe');
    expect(match[1]).not.toContain('/api/track/click');
  });

  it('gives each recipient their own unsubscribe token', () => {
    const other = renderForRecipient(CAMPAIGN, { ...recipient, email: 'jo@other.com' }, 'tok456');
    const tokenOf = (html) => html.match(/email-prefs[^"]*t=([^"&]+)/)[1];
    expect(tokenOf(built.html)).not.toBe(tokenOf(other.html));
  });

  it('keeps the preheader out of sight but in the html', () => {
    expect(built.html).toContain('Two minutes, no pitch');
    expect(built.html).toMatch(/display:none[^>]*>Two minutes/);
  });

  it('sends a preview or test with no tracking at all', () => {
    const test = renderForRecipient(CAMPAIGN, recipient, null);
    expect(test.html).not.toContain('/api/track/');
    expect(test.links).toEqual([]);
  });
});

describe('the wrapper', () => {
  const html = wrapCampaignHtml({ bodyHtml: '<p>hi</p>', unsubscribeUrl: 'https://x/unsub' });

  it('will not render a marketing email without an opt-out', () => {
    expect(html).toContain('Unsubscribe');
    expect(html).toContain('https://x/unsub');
  });

  it('carries the logo as a hosted image, never a data URI', () => {
    // Every mail client strips data: URIs — the app's own logo constant is one,
    // so using it here would silently ship a broken image to everybody.
    expect(html).toContain('/squideo-logo-email.png');
    expect(html).not.toContain('data:image');
  });

  it('is branded rather than generic', () => {
    expect(html).toContain('#0F2A3D');            // navy header
    expect(html).toContain('#2BB8E6');            // cyan rule
    expect(html).toContain('squideo.com');
    expect(html).toContain('01482 738 656');
  });

  it('states every dimension Outlook needs, and uses no layout it cannot render', () => {
    expect(html).toMatch(/<table role="presentation"/);
    expect(html).toContain('width="600"');
    expect(html).not.toMatch(/display:\s*(flex|grid)/);
  });

  it('keeps the body inside the styled region', () => {
    expect(html).toMatch(/class="sq-body sq-pad"[^>]*>\s*<p>hi<\/p>/);
  });
});

describe('the starter template', () => {
  it('opens with a personalised line, because nobody adds one later', () => {
    expect(DEFAULT_CAMPAIGN_BODY).toContain('{{first_name|there}}');
  });

  it('gives them one thing to click', () => {
    expect(DEFAULT_CAMPAIGN_BODY).toContain('https://squideo.com');
  });

  it('reads as a skeleton, so it cannot be sent as-is by accident', () => {
    expect(DEFAULT_CAMPAIGN_BODY).toMatch(/One or two sentences/);
  });

  it('renders through the same path a real send takes', () => {
    const built = wrapCampaignHtml({
      bodyHtml: renderMergeTags(DEFAULT_CAMPAIGN_BODY, { name: 'Lauren', companyName: 'TB Projects' }),
      unsubscribeUrl: '#',
    });
    expect(built).toContain('Hi Lauren,');
    expect(built).not.toContain('{{');
  });
});

describe('the call-to-action button', () => {
  it('is a table, not a padded link', () => {
    // Outlook ignores padding on inline elements: a styled <a> collapses to
    // underlined text there, which is the difference between a button and a
    // sentence nobody presses.
    const btn = ctaButton('See our work', 'https://squideo.com/work');
    expect(btn).toMatch(/^<table role="presentation"/);
    expect(btn).toContain('bgcolor="#2BB8E6"');
    expect(btn).toContain('https://squideo.com/work');
  });

  it('gets its link tracked like any other', () => {
    const { links } = instrumentHtmlViaRender(ctaButton('Go', 'https://squideo.com/work'));
    expect(links).toEqual(['https://squideo.com/work']);
  });
});

// The button has to survive link rewriting — it's the one link in most
// campaigns anyone actually cares about measuring.
function instrumentHtmlViaRender(bodyHtml) {
  return renderForRecipient(
    { id: 'camp_x', subject: 's', bodyHtml },
    { email: 'sam@acme.com', name: 'Sam' },
    'tok',
  );
}
