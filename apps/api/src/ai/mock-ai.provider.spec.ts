import { MockAiProvider } from './mock-ai.provider';
import { InsightAnomaly } from './ai-provider.interface';

describe('MockAiProvider', () => {
  const provider = new MockAiProvider();

  it('generateInsightSummary mentions the real numbers and is deterministic', async () => {
    const input = { outletName: 'Demo Cafe Goa', periodLabel: 'on 2026-09-13', sales: 500000, billCount: 42, avgOrderValue: 11904, salesVsBaselinePct: -18, anomalies: [] };
    const a = await provider.generateInsightSummary(input);
    const b = await provider.generateInsightSummary(input);
    expect(a).toBe(b); // deterministic — no randomness, no network
    expect(a).toContain('Demo Cafe Goa');
    expect(a).toContain('42 bills');
    expect(a).toContain('down');
    expect(a).toContain('Nothing unusual flagged');
  });

  it('explainAnomalies returns one templated sentence per anomaly, in order', async () => {
    const anomalies: InsightAnomaly[] = [
      { kind: 'SALES_DIP', date: '2026-09-01', label: 'Sales dip on 2026-09-01', metric: 'sales', value: 20000, baseline: 60000, zScore: -2 },
      { kind: 'DISCOUNT_SPIKE', date: '2026-09-02', label: 'Discount spike on 2026-09-02', metric: 'discountRatePct', value: 40, baseline: 8, zScore: 2.5 },
    ];
    const out = await provider.explainAnomalies(anomalies);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('below the usual level');
    expect(out[1]).toContain('discounting ran well above normal');
  });

  it('suggestPricingActions proposes an action per quadrant candidate plus combo ideas', async () => {
    const out = await provider.suggestPricingActions({
      outletName: 'Demo Cafe Goa',
      quadrants: [
        { name: 'Bebinca', quadrant: 'PUZZLE', velocity: 5, marginBps: 6000 },
        { name: 'Butter Naan', quadrant: 'PLOWHORSE', velocity: 500, marginBps: 1000 },
        { name: 'Old Special', quadrant: 'DOG', velocity: 2, marginBps: 500 },
      ],
      combos: [{ aName: 'Butter Chicken', bName: 'Butter Naan', count: 120 }],
    });
    expect(out.map((s) => s.title)).toEqual(['Promote', 'Reprice', 'Reconsider', 'Combo idea']);
  });
});
