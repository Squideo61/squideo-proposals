// Date handling for a proposal's issue + expiry fields.
//
// `date` is a dd/mm/yyyy string (written by the browser with
// toLocaleDateString('en-GB')); `expiryDate` is an ISO yyyy-mm-dd date, and is
// only stored once someone sets one by hand. Left unset, the proposal expires
// `validityDays` after `date`, worked out wherever it's rendered.

const pad = (n) => String(n).padStart(2, '0');

// dd/mm/yyyy — built by hand rather than via toLocaleDateString so it can't
// drift with the runtime's locale data.
export function formatDateGB(d) {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function parseDateGB(str) {
  const m = String(str || '').match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return isNaN(d.getTime()) ? null : d;
}

export function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The expiry date a copy of `sourceData` should carry when it's created on
// `from`. Returns undefined when the original had no explicit expiry — the copy
// should then have none either, so it derives from its own date.
//
// A duplicate made today with last month's expiry date goes out already dead,
// so the window is re-run from today. It's the ORIGINAL's window (expiry minus
// its own issue date) that gets reapplied, so a deliberate "valid for 7 days"
// survives duplication; validityDays is the fallback when the original's dates
// don't parse or run backwards.
export function freshExpiryISO(sourceData, from) {
  if (!sourceData?.expiryDate) return undefined;
  let days = Number(sourceData.validityDays) || 28;
  const issued = parseDateGB(sourceData.date);
  const expires = new Date(sourceData.expiryDate);
  if (issued && !isNaN(expires.getTime())) {
    const span = Math.round((expires - issued) / 86400000);
    if (span > 0) days = span;
  }
  const next = new Date(from);
  next.setDate(next.getDate() + days);
  return isoDate(next);
}
