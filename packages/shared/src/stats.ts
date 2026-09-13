/**
 * Deterministic statistics — moving averages, seasonality baselines, outlier detection.
 * Pure, framework-free, zero DB/Nest dependency (same rationale as money.ts/billing.ts living
 * here): this is the actual "intelligence" behind AI insights/anomaly-detection/forecasting.
 * An AiProvider only turns these already-computed numbers into natural-language phrasing —
 * it never computes them.
 */

/** Simple trailing moving average over the last `window` points (fewer at the start of the series). */
export function movingAverage(series: number[], window: number): number[] {
  if (window <= 0) throw new Error('window must be positive');
  return series.map((_, i) => {
    const from = Math.max(0, i - window + 1);
    const slice = series.slice(from, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

/** Population mean and standard deviation. */
export function meanStdDev(series: number[]): { mean: number; stdDev: number } {
  if (!series.length) return { mean: 0, stdDev: 0 };
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

/** z-score of each point relative to the series' own mean/stdDev (0 if stdDev is 0). */
export function zScores(series: number[]): number[] {
  const { mean, stdDev } = meanStdDev(series);
  if (stdDev === 0) return series.map(() => 0);
  return series.map((v) => (v - mean) / stdDev);
}

export interface Outlier {
  index: number;
  value: number;
  zScore: number;
}

/** Points whose |z-score| exceeds `threshold` (default 2 — ~top/bottom 2.5% for a normal series). */
export function zScoreOutliers(series: number[], threshold = 2): Outlier[] {
  const z = zScores(series);
  return series.map((value, index) => ({ index, value, zScore: z[index] })).filter((o) => Math.abs(o.zScore) > threshold);
}

/** Points outside [Q1 - k*IQR, Q3 + k*IQR] — more robust than z-score to a few extreme values. */
export function iqrOutliers(series: number[], k = 1.5): Outlier[] {
  if (series.length < 4) return [];
  const sorted = [...series].sort((a, b) => a - b);
  const quartile = (p: number) => {
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  const q1 = quartile(0.25);
  const q3 = quartile(0.75);
  const iqr = q3 - q1;
  const lo = q1 - k * iqr;
  const hi = q3 + k * iqr;
  const z = zScores(series);
  return series.map((value, index) => ({ index, value, zScore: z[index] })).filter((o) => o.value < lo || o.value > hi);
}

export interface DatedPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

/** Average value per weekday (0=Sunday..6=Saturday), parsed from each point's date. */
export function dayOfWeekBaseline(points: DatedPoint[]): Record<number, number> {
  const buckets: number[][] = [[], [], [], [], [], [], []];
  for (const p of points) {
    const dow = new Date(`${p.date}T00:00:00Z`).getUTCDay();
    buckets[dow].push(p.value);
  }
  const out: Record<number, number> = {};
  for (let d = 0; d < 7; d++) out[d] = buckets[d].length ? buckets[d].reduce((a, b) => a + b, 0) / buckets[d].length : 0;
  return out;
}

/**
 * Deviation of each point from its own weekday's baseline (in units of the series' overall
 * stdDev) — flags "unusually low/high for a {weekday}", not just "unusually low overall",
 * which is what tells apart a normal quiet Monday from a genuinely bad Saturday.
 */
export function baselineDeviations(points: DatedPoint[]): (Outlier & { date: string; baseline: number })[] {
  const baseline = dayOfWeekBaseline(points);
  const { stdDev } = meanStdDev(points.map((p) => p.value));
  return points.map((p, index) => {
    const dow = new Date(`${p.date}T00:00:00Z`).getUTCDay();
    const b = baseline[dow];
    const zScore = stdDev === 0 ? 0 : (p.value - b) / stdDev;
    return { index, value: p.value, date: p.date, baseline: b, zScore };
  });
}

/** Exponential smoothing (Holt's linear, no seasonality): returns one smoothed value per input point. */
export function exponentialSmoothing(series: number[], alpha = 0.3): number[] {
  if (!series.length) return [];
  const out = [series[0]];
  for (let i = 1; i < series.length; i++) out.push(alpha * series[i] + (1 - alpha) * out[i - 1]);
  return out;
}

/**
 * Forecast the next `days` values from a dated daily series, blending a smoothed trend level
 * with a per-weekday seasonal multiplier (Holt-Winters-lite — enough to say "Saturdays run
 * ~40% above the trend line" without a full seasonal-decomposition library).
 */
export function forecastNextN(history: DatedPoint[], days: number, alpha = 0.3): DatedPoint[] {
  if (!history.length) return [];
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const values = sorted.map((p) => p.value);
  const level = exponentialSmoothing(values, alpha).at(-1)!;
  const overallMean = meanStdDev(values).mean || 1;
  const baseline = dayOfWeekBaseline(sorted);
  const lastDate = new Date(`${sorted.at(-1)!.date}T00:00:00Z`);
  const out: DatedPoint[] = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(lastDate);
    d.setUTCDate(d.getUTCDate() + i);
    const dow = d.getUTCDay();
    const seasonalMultiplier = overallMean > 0 ? baseline[dow] / overallMean : 1;
    out.push({ date: d.toISOString().slice(0, 10), value: Math.max(0, level * (seasonalMultiplier || 1)) });
  }
  return out;
}

export type MenuEngineeringQuadrant = 'STAR' | 'PLOWHORSE' | 'PUZZLE' | 'DOG';

export interface MenuEngineeringInput {
  id: string;
  name: string;
  velocity: number; // units sold in the period
  marginBps: number | null; // (price - cost) / price in bps; null when cost is unknown
}

export interface MenuEngineeringResult extends MenuEngineeringInput {
  quadrant: MenuEngineeringQuadrant | 'UNKNOWN_MARGIN';
}

/**
 * Classic 2x2 menu-engineering matrix: high/low velocity crossed with high/low margin, each
 * split at the SET's own median (so "high" is relative to this menu, not an absolute threshold).
 * Items with unknown cost price can't be margin-classified — flagged rather than guessed at.
 */
export function classifyMenuEngineering(items: MenuEngineeringInput[]): MenuEngineeringResult[] {
  const known = items.filter((i) => i.marginBps !== null);
  const medianOf = (nums: number[]) => {
    if (!nums.length) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const velocityMedian = medianOf(items.map((i) => i.velocity));
  const marginMedian = medianOf(known.map((i) => i.marginBps as number));
  return items.map((i) => {
    if (i.marginBps === null) return { ...i, quadrant: 'UNKNOWN_MARGIN' as const };
    const highVelocity = i.velocity >= velocityMedian;
    const highMargin = i.marginBps >= marginMedian;
    const quadrant: MenuEngineeringQuadrant = highVelocity && highMargin ? 'STAR' : highVelocity && !highMargin ? 'PLOWHORSE' : !highVelocity && highMargin ? 'PUZZLE' : 'DOG';
    return { ...i, quadrant };
  });
}

export interface CooccurringPair {
  a: string;
  b: string;
  count: number;
  /** count / min(support(a), support(b)) — how often the rarer item drags the other along */
  lift: number;
}

/** Frequently co-purchased item-id pairs across a set of order "baskets" — combo/upsell candidates. */
export function topCooccurringPairs(baskets: string[][], minSupport = 3, limit = 10): CooccurringPair[] {
  const support = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  for (const basket of baskets) {
    const unique = [...new Set(basket)];
    for (const id of unique) support.set(id, (support.get(id) ?? 0) + 1);
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const [a, b] = unique[i] < unique[j] ? [unique[i], unique[j]] : [unique[j], unique[i]];
        const key = `${a} ${b}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const pairs: CooccurringPair[] = [];
  for (const [key, count] of pairCounts) {
    if (count < minSupport) continue;
    const [a, b] = key.split(' ');
    const minSingle = Math.min(support.get(a) ?? 1, support.get(b) ?? 1);
    pairs.push({ a, b, count, lift: count / minSingle });
  }
  return pairs.sort((x, y) => y.count - x.count).slice(0, limit);
}
