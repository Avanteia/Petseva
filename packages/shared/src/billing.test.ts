import { describe, expect, it } from 'vitest';
import { computeBill, settlement, BillInput } from './billing';
import { allocate, applyBps, formatINR, parseINR, roundOff, splitInclusive } from './money';
import { buildReceipt, escposToText } from './receipt';

const line = (over: Partial<BillInput['lines'][number]> = {}) => ({
  id: 'l1',
  name: 'Paneer Tikka',
  qty: 1,
  unitPrice: 25000, // ₹250
  taxRateBps: 500,
  taxInclusive: false,
  ...over,
});

describe('money', () => {
  it('applies bps with half-up rounding', () => {
    expect(applyBps(10000, 500)).toBe(500);
    expect(applyBps(333, 500)).toBe(17); // 16.65 → 17
    expect(applyBps(1, 500)).toBe(0);
  });
  it('splits inclusive tax so base + tax == gross', () => {
    const s = splitInclusive(10500, 500);
    expect(s).toEqual({ base: 10000, tax: 500 });
    const s2 = splitInclusive(9999, 1800);
    expect(s2.base + s2.tax).toBe(9999);
  });
  it('round off modes', () => {
    expect(roundOff(12345, 'NEAREST_RUPEE')).toBe(-45);
    expect(roundOff(12355, 'NEAREST_RUPEE')).toBe(45);
    expect(roundOff(12350, 'NEAREST_RUPEE')).toBe(50); // half-up
    expect(roundOff(12330, 'NEAREST_50P')).toBe(20);
    expect(roundOff(12301, 'UP_RUPEE')).toBe(99);
    expect(roundOff(12399, 'DOWN_RUPEE')).toBe(-99);
    expect(roundOff(12399, 'NONE')).toBe(0);
  });
  it('allocate sums exactly', () => {
    const parts = allocate(1000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b)).toBe(1000);
    expect(parts).toEqual([334, 333, 333]);
    expect(allocate(0, [3, 4])).toEqual([0, 0]);
    expect(allocate(500, [0, 0])).toEqual([0, 0]);
  });
  it('formats INR with Indian grouping', () => {
    expect(formatINR(123456789)).toBe('₹12,34,567.89');
    expect(formatINR(5)).toBe('₹0.05');
    expect(formatINR(-15000)).toBe('-₹150.00');
    expect(parseINR('₹1,234.50')).toBe(123450);
    expect(parseINR(10)).toBe(1000);
  });
});

describe('computeBill — GST exclusive', () => {
  it('single line 5% GST, no rounding', () => {
    const r = computeBill({ lines: [line()], roundingMode: 'NONE' });
    expect(r.subtotal).toBe(25000);
    expect(r.taxableTotal).toBe(25000);
    expect(r.cgstTotal).toBe(625);
    expect(r.sgstTotal).toBe(625);
    expect(r.grandTotal).toBe(26250);
    expect(r.taxSummary).toEqual([{ rateBps: 500, taxable: 25000, cgst: 625, sgst: 625, tax: 1250 }]);
  });
  it('qty + addons + packaging for takeaway', () => {
    const r = computeBill({
      lines: [line({ qty: 2, addonsPerUnit: 2000, packagingPerUnit: 1000 })],
      roundingMode: 'NONE',
      applyPackaging: true,
    });
    expect(r.subtotal).toBe(2 * (25000 + 2000 + 1000));
    const r2 = computeBill({ lines: [line({ qty: 2, addonsPerUnit: 2000, packagingPerUnit: 1000 })], roundingMode: 'NONE' });
    expect(r2.subtotal).toBe(2 * 27000);
  });
  it('item-level percent discount then tax', () => {
    const r = computeBill({ lines: [line({ discount: { type: 'PERCENT', value: 1000 } })], roundingMode: 'NONE' });
    expect(r.itemDiscountTotal).toBe(2500);
    expect(r.taxableTotal).toBe(22500);
    expect(r.taxTotal).toBe(1126); // CGST 562.5→563 + SGST 563 (each half rounded independently)
    expect(r.grandTotal).toBe(23626);
  });
  it('flat item discount is capped at line gross', () => {
    const r = computeBill({ lines: [line({ discount: { type: 'FLAT', value: 99999 } })], roundingMode: 'NONE' });
    expect(r.itemDiscountTotal).toBe(25000);
    expect(r.grandTotal).toBe(0);
  });
  it('bill-level discount allocated proportionally across mixed slabs', () => {
    const r = computeBill({
      lines: [
        line({ id: 'a', unitPrice: 10000, taxRateBps: 500 }),
        line({ id: 'b', unitPrice: 20000, taxRateBps: 1800 }),
      ],
      billDiscount: { type: 'FLAT', value: 3000 },
      roundingMode: 'NONE',
    });
    expect(r.billDiscountTotal).toBe(3000);
    expect(r.lines[0].billDiscountShare).toBe(1000);
    expect(r.lines[1].billDiscountShare).toBe(2000);
    expect(r.lines[0].taxable).toBe(9000);
    expect(r.lines[1].taxable).toBe(18000);
    expect(r.lines[0].tax).toBe(450);
    expect(r.lines[1].tax).toBe(3240);
    expect(r.taxSummary.map((t) => t.rateBps)).toEqual([500, 1800]);
    expect(r.grandTotal).toBe(27000 + 450 + 3240);
  });
  it('bill percent discount odd split sums exactly', () => {
    const r = computeBill({
      lines: [line({ id: 'a', unitPrice: 333 }), line({ id: 'b', unitPrice: 333 }), line({ id: 'c', unitPrice: 334 })],
      billDiscount: { type: 'PERCENT', value: 1000 },
      roundingMode: 'NONE',
    });
    expect(r.billDiscountTotal).toBe(100);
    expect(r.lines.reduce((a, l) => a + l.billDiscountShare, 0)).toBe(100);
  });
  it('service charge, taxed and untaxed', () => {
    const base = { lines: [line({ unitPrice: 100000 })], roundingMode: 'NONE' as const, serviceChargeBps: 1000 };
    const r = computeBill(base);
    expect(r.serviceCharge).toBe(10000);
    expect(r.serviceChargeTax).toBe(0);
    expect(r.grandTotal).toBe(100000 + 5000 + 10000);
    const r2 = computeBill({ ...base, serviceChargeTaxable: true, serviceChargeTaxRateBps: 1800 });
    expect(r2.serviceChargeTax).toBe(1800);
    expect(r2.taxSummary.find((t) => t.rateBps === 1800)?.tax).toBe(1800);
    expect(r2.grandTotal).toBe(100000 + 5000 + 10000 + 1800);
  });
  it('rounds to nearest rupee and reports round-off', () => {
    const r = computeBill({ lines: [line({ unitPrice: 9990 })], roundingMode: 'NEAREST_RUPEE' });
    // 99.90 + 5% = 104.895 → tax 250+250=500 → 104.90 → round to 105.00
    expect(r.netTotal).toBe(10490);
    expect(r.roundOff).toBe(10);
    expect(r.grandTotal).toBe(10500);
  });
  it('excludes voided lines', () => {
    const r = computeBill({ lines: [line(), line({ id: 'v', voided: true })], roundingMode: 'NONE' });
    expect(r.lines).toHaveLength(1);
    expect(r.subtotal).toBe(25000);
  });
  it('delivery charge is added untaxed', () => {
    const r = computeBill({ lines: [line()], roundingMode: 'NONE', deliveryCharge: 3000 });
    expect(r.grandTotal).toBe(26250 + 3000);
  });
  it('rejects non-integer money and bad qty', () => {
    expect(() => computeBill({ lines: [line({ unitPrice: 10.5 })], roundingMode: 'NONE' })).toThrow();
    expect(() => computeBill({ lines: [line({ qty: 0 })], roundingMode: 'NONE' })).toThrow();
  });
});

