/**
 * Billing engine — pure, deterministic, side-effect free.
 * Used identically by the server (authoritative) and the offline POS (provisional).
 *
 * Pipeline per bill:
 *   1. gross line = (unitPrice + addons per unit) * qty  (+ packaging per unit * qty when applicable)
 *   2. item-level discount (percent or flat) → line net
 *   3. bill-level discount (percent of Σnet, or flat) allocated across lines by net (largest remainder)
 *   4. tax per line on (net − allocated bill discount); inclusive prices have tax extracted, exclusive add tax
 *   5. service charge on Σ taxable (optionally taxed at its own rate)
 *   6. round-off per outlet rule → grand total
 */
import { allocate, applyBps, assertInt, roundOff, RoundingMode, splitInclusive, Paise } from './money';

export type DiscountType = 'PERCENT' | 'FLAT';

export interface DiscountSpec {
  type: DiscountType;
  /** PERCENT → basis points (1000 = 10%); FLAT → paise */
  value: number;
  reason?: string;
  code?: string;
}

export interface BillLineInput {
  id: string;
  name: string;
  qty: number;
  /** price per unit for chosen variation, in paise */
  unitPrice: Paise;
  /** sum of addon prices per unit, in paise */
  addonsPerUnit?: Paise;
  /** packaging charge per unit (applied when applyPackaging = true) */
  packagingPerUnit?: Paise;
  /** GST rate in bps for this item's slab */
  taxRateBps: number;
  taxInclusive: boolean;
  discount?: DiscountSpec;
  /** voided / cancelled lines are excluded from totals */
  voided?: boolean;
}

export interface BillInput {
  lines: BillLineInput[];
  billDiscount?: DiscountSpec;
  /** bps of taxable subtotal */
  serviceChargeBps?: number;
  serviceChargeTaxable?: boolean;
  serviceChargeTaxRateBps?: number;
  roundingMode: RoundingMode;
  applyPackaging?: boolean;
  /** Extra flat charges e.g. delivery charge (paise, untaxed) */
  deliveryCharge?: Paise;
}

export interface BillLineResult {
  id: string;
  name: string;
  qty: number;
  gross: Paise;
  itemDiscount: Paise;
  billDiscountShare: Paise;
  /** amount on which tax is computed (excl. tax) */
  taxable: Paise;
  taxRateBps: number;
  cgst: Paise;
  sgst: Paise;
  tax: Paise;
  /** taxable + tax */
  total: Paise;
}

export interface TaxSummaryRow {
  rateBps: number;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  tax: Paise;
}

export interface BillResult {
  lines: BillLineResult[];
  /** Σ gross before any discount (as displayed on menu) */
  subtotal: Paise;
  itemDiscountTotal: Paise;
  billDiscountTotal: Paise;
  discountTotal: Paise;
  /** Σ line taxable */
  taxableTotal: Paise;
  serviceCharge: Paise;
  serviceChargeTax: Paise;
  deliveryCharge: Paise;
  cgstTotal: Paise;
  sgstTotal: Paise;
  taxTotal: Paise;
  taxSummary: TaxSummaryRow[];
  /** before rounding */
  netTotal: Paise;
  roundOff: Paise;
  grandTotal: Paise;
}

export function discountAmount(base: Paise, d?: DiscountSpec): Paise {
  if (!d) return 0;
  const amt = d.type === 'PERCENT' ? applyBps(base, d.value) : d.value;
  return Math.max(0, Math.min(base, amt));
}

function splitGst(taxable: Paise, rateBps: number, inclusiveGross?: Paise): { cgst: Paise; sgst: Paise } {
  // Each half rounded independently (matches GST invoice convention).
  const half = rateBps / 2;
  const cgst = applyBps(taxable, half);
  const sgst = applyBps(taxable, half);
  if (inclusiveGross !== undefined) {
    // ensure cgst+sgst+taxable == gross for inclusive pricing
    const diff = inclusiveGross - (taxable + cgst + sgst);
    return { cgst: cgst + diff, sgst };
  }
  return { cgst, sgst };
}

