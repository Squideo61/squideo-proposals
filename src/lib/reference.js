// Deal and video reference numbers.
//
// A deal's reference is YYMM-NNN — the month it was formed plus a sequence
// within that month, so 2607-014 reads as "the 14th deal formed in July 2026".
// It's allocated server-side at creation (api/_lib/crm/shared.js) and doubles
// as the project number once the deal reaches production.
//
// A video extends its deal's reference with its own two-digit ordinal:
// 2607-014-01, 2607-014-02. Mirrors videoReference() in
// api/_lib/crm/production.js — keep the two in step.

export function videoReference(projectNumber, videoNumber) {
  if (!projectNumber || videoNumber == null) return null;
  return projectNumber + '-' + String(videoNumber).padStart(2, '0');
}

// Month a reference was issued, as a readable label ("July 2026") — the point
// of a date-based reference is being able to read the date back off it.
export function referenceMonth(reference) {
  const m = /^(\d{2})(\d{2})-/.exec(reference || '');
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const d = new Date(Date.UTC(2000 + Number(m[1]), month - 1, 1));
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
