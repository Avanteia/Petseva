import { computeDeductions, RecipeMap } from './inventory.service';

describe('computeDeductions', () => {
  const recipeMap: RecipeMap = new Map([
    ['butter-chicken', [{ rawMaterialId: 'chicken', qtyPerUnit: 200 }, { rawMaterialId: 'butter', qtyPerUnit: 30 }]],
    ['naan', [{ rawMaterialId: 'flour', qtyPerUnit: 80 }]],
  ]);

  it('aggregates deductions across multiple sold lines of the same item', () => {
    const out = computeDeductions(
      [
        { itemId: 'butter-chicken', qty: 2 },
        { itemId: 'naan', qty: 3 },
        { itemId: 'butter-chicken', qty: 1 },
      ],
      recipeMap,
    );
    const byMaterial = Object.fromEntries(out.map((d) => [d.rawMaterialId, d.qtyDelta]));
    expect(byMaterial.chicken).toBe(-600); // (2+1) * 200
    expect(byMaterial.butter).toBe(-90); // (2+1) * 30
    expect(byMaterial.flour).toBe(-240); // 3 * 80
  });

  it('ignores items with no recipe and items with no itemId', () => {
    const out = computeDeductions([{ itemId: 'mystery-item', qty: 5 }, { itemId: null, qty: 1 }], recipeMap);
    expect(out).toEqual([]);
  });

  it('returns [] for an empty order', () => {
    expect(computeDeductions([], recipeMap)).toEqual([]);
  });
});