describe('computeBill — GST inclusive', () => {
  it('extracts tax so line total equals menu price', () => {
    const r = computeBill({ lines: [line({ unitPrice: 10500, taxInclusive: true })], roundingMode: 'NONE' });
    expect(r.lines[0].taxable).toBe(10000);
    expect(r.lines[0].tax).toBe(500);
    expect(r.lines[0].total).toBe(10500);
    expect(r.grandTotal).toBe(10500);
  });
  it('inclusive with awkward numbers still reconciles', () => {
    const r = computeBill({ lines: [line({ unitPrice: 9999, qty: 3, taxInclusive: true, taxRateBps: 1800 })], roundingMode: 'NONE' });
    const l = r.lines[0];
    expect(l.taxable + l.cgst + l.sgst).toBe(29997);
    expect(r.grandTotal).toBe(29997);
  });
  it('inclusive + bill discount reduces gross before extracting tax', () => {
    const r = computeBill({
      lines: [line({ unitPrice: 10500, taxInclusive: true })],
      billDiscount: { type: 'PERCENT', value: 1000 },
      roundingMode: 'NONE',
    });
    expect(r.billDiscountTotal).toBe(1050);
    expect(r.grandTotal).toBe(9450);
    expect(r.lines[0].taxable).toBe(9000);
  });
});

describe('settlement', () => {
  it('computes due and change', () => {
    expect(settlement(10000, [{ amount: 4000 }])).toEqual({ paid: 4000, due: 6000, change: 0 });
    expect(settlement(10000, [{ amount: 4000 }, { amount: 7000 }])).toEqual({ paid: 11000, due: 0, change: 1000 });
  });
});

describe('receipt', () => {
  it('renders a readable plain-text receipt', () => {
    const bill = computeBill({ lines: [line({ qty: 2 })], roundingMode: 'NEAREST_RUPEE' });
    const txt = escposToText(
      buildReceipt({
        outlet: { name: 'Demo Cafe', addressLines: ['Panaji, Goa'], gstin: '30ABCDE1234F1Z5' },
        billNumber: 'INV-1',
        orderNumber: 'O-1',
        orderType: 'DINE_IN',
        tableName: 'T1',
        cashier: 'Asha',
        createdAt: new Date('2026-01-01T10:00:00Z'),
        bill,
        lineMeta: [],
        payments: [{ mode: 'CASH', amount: 52500 }],
      }).build(),
    );
    expect(txt).toContain('Demo Cafe');
    expect(txt).toContain('TAX INVOICE');
    expect(txt).toContain('Paneer Tikka');
    expect(txt).toContain('525.00');
    expect(txt).toContain('CGST @2.5%');
  });
});
