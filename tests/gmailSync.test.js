import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
}));

import {
  resolveDealForMessage,
  parseAddressList,
  extractEmail,
  unwrapAngled,
  parsePushBody,
} from '../api/_lib/gmailSync.js';
import { setSqlHandler, resetSqlMock } from './helpers/mockDb.js';

beforeEach(() => resetSqlMock());

describe('extractEmail', () => {
  it('extracts the address from "Name <addr>" format', () => {
    expect(extractEmail('John Doe <john@example.com>')).toBe('john@example.com');
  });

  it('returns a bare address as-is', () => {
    expect(extractEmail('jane@example.com')).toBe('jane@example.com');
  });

  it('returns null for empty / null input', () => {
    expect(extractEmail('')).toBeNull();
    expect(extractEmail(null)).toBeNull();
    expect(extractEmail(undefined)).toBeNull();
  });

  it('returns null for a non-email value', () => {
    expect(extractEmail('no address here')).toBeNull();
  });

  it('trims whitespace around angle brackets', () => {
    expect(extractEmail('  <ada@example.com>  ')).toBe('ada@example.com');
  });
});

describe('parseAddressList', () => {
  it('splits a comma-separated list and extracts each address', () => {
    expect(parseAddressList('a@x.com, "Bob" <b@x.com>, c@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ]);
  });

  it('returns [] for empty / null / undefined', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
  });

  it('drops entries that do not contain an email address', () => {
    expect(parseAddressList('a@x.com, garbage, b@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
    ]);
  });
});

describe('unwrapAngled', () => {
  it('strips angle brackets around a message-id', () => {
    expect(unwrapAngled('<abc@msg-id>')).toBe('abc@msg-id');
  });

  it('returns the trimmed value if there are no angle brackets', () => {
    expect(unwrapAngled('  bare-id  ')).toBe('bare-id');
  });

  it('returns null for falsy input', () => {
    expect(unwrapAngled('')).toBeNull();
    expect(unwrapAngled(null)).toBeNull();
  });
});

describe('resolveDealForMessage', () => {
  // Default args reach Rule 1 (header) onwards — i.e. internalOnly is false.
  const base = Object.freeze({
    userEmail: 'me@squideo.co.uk',
    threadId: 't1',
    fromEmail: 'ext@client.com',
    toEmails: ['me@squideo.co.uk'],
    ccEmails: [],
    inReplyTo: null,
    refs: [],
    xSquideoDeal: null,
    internalOnly: false,
  });

  it('Rule 0 — internal-only thread skips auto-link without DB calls', async () => {
    const r = await resolveDealForMessage({ ...base, internalOnly: true });
    expect(r).toEqual({ dealId: null, resolvedBy: null });
  });

  it('Rule 1 — X-Squideo-Deal header wins when the deal exists', async () => {
    setSqlHandler((text) => {
      if (text.includes('FROM deals WHERE id')) return [{ id: 'd99' }];
      throw new Error('unexpected query: ' + text);
    });
    const r = await resolveDealForMessage({ ...base, xSquideoDeal: 'd99' });
    expect(r).toEqual({ dealId: 'd99', resolvedBy: 'header' });
  });

  it('Rule 1 — header is ignored when the referenced deal does not exist; falls through', async () => {
    setSqlHandler((text) => {
      if (text.includes('FROM deals WHERE id')) return []; // header miss
      if (text.includes('FROM email_thread_deals WHERE gmail_thread_id')) return []; // thread miss
      if (text.includes('matched_contacts')) return []; // contact miss
      if (text.includes('JOIN companies c')) return []; // domain miss
      return [];
    });
    const r = await resolveDealForMessage({ ...base, xSquideoDeal: 'd-missing' });
    expect(r).toEqual({ dealId: null, resolvedBy: null });
  });

  it('Rule 2 — thread continuity inherits the existing email_thread_deals link', async () => {
    setSqlHandler((text) => {
      if (text.includes('email_thread_deals')) return [{ deal_id: 'd5' }];
      throw new Error('unexpected query: ' + text);
    });
    const r = await resolveDealForMessage(base);
    expect(r).toEqual({ dealId: 'd5', resolvedBy: 'thread' });
  });

  it('Rule 3 — in-reply-to inherits the parent message deal', async () => {
    setSqlHandler((text) => {
      if (text.includes('FROM email_thread_deals WHERE gmail_thread_id')) return [];
      if (text.includes('FROM email_messages em')) return [{ deal_id: 'd7' }];
      throw new Error('unexpected query: ' + text);
    });
    const r = await resolveDealForMessage({ ...base, inReplyTo: 'parent-msg' });
    expect(r).toEqual({ dealId: 'd7', resolvedBy: 'in-reply-to' });
  });

  it('Rule 3 — references (without in-reply-to) also trigger parent lookup', async () => {
    setSqlHandler((text) => {
      if (text.includes('FROM email_thread_deals WHERE gmail_thread_id')) return [];
      if (text.includes('FROM email_messages em')) return [{ deal_id: 'd8' }];
      throw new Error('unexpected query: ' + text);
    });
    const r = await resolveDealForMessage({
      ...base,
      refs: ['ancestor-1', 'ancestor-2'],
    });
    expect(r).toEqual({ dealId: 'd8', resolvedBy: 'in-reply-to' });
  });

  it('Rule 4 — contact match returns the most-recent non-lost deal', async () => {
    setSqlHandler((text) => {
      if (text.includes('FROM email_thread_deals WHERE gmail_thread_id')) return [];
      if (text.includes('FROM email_messages em')) return [];
      if (text.includes('matched_contacts')) {
        return [{ id: 'd9', last_activity_at: new Date() }];
      }
      throw new Error('unexpected query: ' + text);
    });
    const r = await resolveDealForMessage(base);
    expect(r).toEqual({ dealId: 'd9', resolvedBy: 'contact' });
  });

  it('Rule 4 — own address is excluded from contact-lookup candidates', async () => {
    let captured = null;
    setSqlHandler((text, values) => {
      if (text.includes('FROM email_thread_deals WHERE gmail_thread_id')) return [];
      if (text.includes('matched_contacts')) {
        captured = values;
        return [];
      }
      if (text.includes('JOIN companies c')) return [];
      return [];
    });
    await resolveDealForMessage({
      ...base,
      fromEmail: 'ME@Squideo.co.uk',
      toEmails: ['someone@client.com'],
    });
    expect(captured).not.toBeNull();
    const flat = captured.flat();
    expect(flat).not.toContain('me@squideo.co.uk');
    expect(flat).toContain('someone@client.com');
  });

  it('Rule 5 — domain match falls back when contact lookup is empty', async () => {
    setSqlHandler((text) => {
      if (text.includes('FROM email_thread_deals WHERE gmail_thread_id')) return [];
      if (text.includes('matched_contacts')) return [];
      if (text.includes('JOIN companies c')) return [{ id: 'd11' }];
      throw new Error('unexpected query: ' + text);
    });
    const r = await resolveDealForMessage(base);
    expect(r).toEqual({ dealId: 'd11', resolvedBy: 'domain' });
  });

  it('returns null when no rule matches', async () => {
    setSqlHandler(() => []);
    const r = await resolveDealForMessage(base);
    expect(r).toEqual({ dealId: null, resolvedBy: null });
  });
});

describe('parsePushBody', () => {
  it('decodes a valid Pub/Sub push body', () => {
    const inner = JSON.stringify({ emailAddress: 'me@squideo.co.uk', historyId: 42 });
    const body = { message: { data: Buffer.from(inner).toString('base64') } };
    expect(parsePushBody(body)).toEqual({
      emailAddress: 'me@squideo.co.uk',
      historyId: '42',
    });
  });

  it('lowercases the emailAddress field', () => {
    const inner = JSON.stringify({ emailAddress: 'ME@Squideo.co.uk', historyId: '1' });
    const body = { message: { data: Buffer.from(inner).toString('base64') } };
    expect(parsePushBody(body).emailAddress).toBe('me@squideo.co.uk');
  });

  it('returns null when the data field is missing', () => {
    expect(parsePushBody({})).toBeNull();
    expect(parsePushBody({ message: {} })).toBeNull();
  });

  it('returns null when the inner payload is not valid JSON', () => {
    const body = { message: { data: Buffer.from('not json').toString('base64') } };
    expect(parsePushBody(body)).toBeNull();
  });

  it('returns null when required fields are missing from the payload', () => {
    const inner = JSON.stringify({ emailAddress: 'me@x' });
    const body = { message: { data: Buffer.from(inner).toString('base64') } };
    expect(parsePushBody(body)).toBeNull();
  });
});
