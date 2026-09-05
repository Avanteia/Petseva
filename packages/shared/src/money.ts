/**
 * Money helpers. ALL amounts are integers in minor units (paise).
 * Percentages are expressed in basis points (bps): 10% = 1000, 5% = 500, 2.5% = 250.
 */

export type Paise = number;
export const BPS_DENOM = 10_000;

export function assertInt(n: number, label = 'amount'): void {
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer (got ${n})`);
}

/** Round half away from zero to integer (bankers rounding is NOT used for invoices). */
export function roundHalfUp(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/** amount * bps / 10000, rounded half-up. */
export function applyBps(amount: Paise, bps: number): Paise {
  assertInt(amount);
  return roundHalfUp((amount * bps) / BPS_DENOM);
}

/** Extract the tax portion from a tax-INCLUSIVE amount at a given rate. Returns { base, tax }. */
export function splitInclusive(gross: Paise, rateBps: number): { base: Paise; tax: Paise } {
  assertInt(gross);
  const base = roundHalfUp((gross * BPS_DENOM) / (BPS_DENOM + rateBps));
  return { base, tax: gross - base };
}

export type RoundingMode = 'NONE' | 'NEAREST_RUPEE' | 'NEAREST_50P' | 'UP_RUPEE' | 'DOWN_RUPEE';

/** Returns the round-off delta (can be negative) so that total + delta is the rounded amount. */
export function roundOff(total: Paise, mode: RoundingMode): Paise {
  assertInt(total);
  switch (mode) {
    case 'NONE':
      return 0;
    case 'NEAREST_RUPEE':
      return roundHalfUp(total / 100) * 100 - total;
    case 'NEAREST_50P':
      return roundHalfUp(total / 50) * 50 - total;
    case 'UP_RUPEE':
      return Math.ceil(total / 100) * 100 - total;
    case 'DOWN_RUPEE':
      return Math.floor(total / 100) * 100 - total;
  }
}

/**
 * Allocate `total` across `weights` proportionally using the largest-remainder method,
 * so the parts always sum exactly to `total`.
 */
export function allocate(total: Paise, weights: number[]): Paise[] {
  assertInt(total);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || weights.length === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) floors[order[k].i] += 1;
  return floors;
}

export function formatINR(paise: Paise, opts: { symbol?: boolean } = {}): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  // Indian digit grouping: 12,34,567
  const s = rupees.toString();
  let grouped = s;
  if (s.length > 3) {
    const last3 = s.slice(-3);
    let rest = s.slice(0, -3);
    const parts: string[] = [];
    while (rest.length > 2) {
      parts.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    if (rest) parts.unshift(rest);
    grouped = parts.join(',') + ',' + last3;
  }
  return `${sign}${opts.symbol === false ? '' : '₹'}${grouped}.${p.toString().padStart(2, '0')}`;
}

/** Parse a user-entered rupee string ("123.45") into paise. */
export function parseINR(input: string | number): Paise {
  if (typeof input === 'number') return roundHalfUp(input * 100);
  const cleaned = input.replace(/[^\d.-]/g, '');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  if (Number.isNaN(n)) throw new Error(`Invalid amount: ${input}`);
  return roundHalfUp(n * 100);
}
