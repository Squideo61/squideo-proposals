import { describe, it, expect, vi, beforeEach } from 'vitest';

const blobGet = vi.fn();
vi.mock('@vercel/blob', () => ({ get: (...args) => blobGet(...args) }));

const { bytesUrl, wantsBytes, streamPrivateBlob } = await import('../api/_lib/blobPrivate.js');

// Minimal stand-in for a Node response: records what was set and written.
function fakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: [],
    ended: false,
    status(code) { res.statusCode = code; return res; },
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; },
    json(payload) { res.body.push(payload); res.ended = true; return res; },
    write(chunk) { res.body.push(chunk); return true; },
    once() {},
    end() { res.ended = true; },
  };
  return res;
}

const streamOf = (text) => new ReadableStream({
  start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
});

// The private store can't be read by the browser, so a download endpoint hands
// back a URL pointing at ITSELF with ?bytes=1 and streams on the way back in.
// These two halves have to agree, including through the vercel.json rewrite
// that moves the CRM's path segments into the query string.

describe('bytesUrl', () => {
  it('marks a plain path', () => {
    expect(bytesUrl('/api/crm/deals/d1/client-uploads/f1')).toBe('/api/crm/deals/d1/client-uploads/f1?bytes=1');
  });

  it('appends to a path that already has a query', () => {
    expect(bytesUrl('/api/crm/portal-admin?op=brand-file&id=f1'))
      .toBe('/api/crm/portal-admin?op=brand-file&id=f1&bytes=1');
  });
});

describe('wantsBytes', () => {
  it('reads the parsed query', () => {
    expect(wantsBytes({ query: { bytes: '1' } })).toBe(true);
    expect(wantsBytes({ query: { bytes: '0' } })).toBe(false);
  });

  it('falls back to the raw URL when the platform did not parse one', () => {
    expect(wantsBytes({ url: '/api/crm/deals?_id=d1&_action=files&bytes=1' })).toBe(true);
    expect(wantsBytes({ url: '/api/crm/deals?_id=d1&_action=files' })).toBe(false);
  });

  it('treats a request with neither as a metadata call', () => {
    expect(wantsBytes({})).toBe(false);
    expect(wantsBytes({ query: {}, url: '/api/crm/deals' })).toBe(false);
  });

  it('round-trips its own URL', () => {
    const url = bytesUrl('/api/crm/deals/d1/po-files/f1');
    expect(wantsBytes({ url })).toBe(true);
  });
});

describe('streamPrivateBlob', () => {
  beforeEach(() => blobGet.mockReset());

  it('reads with private access and relays the bytes as an attachment', async () => {
    blobGet.mockResolvedValue({
      statusCode: 200,
      stream: streamOf('hello'),
      blob: { contentType: 'text/plain', size: 5 },
    });
    const res = fakeRes();
    await streamPrivateBlob(res, 'https://store.private.blob/x/brief.docx', {
      filename: 'brief.docx', mimeType: null,
    });

    expect(blobGet).toHaveBeenCalledWith('https://store.private.blob/x/brief.docx', { access: 'private' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.headers['content-length']).toBe('5');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('filename="brief.docx"');
    expect(Buffer.concat(res.body).toString()).toBe('hello');
    expect(res.ended).toBe(true);
  });

  it('keeps a non-ASCII filename readable and still quotes an ASCII fallback', async () => {
    blobGet.mockResolvedValue({ statusCode: 200, stream: streamOf('x'), blob: { contentType: 'application/pdf', size: 1 } });
    const res = fakeRes();
    await streamPrivateBlob(res, 'https://store.private.blob/x/brief.pdf', { filename: 'Résumé "final".pdf' });
    const cd = res.headers['content-disposition'];
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain(encodeURIComponent('Résumé "final".pdf'));
    // The quoted fallback must not carry a quote of its own, or it truncates.
    expect(cd.match(/filename="([^"]*)"/)[1]).not.toContain('"');
  });

  it('404s a blob that has gone missing rather than 500ing', async () => {
    blobGet.mockResolvedValue(null);
    const res = fakeRes();
    await streamPrivateBlob(res, 'https://store.private.blob/x/gone.docx', { filename: 'gone.docx' });
    expect(res.statusCode).toBe(404);
  });

  it('404s a body-less read rather than streaming nothing', async () => {
    blobGet.mockResolvedValue({ statusCode: 304, stream: null, blob: { contentType: null, size: null } });
    const res = fakeRes();
    await streamPrivateBlob(res, 'https://store.private.blob/x/gone.docx', {});
    expect(res.statusCode).toBe(404);
  });

  it('serves inline when asked (previews, not downloads)', async () => {
    blobGet.mockResolvedValue({ statusCode: 200, stream: streamOf('x'), blob: { contentType: 'image/png', size: 1 } });
    const res = fakeRes();
    await streamPrivateBlob(res, 'u', { filename: 'logo.png', download: false });
    expect(res.headers['content-disposition']).toContain('inline');
  });
});