export function computeBill(input: BillInput): BillResult {
  const active = input.lines.filter((l) => !l.voided);
  for (const l of active) {
    assertInt(l.unitPrice, `unitPrice(${l.id})`);
    if (!Number.isInteger(l.qty) || l.qty <= 0) throw new Error(`qty must be a positive integer (${l.id})`);
  }

  // Step 1-2: gross & item discount
  const gross = active.map((l) => {
    const perUnit =
      l.unitPrice + (l.addonsPerUnit ?? 0) + (input.applyPackaging ? l.packagingPerUnit ?? 0 : 0);
    return perUnit * l.qty;
  });
  const itemDisc = active.map((l, i) => discountAmount(gross[i], l.discount));
  const net = active.map((_, i) => gross[i] - itemDisc[i]);
  const netSum = net.reduce((a, b) => a + b, 0);

  // Step 3: bill discount
  const billDiscTotal = discountAmount(netSum, input.billDiscount);
  const billDisc = allocate(billDiscTotal, net);

  // Step 4: taxes
  const lines: BillLineResult[] = active.map((l, i) => {
    const afterDisc = net[i] - billDisc[i];
    let taxable: Paise;
    let cgst: Paise;
    let sgst: Paise;
    if (l.taxInclusive) {
      const s = splitInclusive(afterDisc, l.taxRateBps);
      taxable = s.base;
      ({ cgst, sgst } = splitGst(taxable, l.taxRateBps, afterDisc));
    } else {
      taxable = afterDisc;
      ({ cgst, sgst } = splitGst(taxable, l.taxRateBps));
    }
    const tax = cgst + sgst;
    return {
      id: l.id,
      name: l.name,
      qty: l.qty,
      gross: gross[i],
      itemDiscount: itemDisc[i],
      billDiscountShare: billDisc[i],
      taxable,
      taxRateBps: l.taxRateBps,
      cgst,
      sgst,
      tax,
      total: taxable + tax,
    };
  });

  const subtotal = gross.reduce((a, b) => a + b, 0);
  const itemDiscountTotal = itemDisc.reduce((a, b) => a + b, 0);
  const taxableTotal = lines.reduce((a, l) => a + l.taxable, 0);

  // Step 5: service charge
  const serviceCharge = applyBps(taxableTotal, input.serviceChargeBps ?? 0);
  const serviceChargeTax =
    input.serviceChargeTaxable && serviceCharge > 0
      ? applyBps(serviceCharge, input.serviceChargeTaxRateBps ?? 1800)
      : 0;

  // Tax summary by slab
  const byRate = new Map<number, TaxSummaryRow>();
  for (const l of lines) {
    const row = byRate.get(l.taxRateBps) ?? { rateBps: l.taxRateBps, taxable: 0, cgst: 0, sgst: 0, tax: 0 };
    row.taxable += l.taxable;
    row.cgst += l.cgst;
    row.sgst += l.sgst;
    row.tax += l.tax;
    byRate.set(l.taxRateBps, row);
  }
  if (serviceChargeTax > 0) {
    const rate = input.serviceChargeTaxRateBps ?? 1800;
    const row = byRate.get(rate) ?? { rateBps: rate, taxable: 0, cgst: 0, sgst: 0, tax: 0 };
    const cg = applyBps(serviceCharge, rate / 2);
    row.taxable += serviceCharge;
    row.cgst += cg;
    row.sgst += serviceChargeTax - cg;
    row.tax += serviceChargeTax;
    byRate.set(rate, row);
  }
  const taxSummary = [...byRate.values()].sort((a, b) => a.rateBps - b.rateBps);
  const cgstTotal = taxSummary.reduce((a, r) => a + r.cgst, 0);
  const sgstTotal = taxSummary.reduce((a, r) => a + r.sgst, 0);
  const taxTotal = cgstTotal + sgstTotal;

  const deliveryCharge = input.deliveryCharge ?? 0;
  const netTotal = taxableTotal + serviceCharge + taxTotal + deliveryCharge;
  const ro = roundOff(netTotal, input.roundingMode);

  return {
    lines,
    subtotal,
    itemDiscountTotal,
    billDiscountTotal: billDiscTotal,
    discountTotal: itemDiscountTotal + billDiscTotal,
    taxableTotal,
    serviceCharge,
    serviceChargeTax,
    deliveryCharge,
    cgstTotal,
    sgstTotal,
    taxTotal,
    taxSummary,
    netTotal,
    roundOff: ro,
    grandTotal: netTotal + ro,
  };
}

/** Sum of payments vs. grand total → what is still due (never negative) and change (never negative). */
export function settlement(grandTotal: Paise, payments: { amount: Paise }[]): { paid: Paise; due: Paise; change: Paise } {
  const paid = payments.reduce((a, p) => a + p.amount, 0);
  return { paid, due: Math.max(0, grandTotal - paid), change: Math.max(0, paid - grandTotal) };
}
