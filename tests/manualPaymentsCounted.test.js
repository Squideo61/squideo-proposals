// Which hand-recorded payments count towards a deal is now defined once, in the
// manual_payments_counted view. This test exists because that rule is read from
// about a dozen places — the deal page, pipeline pills, company balances,
// Finance, commission — and the failure mode of adding a thirteenth that reads
// the raw table is silent: one screen quietly disagrees with another about how
// much a client has paid, and nobody can tell which is right.
//
// So: any query that SUMS manual payments must go through the view. Reads that
// aren't about totals (listing them, loading one by id, "has anything been
// paid") legitimately use the table, and are listed here by name so adding to
// that list is a deliberate act rather than an oversight.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const API = join(process.cwd(), 'api');

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return jsFiles(full);
    return name.endsWith('.js') ? [full] : [];
  });
}

// Every legitimate read of the raw table, with why. A new entry here should
// come with a reason that isn't "to make the test pass".
const ALLOWED = [
  // The view's own definition.
  'api/_lib/crm/manualPaymentLink.js',
  // Does this proposal have ANY payment recorded? A payment linked to a
  // since-reconciled invoice still means money arrived, so the raw table is
  // the honest source for an existence check.
  'api/_lib/crm/cron.js',
  // Single-row CRUD, the payment LIST shown in the UI (which should show
  // everything the team recorded, linked or not), and the manual-invoice
  // linkage check.
  'api/_lib/crm/payments.js',
  // "Has anything been paid" existence check, as above.
  'api/_lib/crm/companies.js',
  // The duplicate-alert guard: it deliberately counts every recorded payment.
  'api/_lib/crm/proposalInvoicePaid.js',
];

describe('manual payments are summed in exactly one way', () => {
  const files = jsFiles(API);

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('never SUMs the raw table', () => {
    const offenders = [];
    for (const file of files) {
      const rel = relative(process.cwd(), file).replace(/\\/g, '/');
      const src = readFileSync(file, 'utf8');
      // SUM(...) reading from manual_payments without the _counted suffix.
      const re = /SUM\([^)]*\)[\s\S]{0,200}?FROM\s+manual_payments(?!_counted)\b/gi;
      if (re.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the list of raw-table readers short and deliberate', () => {
    const readers = new Set();
    for (const file of files) {
      const rel = relative(process.cwd(), file).replace(/\\/g, '/');
      const src = readFileSync(file, 'utf8');
      if (/FROM\s+manual_payments(?!_counted)\b/i.test(src)) readers.add(rel);
    }
    // Anything not on the allowlist is a query that probably meant to use the
    // view — or a deliberate exception that should be documented above.
    expect([...readers].filter((r) => !ALLOWED.includes(r))).toEqual([]);
  });

  it('defines the rule so a linked payment still counts until Xero confirms', () => {
    // The point of recording a BACS payment by hand is that the money shows up
    // immediately. If the view excluded it the moment it was linked, the deal
    // would read £0 paid until Xero reconciled — worse than the double count.
    const src = readFileSync(join(API, '_lib/crm/manualPaymentLink.js'), 'utf8');
    expect(src).toContain('COALESCE(pb.paid_amount, 0) <= 0');
    expect(src).toContain('mp.xero_invoice_id IS NULL OR');
  });
});
