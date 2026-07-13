// Best-effort PO-number detection from an uploaded purchase-order document.
// PDFs are parsed in the browser with pdf.js (already bundled for Storyboard
// Revisions) and scanned for a labelled PO number; scans/photos have no text
// layer, so those fall back to the filename and then to manual entry. Detection
// is only ever a prefill — the user confirms or overwrites the number.
//
// pdf.js is imported lazily inside pdfText() so opening the modal doesn't pull
// the (large) PDF chunk in, and so the pure matching below stays testable.

// Tokens that follow a "PO number" label but are never the number itself.
const STOP_WORDS = new Set([
  'NUMBER', 'NUM', 'NO', 'REF', 'REFERENCE', 'ORDER', 'PURCHASE', 'DATE',
  'TOTAL', 'VAT', 'INVOICE', 'TO', 'FOR', 'AND', 'THE',
]);

function tidy(raw) {
  // Trim the punctuation a PDF text layer tends to glue onto the end of a value.
  return String(raw || '').trim().replace(/^[:#\-\s]+/, '').replace(/[.,;:)\]]+$/, '');
}

function plausible(candidate) {
  const c = tidy(candidate);
  if (c.length < 4 || c.length > 24) return false;
  if (!/\d/.test(c)) return false;                              // a PO always carries digits
  if (STOP_WORDS.has(c.toUpperCase())) return false;
  if (/^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(c)) return false; // a date, not a number
  if (/^(?:£|\$|€)/.test(c)) return false;                      // a money amount
  return true;
}

// Ordered by confidence. A number that carries its own "PO" prefix (PO-2026-0088)
// is unambiguous; then an explicitly labelled one; then a bare SAP-style
// 45xxxxxxxx; then a generic "Order number".
const PATTERNS = [
  /\b(P\.?O\.?[-/]\d[A-Z0-9\-/_]{2,20})\b/gi,
  /(?:purchase[\s-]*order|\bP\.?\s?O\.?\b)\s*(?:number|num\b|no\b|nr\b|#|ref(?:erence)?)?[\s:#.\-–]*([A-Z0-9][A-Z0-9\-/_]{3,23})/gi,
  /\b(45\d{8})\b/g,
  /\border\s*(?:number|num\b|no\b|#)[\s:#.\-–]*([A-Z0-9][A-Z0-9\-/_]{3,23})/gi,
];

// Pull a PO number out of a blob of document text (or a filename). Every match of
// a pattern is considered before moving to the next one — a PO often sits under a
// "Purchase order date:" line, and the date must not end the search.
export function detectPoNumber(text) {
  const flat = String(text || '').replace(/\s+/g, ' ');
  if (!flat.trim()) return null;
  for (const re of PATTERNS) {
    for (const m of flat.matchAll(re)) {
      const hit = tidy(m[1]);
      if (plausible(hit)) return hit;
    }
  }
  return null;
}

// Text of the first few pages of a PDF File/Blob. Later pages are terms &
// conditions boilerplate — the number is always on page 1 (occasionally 2).
async function pdfText(file, maxPages = 2) {
  const { pdfjsLib } = await import('../lib/pdf.js');
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  try {
    const pages = Math.min(doc.numPages, maxPages);
    const chunks = [];
    for (let i = 1; i <= pages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      chunks.push(content.items.map((it) => it.str).join(' '));
    }
    return chunks.join('\n');
  } finally {
    doc.destroy();
  }
}

// Returns { number, source } — source is 'document' | 'filename' — or null when
// nothing usable was found (an image scan with an unhelpful filename, say).
export async function detectPoNumberFromFile(file) {
  if (!file) return null;
  const isPdf = (file.type || '').includes('pdf') || /\.pdf$/i.test(file.name || '');
  if (isPdf) {
    try {
      const found = detectPoNumber(await pdfText(file));
      if (found) return { number: found, source: 'document' };
    } catch {
      // Encrypted or malformed PDF — fall through to the filename.
    }
  }
  const fromName = detectPoNumber((file.name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' '));
  return fromName ? { number: fromName, source: 'filename' } : null;
}
