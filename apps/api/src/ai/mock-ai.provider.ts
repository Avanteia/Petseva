import { Injectable } from '@nestjs/common';
import { formatINR } from '@rms/shared';
import { AiProvider, InsightAnomaly, InsightSummaryInput, PricingSuggestion, PricingSuggestionInput } from './ai-provider.interface';

const ANOMALY_TEMPLATES: Record<InsightAnomaly['kind'], (a: InsightAnomaly) => string> = {
  DISCOUNT_SPIKE: (a) => `${a.label}: discounting ran well above normal (${a.value.toFixed(0)}% of orders vs. a usual ${a.baseline.toFixed(0)}%) — worth a quick check on who authorized these.`,
  VOID_SPIKE: (a) => `${a.label}: void/cancel rate was unusually high (${a.value.toFixed(0)}% vs. a usual ${a.baseline.toFixed(0)}%).`,
  SALES_DIP: (a) => `${a.label}: sales were well below the usual level for that day of the week (${formatINR(a.value)} vs. an expected ${formatINR(a.baseline)}).`,
  STAFF_OUTLIER: (a) => `${a.label}: void/discount rate is well outside the outlet average — may be worth a quick conversation, or it may just reflect a busier shift.`,
  ITEM_TREND: (a) => `${a.label}: sales have been trending steadily ${a.value >= a.baseline ? 'up' : 'down'} over the last two weeks.`,
};

/** Deterministic, offline, zero-network narration — the always-available default (AI_PROVIDER=mock). */
@Injectable()
export class MockAiProvider implements AiProvider {
  async generateInsightSummary(input: InsightSummaryInput): Promise<string> {
    const parts: string[] = [];
    parts.push(`${input.outletName} — ${input.periodLabel}: ${formatINR(input.sales)} across ${input.billCount} bill${input.billCount === 1 ? '' : 's'} (avg ${formatINR(input.avgOrderValue)}).`);
    if (input.salesVsBaselinePct !== null) {
      const dir = input.salesVsBaselinePct >= 0 ? 'up' : 'down';
      parts.push(`That's ${Math.abs(input.salesVsBaselinePct).toFixed(0)}% ${dir} versus the usual level for this day of the week.`);
    }
    parts.push(input.anomalies.length ? `${input.anomalies.length} item${input.anomalies.length === 1 ? '' : 's'} flagged below.` : 'Nothing unusual flagged for this period.');
    return parts.join(' ');
  }

  async explainAnomalies(anomalies: InsightAnomaly[]): Promise<string[]> {
    return anomalies.map((a) => ANOMALY_TEMPLATES[a.kind](a));
  }

  async suggestPricingActions(input: PricingSuggestionInput): Promise<PricingSuggestion[]> {
    const out: PricingSuggestion[] = [];
    for (const q of input.quadrants) {
      if (q.quadrant === 'PUZZLE') out.push({ itemName: q.name, title: 'Promote', detail: `${q.name} has a strong margin but low sales — feature it on the menu, or bundle it with a popular item to raise visibility.` });
      if (q.quadrant === 'PLOWHORSE') out.push({ itemName: q.name, title: 'Reprice', detail: `${q.name} sells fast but on thin margin — a small price increase would likely go unnoticed given the volume.` });
      if (q.quadrant === 'DOG') out.push({ itemName: q.name, title: 'Reconsider', detail: `${q.name} has both low sales and low margin — consider dropping it or reworking the recipe cost.` });
    }
    for (const c of input.combos.slice(0, 5)) {
      out.push({ title: 'Combo idea', detail: `${c.aName} and ${c.bName} are ordered together often (${c.count} times) — consider a combo price for the pair.` });
    }
    return out;
  }
}
