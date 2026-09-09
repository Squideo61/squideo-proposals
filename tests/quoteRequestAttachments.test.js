// A client attaching a brief to the quote form has three separate ways to lose
// it, and every one of them used to fail silently:
//
//   1. the wrong blob store  — the default store is private, so an upload asking
//      for public access threw before a byte was written;
//   2. the platform body cap — ~4.5 MB, well under the 20 MB the form offers, so
//      a storyboard was rejected before any of our code ran;
//   3. the browser swallowing both of the above, leaving the client with a
//      confirmation and us with a lead that looked attachment-less.
//
// (1) and (2) are wiring — asserted here against the source and vercel.json, in
// the same spirit as publicPageWiring. (3) is the upload_errors record, whose
// sanitising is unit-tested below.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The module under test only imports sql for its self-heal; nothing here runs it.
vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
  batchWrite: async () => {},
}));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const api = readFileSync(resolve(root, 'api/quote-requests.js'), 'utf8');
const form = readFileSync(resolve(root, 'src/components/QuoteRequestForm.jsx'), 'utf8');
const uploader = readFileSync(resolve(root, 'src/lib/quoteUpload.js'), 'utf8');
const portalForm = readFileSync(resolve(root, 'src/portal/pages/RequestVideo.jsx'), 'utf8');
const vercel = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));

const { pickUploadErrors, readUploadErrors } = await import('../api/_lib/quoteRequestUploadErrors.js');

describe('where quote-form attachments are stored', () => {
  it('uses the public store, not the private default one', () => {
    // `put(..., { access: 'public' })` with no token goes to BLOB_READ_WRITE_TOKEN
    // — the private store — and throws "Cannot use public access on a private
    // store". Every attachment was lost to this.
    expect(api).toContain('REVISION_BLOB_READ_WRITE_TOKEN');
    const putCall = api.slice(api.indexOf('await put(`quote-requests/'));
    expect(putCall.slice(0, 300)).toContain('token: QUOTE_BLOB_TOKEN');
  });

  it('mints a client-upload token so big files skip the body cap', () => {
    expect(api).toContain("action === 'upload-token'");
    expect(api).toContain('handleUpload');
    expect(uploader).toContain("import('@vercel/blob/client')");
    expect(uploader).toContain('handleUploadUrl');
  });

  it('has both enquiry forms on that one path', () => {
    // The portal's "request a video" posts into the same endpoint and store, so
    // a brief attached there hit the same cap.
    expect(form).toContain('uploadEnquiryFile');
    expect(portalForm).toContain('uploadEnquiryFile');
  });

  it('lets the quote page reach Blob from the browser', () => {
    // The page's own CSP block replaces the default one, so a client upload from
    // the embedded form needs the store named here or it's blocked outright.
    const block = vercel.headers.find((h) => h.source.startsWith('/quote('));
    const csp = block.headers.find((h) => h.key === 'Content-Security-Policy').value;
    const connect = csp.split('connect-src ')[1].split(';')[0];
    expect(connect).toContain("'self'");
    expect(connect).toContain('blob.vercel-storage.com');
  });

  it('still submits the lead when an attachment fails', () => {
    // An enquiry is worth more than its attachment: the upload failure is
    // recorded and reported, never thrown.
    expect(form).toContain('uploadErrors.push');
    expect(form).toContain('uploadErrors: uploadErrors.length ? uploadErrors : null');
  });
});

describe('pickUploadErrors', () => {
  it('keeps filename, size and reason', () => {
    expect(pickUploadErrors([{ filename: 'storyboard.pdf', sizeBytes: 12_000_000, reason: 'Upload failed (413)' }]))
      .toEqual([{ filename: 'storyboard.pdf', sizeBytes: 12_000_000, reason: 'Upload failed (413)' }]);
  });

  it('drops entries with no filename, and junk', () => {
    expect(pickUploadErrors([null, 'nope', {}, { sizeBytes: 12 }])).toBeNull();
  });

  it('strips newlines, which would land in an email header or body', () => {
    const [row] = pickUploadErrors([{ filename: 'brief\n\ndeck.pdf', reason: 'a\nb' }]);
    expect(row.filename).toBe('brief deck.pdf');
    expect(row.reason).toBe('a b');
  });

  it('caps the list and the field lengths', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ filename: `f${i}.pdf` }));
    expect(pickUploadErrors(many)).toHaveLength(5);
    const [long] = pickUploadErrors([{ filename: 'x'.repeat(500), reason: 'y'.repeat(500) }]);
    expect(long.filename).toHaveLength(255);
    expect(long.reason).toHaveLength(200);
  });

  it('normalises a non-numeric size to null', () => {
    expect(pickUploadErrors([{ filename: 'a.pdf', sizeBytes: 'big' }])[0].sizeBytes).toBeNull();
  });

  it('is null for anything that is not a list', () => {
    expect(pickUploadErrors(null)).toBeNull();
    expect(pickUploadErrors({ filename: 'a.pdf' })).toBeNull();
    expect(pickUploadErrors([])).toBeNull();
  });
});

describe('readUploadErrors', () => {
  it('passes a parsed JSONB array through', () => {
    expect(readUploadErrors([{ filename: 'a.pdf' }])).toEqual([{ filename: 'a.pdf' }]);
  });

  it('parses a row that came back as text', () => {
    expect(readUploadErrors('[{"filename":"a.pdf"}]')).toEqual([{ filename: 'a.pdf' }]);
  });

  it('is null for empty, missing or unparseable values', () => {
    expect(readUploadErrors(null)).toBeNull();
    expect(readUploadErrors([])).toBeNull();
    expect(readUploadErrors('not json')).toBeNull();
  });
});
