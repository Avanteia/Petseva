import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { classifyMenuEngineering, MenuEngineeringResult, topCooccurringPairs } from '@rms/shared';
import { AI_PROVIDER, AiProvider } from '../ai/ai-provider.interface';
import { DB } from '../common/db.module';
import { Db } from '../db/client';
import { menuItems, orderItems, outlets } from '../db/schema';

const DAY_MS = 86_400_000;

export interface ComboSuggestion {
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  count: number;
  lift: number;
}

@Injectable()
export class PricingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
  ) {}

  private defaultRange(days = 30) {
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY_MS);
    return { from, to };
  }

  /** Velocity × margin quadrant classification (Star/Plowhorse/Puzzle/Dog) — classic menu engineering. */
  async menuEngineering(outletId: string, from?: Date, to?: Date): Promise<MenuEngineeringResult[]> {
    const range = from && to ? { from, to } : this.defaultRange();
    const velocityRows = await this.db
      .select({ id: orderItems.itemId, qty: sql<number>`sum(${orderItems.qty})` })
      .from(orderItems)
      .where(and(eq(orderItems.outletId, outletId), sql`${orderItems.status} <> 'VOIDED'`, gte(orderItems.createdAt, range.from), lte(orderItems.createdAt, range.to)))
      .groupBy(orderItems.itemId);
    const ids = velocityRows.map((r) => r.id).filter((x): x is string => !!x);
    if (!ids.length) return [];
    const items = await this.db.select({ id: menuItems.id, name: menuItems.name, price: menuItems.price, costPrice: menuItems.costPrice }).from(menuItems).where(and(eq(menuItems.outletId, outletId), inArray(menuItems.id, ids)));
    const velocityOf = new Map(velocityRows.map((r) => [r.id as string, Number(r.qty)]));
    const input = items.map((it) => ({
      id: it.id,
      name: it.name,
      velocity: velocityOf.get(it.id) ?? 0,
      marginBps: it.costPrice != null && it.price > 0 ? Math.round(((it.price - it.costPrice) / it.price) * 10_000) : null,
    }));
    return classifyMenuEngineering(input);
  }

  /** Frequently co-purchased item pairs — combo/upsell candidates. */
  async comboSuggestions(outletId: string, from?: Date, to?: Date, minSupport = 3): Promise<ComboSuggestion[]> {
    const range = from && to ? { from, to } : this.defaultRange();
    const rows = await this.db
      .select({ orderId: orderItems.orderId, itemId: orderItems.itemId, name: orderItems.name })
      .from(orderItems)
      .where(and(eq(orderItems.outletId, outletId), sql`${orderItems.status} <> 'VOIDED'`, gte(orderItems.createdAt, range.from), lte(orderItems.createdAt, range.to)));
    const baskets = new Map<string, string[]>();
    const nameOf = new Map<string, string>();
    for (const r of rows) {
      if (!r.itemId) continue;
      nameOf.set(r.itemId, r.name);
      const arr = baskets.get(r.orderId) ?? [];
      arr.push(r.itemId);
      baskets.set(r.orderId, arr);
    }
    const pairs = topCooccurringPairs([...baskets.values()], minSupport);
    return pairs.map((p) => ({ aId: p.a, aName: nameOf.get(p.a) ?? p.a, bId: p.b, bName: nameOf.get(p.b) ?? p.b, count: p.count, lift: p.lift }));
  }

  /** Rule-selected candidates (menu engineering + combos), phrased by the AiProvider — the rule engine picks WHAT, the provider only writes the sentence. */
  async suggestions(outletId: string) {
    const [outlet, quadrants, combos] = await Promise.all([
      this.db.select({ name: outlets.name }).from(outlets).where(eq(outlets.id, outletId)),
      this.menuEngineering(outletId),
      this.comboSuggestions(outletId),
    ]);
    return this.ai.suggestPricingActions({
      outletName: outlet[0]?.name ?? 'Outlet',
      quadrants: quadrants.filter((q) => q.quadrant !== 'UNKNOWN_MARGIN').map((q) => ({ name: q.name, quadrant: q.quadrant, velocity: q.velocity, marginBps: q.marginBps })),
      combos: combos.map((c) => ({ aName: c.aName, bName: c.bName, count: c.count })),
    });
  }
}
