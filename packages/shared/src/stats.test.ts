import { describe, expect, it } from 'vitest';
import {
  baselineDeviations,
  classifyMenuEngineering,
  dayOfWeekBaseline,
  exponentialSmoothing,
  forecastNextN,
  iqrOutliers,
  meanStdDev,
  movingAverage,
  topCooccurringPairs,
  zScoreOutliers,
  zScores,
} from './stats';

describe('movingAverage', () => {
  it('averages the trailing window, padding at the start', () => {
    expect(movingAverage([1, 2, 3, 4, 5], 3)).toEqual([1, 1.5, 2, 3, 4]);
  });
});

describe('meanStdDev / zScores', () => {
  it('computes mean and population stdDev', () => {
    expect(meanStdDev([2, 4, 4, 4, 5, 5, 7, 9])).toEqual({ mean: 5, stdDev: 2 });
  });
  it('returns all zeros for a flat series', () => {
    expect(zScores([5, 5, 5])).toEqual([0, 0, 0]);
  });
});

describe('outlier detection', () => {
  it('zScoreOutliers flags a single spike in an otherwise flat series', () => {
    const series = [10, 11, 9, 10, 10, 60, 10, 9, 11];
    const out = zScoreOutliers(series, 2);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ index: 5, value: 60 });
  });
  it('iqrOutliers flags the same spike robustly', () => {
    const series = [10, 11, 9, 10, 10, 60, 10, 9, 11];
    const out = iqrOutliers(series);
    expect(out.map((o) => o.index)).toContain(5);
  });
  it('iqrOutliers needs at least 4 points', () => {
    expect(iqrOutliers([1, 2, 3])).toEqual([]);
  });
});

describe('dayOfWeekBaseline / baselineDeviations', () => {
  // 2026-09-14 is a Monday (dow=1); build two weeks so Sat/Sun differ from weekdays.
  const points = [
    { date: '2026-09-07', value: 100 }, // Mon
    { date: '2026-09-08', value: 100 }, // Tue
    { date: '2026-09-12', value: 200 }, // Sat
    { date: '2026-09-13', value: 200 }, // Sun
    { date: '2026-09-14', value: 100 }, // Mon
    { date: '2026-09-19', value: 20 }, // Sat — anomalously low for a Saturday
  ];
  it('averages by weekday', () => {
    const b = dayOfWeekBaseline(points);
    expect(b[1]).toBe(100); // Monday baseline
    expect(b[6]).toBeCloseTo((200 + 20) / 2); // Saturday baseline across both Saturdays
  });
  it('flags a weekday-relative dip that a plain overall-mean check would miss', () => {
    const devs = baselineDeviations(points);
    const badSaturday = devs.find((d) => d.date === '2026-09-19')!;
    expect(badSaturday.zScore).toBeLessThan(-1);
  });
});

describe('exponentialSmoothing', () => {
  it('starts at the first value and tracks a flat series exactly', () => {
    expect(exponentialSmoothing([5, 5, 5, 5], 0.5)).toEqual([5, 5, 5, 5]);
  });
  it('lags behind a step change proportional to alpha', () => {
    const smoothed = exponentialSmoothing([0, 0, 10, 10, 10], 0.5);
    expect(smoothed[2]).toBe(5); // half-way to the step immediately after it
    expect(smoothed.at(-1)!).toBeGreaterThan(8.5);
  });
});

describe('forecastNextN', () => {
  it('projects forward the right number of days, in date order', () => {
    const history = Array.from({ length: 28 }, (_, i) => {
      const d = new Date('2026-08-01T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      return { date: d.toISOString().slice(0, 10), value: 100 };
    });
    const forecast = forecastNextN(history, 7);
    expect(forecast).toHaveLength(7);
    expect(forecast[0].date).toBe('2026-08-29');
    expect(forecast[6].date).toBe('2026-09-04');
    for (const p of forecast) expect(p.value).toBeCloseTo(100, 0);
  });
  it('returns [] for empty history', () => {
    expect(forecastNextN([], 7)).toEqual([]);
  });
});

describe('classifyMenuEngineering', () => {
  it('splits into the four quadrants around the set median', () => {
    const items = [
      { id: 'a', name: 'Star', velocity: 100, marginBps: 5000 },
      { id: 'b', name: 'Plowhorse', velocity: 90, marginBps: 1000 },
      { id: 'c', name: 'Puzzle', velocity: 10, marginBps: 4000 },
      { id: 'd', name: 'Dog', velocity: 5, marginBps: 900 },
    ];
    const out = classifyMenuEngineering(items);
    expect(out.find((i) => i.id === 'a')!.quadrant).toBe('STAR');
    expect(out.find((i) => i.id === 'b')!.quadrant).toBe('PLOWHORSE');
    expect(out.find((i) => i.id === 'c')!.quadrant).toBe('PUZZLE');
    expect(out.find((i) => i.id === 'd')!.quadrant).toBe('DOG');
  });
  it('flags items with unknown margin instead of guessing', () => {
    const out = classifyMenuEngineering([{ id: 'a', name: 'No cost set', velocity: 50, marginBps: null }]);
    expect(out[0].quadrant).toBe('UNKNOWN_MARGIN');
  });
});

describe('topCooccurringPairs', () => {
  it('finds a pair that always appears together above minSupport', () => {
    const baskets = [
      ['naan', 'butterchicken'],
      ['naan', 'butterchicken'],
      ['naan', 'butterchicken'],
      ['rice', 'daal'],
      ['naan'],
    ];
    const pairs = topCooccurringPairs(baskets, 3);
    expect(pairs[0]).toMatchObject({ a: 'butterchicken', b: 'naan', count: 3 });
  });
  it('drops pairs below minSupport', () => {
    expect(topCooccurringPairs([['a', 'b']], 3)).toEqual([]);
  });
});
