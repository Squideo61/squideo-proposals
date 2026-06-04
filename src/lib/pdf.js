// Shared PDF.js setup for the Storyboard Revisions feature. Configures the
// worker once (Vite resolves the `?url` import to a hashed asset URL) and
// memoises loaded documents so the same PDF isn't re-fetched/parsed for every
// thumbnail + the main page render.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// url -> Promise<PDFDocumentProxy>. Cached for the page lifetime; storyboard
// PDFs are immutable (a new draft is a new blob URL), so this never goes stale.
const docCache = new Map();

export function loadPdf(url) {
  if (!url) return Promise.reject(new Error('No PDF url'));
  let promise = docCache.get(url);
  if (!promise) {
    promise = pdfjsLib.getDocument({ url }).promise.catch((err) => {
      docCache.delete(url); // allow a retry on transient fetch failures
      throw err;
    });
    docCache.set(url, promise);
  }
  return promise;
}

// Convenience: how many pages/slides a PDF has. Used at upload time so the
// version row stores page_count.
export async function pdfPageCount(url) {
  const doc = await loadPdf(url);
  return doc.numPages;
}

export { pdfjsLib };
