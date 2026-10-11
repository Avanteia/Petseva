import { projectReorder } from './forecasting.service';

const material = (over: Partial<Parameters<typeof projectReorder>[0]> = {}) => ({
  id: 'chicken',
  name: 'Chicken',
  unit: 'KG',
  currentStock: 100,
  reorderLevel: 20,
  reorderQty: 50,
  avgCostPrice: 25000,
  preferredVendorId: 'vendor-1',
  ...over,
});

const flatForecast = (qtyPerDay: number, days: number) => Array.from({ length: days }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, value: qtyPerDay }));

describe('projectReorder', () => {
  it('returns null when stock comfortably covers the whole forecast window', () => {
    expect(projectReorder(material({ currentStock: 200, reorderLevel: 20 }), flatForecast(5, 14), 30)).toBeNull();
  });

  it('flags a projected breach date when the forecast will run stock below reorderLevel', () => {
    // 100 in stock, 20 reorder level, consuming 10/day -> breaches on day 9 (100 - 9*10 = 10 <= 20... actually day 8: 100-80=20)
    const out = projectReorder(material({ currentStock: 100, reorderLevel: 20 }), flatForecast(10, 14), 30);
    expect(out).not.toBeNull();
    expect(out!.projectedBreachDate).toBe('2026-09-08');
    expect(out!.suggestedQty).toBeGreaterThanOrEqual(material().reorderQty);
  });

  it('flags immediately when currentStock is already at/below reorderLevel, even with no forecast data', () => {
    const out = projectReorder(material({ currentStock: 10, reorderLevel: 20 }), [], 0);
    expect(out).not.toBeNull();
    expect(out!.projectedBreachDate).toBeNull();
    expect(out!.suggestedQty).toBeGreaterThanOrEqual(1);
  });

  it('suggestedQty covers the forecast deficit when it exceeds the outlet reorderQty', () => {
    const out = projectReorder(material({ currentStock: 50, reorderLevel: 20, reorderQty: 10 }), flatForecast(20, 14), 30);
    // total demand = 280, currentStock=50, reorderLevel=20 -> coverage = 280-50+20 = 250, well above reorderQty=10
    expect(out!.suggestedQty).toBe(250);
  });
});
