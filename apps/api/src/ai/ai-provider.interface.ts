/**
 * Pluggable AI narration layer. Implementations turn already-computed numbers into
 * natural-language text — they never compute the numbers themselves (that's `stats.ts` in
 * @rms/shared, run by InsightsService/PricingService before an AiProvider ever sees anything).
 * This is the first real instance of the "pluggable adapter + mock for development" pattern the
 * README describes for aggregators/messaging — see `ai.module.ts` for the mock/real selection.
 */

export interface InsightAnomaly {
  kind: 'DISCOUNT_SPIKE' | 'VOID_SPIKE' | 'SALES_DIP' | 'STAFF_OUTLIER' | 'ITEM_TREND';
  date?: string;
  label: string;
  metric: string;
  value: number;
  baseline: number;
  zScore: number;
  detail?: Record<string, unknown>;
}

export interface InsightSummaryInput {
  outletName: string;
  periodLabel: string; // e.g. "today (Mon 14 Sep)", "this week"
  /** paise */
  sales: number;
  billCount: number;
  avgOrderValue: number;
  /** % change vs. the same weekday's baseline, null when there's not enough history yet */
  salesVsBaselinePct: number | null;
  anomalies: InsightAnomaly[];
}

export interface PricingSuggestionInput {
  outletName: string;
  quadrants: { name: string; quadrant: string; velocity: number; marginBps: number | null }[];
  combos: { aName: string; bName: string; count: number }[];
}

export interface PricingSuggestion {
  itemName?: string;
  title: string;
  detail: string;
}

export interface AiProvider {
  /** One paragraph: how the period went, in plain English, referencing the real numbers. */
  generateInsightSummary(input: InsightSummaryInput): Promise<string>;
  /** One short sentence per anomaly explaining what it means for the business. */
  explainAnomalies(anomalies: InsightAnomaly[]): Promise<string[]>;
  /** Phrase a human-readable recommendation for each rule-selected pricing candidate. */
  suggestPricingActions(input: PricingSuggestionInput): Promise<PricingSuggestion[]>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');
