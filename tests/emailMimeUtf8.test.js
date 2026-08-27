// Emails the CRM sends can carry emoji (the composer has a picker), and have
// always carried £ signs and em dashes. The MIME body must therefore actually
// survive the trip: a part declared 7bit while holding multi-byte UTF-8 is what
// turns "😀" into mojibake in a client that believes the header.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
}));

const { buildBodyEntity } = await import('../api/_lib/crm/gmail.js');

// Pull one decoded part out of the entity, by its Content-Type.
function decodePart(entity, type) {
  const parts = entity.split(/--sqd_alt_[0-9a-f]+/);
  const part = parts.find((p) => p.includes(`Content-Type: ${type}`)) || entity;
  const body = part.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

const HTML = '<p>Thanks 😀 — that’s £1,200 all in ✅</p>';
const TEXT = 'Thanks 😀 — that’s £1,200 all in ✅';

describe('buildBodyEntity', () => {
  it('never declares 7bit', () => {
    expect(buildBodyEntity(HTML, TEXT)).not.toContain('7bit');
    expect(buildBodyEntity(HTML, '')).not.toContain('7bit');
    expect(buildBodyEntity('', TEXT)).not.toContain('7bit');
  });

  it('round-trips emoji and other multi-byte characters in both alternatives', () => {
    const entity = buildBodyEntity(HTML, TEXT);
    expect(entity).toContain('Content-Type: multipart/alternative');
    expect(decodePart(entity, 'text/html')).toBe(HTML);
    expect(decodePart(entity, 'text/plain')).toBe(TEXT);
  });

  it('round-trips an html-only body', () => {
    const entity = buildBodyEntity(HTML, '');
    expect(entity).toContain('Content-Type: text/html; charset=UTF-8');
    expect(entity).toContain('Content-Transfer-Encoding: base64');
    expect(decodePart(entity, 'text/html')).toBe(HTML);
  });

  it('round-trips a text-only body', () => {
    const entity = buildBodyEntity('', TEXT);
    expect(entity).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(decodePart(entity, 'text/plain')).toBe(TEXT);
  });

  it('wraps long bodies to legal line lengths', () => {
    const long = '😀'.repeat(400);
    const entity = buildBodyEntity('', long);
    const body = entity.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    for (const line of body.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    expect(decodePart(entity, 'text/plain')).toBe(long);
  });
});
