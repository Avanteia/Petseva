import { classifyMenuEngineering } from '@rms/shared';
import { MockAiProvider } from '../ai/mock-ai.provider';

// PricingService itself is thin DB plumbing (see billing.service.spec.ts precedent: test the pure
// logic, not the Nest wiring). The two things worth unit-testing without a DB are (a) the shared
// classifyMenuEngineering rule engine PricingService calls, and (b) that MockAiProvider — used
// directly by PricingService.suggestions() — turns rule-selected candidates into one suggestion
// per candidate deterministically.
describe('pricing suggestion assembly', () => {
  const ai = new MockAiProvider();

  it('turns each non-STAR quadrant candidate plus each combo into one suggestion', async () => {
    const items = [
      { id: 'a', name: 'Bebinca', velocity: 5, marginBps: 6000 }, // low velocity, high margin -> PUZZLE
      { id: 'b', name: 'Butter Naan', velocity: 500, marginBps: 500 }, // high velocity, low margin -> PLOWHORSE
      { id: 'c', name: 'Stale Item', velocity: 2, marginBps: 400 }, // low velocity, low margin -> DOG
      { id: 'd', name: 'Butter Chicken', velocity: 400, marginBps: 5500 }, // high velocity, high margin -> STAR (no action needed)
    ];
    const quadrants = classifyMenuEngineering(items);
    expect(quadrants.find((q) => q.id === 'd')!.quadrant).toBe('STAR');

    const out = await ai.suggestPricingActions({
      outletName: 'Demo Cafe Goa',
      quadrants: quadrants.map((q) => ({ name: q.name, quadrant: q.quadrant, velocity: q.velocity, marginBps: q.marginBps })),
      combos: [{ aName: 'Butter Chicken', bName: 'Butter Naan', count: 42 }],
    });

    // STAR items get no suggestion (they're already doing well) — only PUZZLE/PLOWHORSE/DOG + the combo.
    expect(out).toHaveLength(4);
    expect(out.map((s) => s.itemName)).toEqual(['Bebinca', 'Butter Naan', 'Stale Item', undefined]);
  });

  it('produces nothing when there are no candidates or combos', async () => {
    expect(await ai.suggestPricingActions({ outletName: 'X', quadrants: [], combos: [] })).toEqual([]);
  });
});
