import { describe, it, expect } from 'vitest';
import { detectPoNumber } from '../src/utils/poDetect.js';

// The PO number pulled out of an uploaded purchase order prefills the "Upload PO"
// modal. It's only ever a prefill (the user confirms it), so a miss is cheap — but
// a confident wrong answer isn't: these lock in that we never mistake a date, a
// total, or an invoice number for a PO number.

describe('detectPoNumber', () => {
  it('reads a labelled PO number', () => {
    expect(detectPoNumber('PURCHASE ORDER\nPO Number: 4500123456\nDate: 13/07/2026')).toBe('4500123456');
    expect(detectPoNumber('Purchase Order No. PO-2026-0088  Supplier: Squideo Ltd')).toBe('PO-2026-0088');
    expect(detectPoNumber('P.O. # 88123  Delivery to site')).toBe('88123');
    expect(detectPoNumber('Purchase Order Number 4500111222')).toBe('4500111222');
  });

  it('falls back to an order-number label and to a bare SAP-style number', () => {
    expect(detectPoNumber('Order Number: ABC/1234/26  Total £7,350.00')).toBe('ABC/1234/26');
    expect(detectPoNumber('Our reference 4500987654 relates to the animation work')).toBe('4500987654');
  });

  it('returns null rather than guessing', () => {
    expect(detectPoNumber('Invoice INV-6115 dated 10/07/2026 — no purchase order here')).toBeNull();
    expect(detectPoNumber('Squideo 2026-064 quotation')).toBeNull();
    expect(detectPoNumber('')).toBeNull();
  });

  it('never mistakes a date or a stray label word for the number', () => {
    expect(detectPoNumber('Purchase order date: 01/02/2026 Total: £6,125.00')).toBeNull();
    expect(detectPoNumber('PO Number: Number')).toBeNull();
  });
});
