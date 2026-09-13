import { detectRateSpikes, detectSalesDips, RateRow } from './insights.service';

describe('detectRateSpikes', () => {
  const rows = (rates: number[]): RateRow[] => rates.map((rate, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, total: 50, flagged: Math.round((rate / 100) * 50), rate }));

  it('flags a discount-rate day that is well above the rest', () => {
    const out = detectRateSpikes(rows([8, 9, 7, 8, 40, 8, 9]), 'DISCOUNT_SPIKE', 1.3);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'DISCOUNT_SPIKE', date: '2026-01-05', value: 40 });
    expect(out[0].zScore).toBeGreaterThan(1.3);
  });

  it('does not flag anything for a flat series', () => {
    expect(detectRateSpikes(rows([8, 8, 8, 8, 8]), 'DISCOUNT_SPIKE')).toEqual([]);
  });

  it('ignores dips (only spikes are reported for these kinds)', () => {
    // one day far below the rest is a negative z-score — not what DISCOUNT_SPIKE/VOID_SPIKE cares about.
    expect(detectRateSpikes(rows([8, 9, 7, 8, 0, 8, 9]), 'VOID_SPIKE', 1.0)).toEqual([]);
  });
});

describe('detectSalesDips', () => {
  it('flags a day well below its own weekday baseline', () => {
    // Two weeks of Mondays at 1000, one Monday crashing to 200.
    const series = [
      { date: '2026-01-05', value: 1000 }, // Mon
      { date: '2026-01-12', value: 1000 }, // Mon
      { date: '2026-01-19', value: 200 }, // Mon — the dip
      { date: '2026-01-26', value: 1000 }, // Mon
    ];
    const out = detectSalesDips(series);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'SALES_DIP', date: '2026-01-19', value: 200 });
  });

  it('reports nothing when every day matches its weekday baseline', () => {
    const series = [
      { date: '2026-01-05', value: 1000 },
      { date: '2026-01-06', value: 1000 },
      { date: '2026-01-12', value: 1000 },
      { date: '2026-01-13', value: 1000 },
    ];
    expect(detectSalesDips(series)).toEqual([]);
  });
});
