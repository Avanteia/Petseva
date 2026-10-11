import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { DatedPoint, forecastNextN } from '@rms/shared';
import { Actor } from '../common/auth';
import { DB } from '../common/db.module';
import { Db } from '../db/client';
import { orderItems, PurchaseOrderItemSnapshot, rawMaterials, stockMovements } from '../db/schema';
import { PurchasingService } from '../purchasing/purchasing.service';

export interface ReorderSuggestion {
  rawMaterialId: string;
  name: string;
  unit: string;
  currentStock: number;
  reorderLevel: number;
  avgCostPrice: number;
  preferredVendorId: string | null;
  suggestedQty: number;
  daysOfHistory: number;
  /** first forecast date the running stock is projected to hit/cross the reorder level, or null if not projected within the window */
  projectedBreachDate: string | null;
}

/**
 * Pure — walks a demand forecast against current stock to decide whether/how much to reorder.
 * Extracted so it's unit-testable with plain fixtures, no DB (same reasoning as `billInputFor`
 * in billing.service.ts and `computeDeductions` in inventory.service.ts). The forecast itself
 * (`forecastNextN`) is deterministic stats from @rms/shared — never delegated to an LLM.
 */
export function projectReorder(
  material: { id: string; name: string; unit: string; currentStock: number; reorderLevel: number; reorderQty: number; avgCostPrice: number; preferredVendorId: string | null },
  forecast: DatedPoint[],
  historyDays: number,
): ReorderSuggestion | null {
  let runningStock = material.currentStock;
  let projectedBreachDate: string | null = null;
  let totalForecastDemand = 0;
  for (const point of forecast) {
    totalForecastDemand += point.value;
    runningStock -= point.value;
    if (projectedBreachDate === null && runningStock <= material.reorderLevel) projectedBreachDate = point.date;
  }
  const alreadyLow = material.currentStock <= material.reorderLevel;
  if (!alreadyLow && !projectedBreachDate) return null; // no action needed
  // enough to cover the forecast window and land back above the reorder level, or the outlet's own reorderQty, whichever is larger
  const coverageQty = Math.ceil(totalForecastDemand - material.currentStock + material.reorderLevel);
  const suggestedQty = Math.max(material.reorderQty || 0, coverageQty, 1);
  return {
    rawMaterialId: material.id,
    name: material.name,
    unit: material.unit,
    currentStock: material.currentStock,
    reorderLevel: material.reorderLevel,
    avgCostPrice: material.avgCostPrice,
    preferredVendorId: material.preferredVendorId,
    suggestedQty,
    daysOfHistory: historyDays,
    projectedBreachDate,
  };
}

const MIN_HISTORY_DAYS = 7;

@Injectable()
export class ForecastingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly purchasing: PurchasingService,
  ) {}

  private dayExpr(col: any) {
    return sql<string>`to_char(${col} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`;
  }

  async itemDemandHistory(outletId: string, menuItemId: string, historyDays = 60): Promise<DatedPoint[]> {
    const to = new Date();
    const from = new Date(to.getTime() - historyDays * 86_400_000);
    const rows = await this.db
      .select({ date: this.dayExpr(orderItems.createdAt), qty: sql<number>`sum(${orderItems.qty})` })
      .from(orderItems)
      .where(and(eq(orderItems.outletId, outletId), eq(orderItems.itemId, menuItemId), sql`${orderItems.status} <> 'VOIDED'`, gte(orderItems.createdAt, from), lte(orderItems.createdAt, to)))
      .groupBy(this.dayExpr(orderItems.createdAt))
      .orderBy(this.dayExpr(orderItems.createdAt));
    return rows.map((r) => ({ date: r.date, value: Number(r.qty) }));
  }

  async itemDemandForecast(outletId: string, menuItemId: string, days = 14) {
    const history = await this.itemDemandHistory(outletId, menuItemId);
    return { history, forecast: history.length >= MIN_HISTORY_DAYS ? forecastNextN(history, days) : [] };
  }

  private async rawMaterialConsumptionHistory(outletId: string, rawMaterialId: string, historyDays = 60): Promise<DatedPoint[]> {
    const to = new Date();
    const from = new Date(to.getTime() - historyDays * 86_400_000);
    const rows = await this.db
      .select({ date: this.dayExpr(stockMovements.createdAt), qty: sql<number>`sum(-${stockMovements.qtyDelta})` })
      .from(stockMovements)
      .where(and(eq(stockMovements.outletId, outletId), eq(stockMovements.rawMaterialId, rawMaterialId), eq(stockMovements.type, 'SALE_DEDUCT'), gte(stockMovements.createdAt, from), lte(stockMovements.createdAt, to)))
      .groupBy(this.dayExpr(stockMovements.createdAt))
      .orderBy(this.dayExpr(stockMovements.createdAt));
    return rows.map((r) => ({ date: r.date, value: Math.max(0, Number(r.qty)) }));
  }

  async rawMaterialForecast(outletId: string, rawMaterialId: string, days = 14): Promise<{ history: DatedPoint[]; forecast: DatedPoint[]; suggestion: ReorderSuggestion | null } | null> {
    const [rm] = await this.db.select().from(rawMaterials).where(and(eq(rawMaterials.id, rawMaterialId), eq(rawMaterials.outletId, outletId)));
    if (!rm) return null;
    const history = await this.rawMaterialConsumptionHistory(outletId, rawMaterialId);
    const forecast = history.length >= MIN_HISTORY_DAYS ? forecastNextN(history, days) : [];
    const suggestion = projectReorder(rm, forecast, history.length);
    return { history, forecast, suggestion };
  }

  async reorderSuggestions(outletId: string, days = 14): Promise<ReorderSuggestion[]> {
    const materials = await this.db.select().from(rawMaterials).where(and(eq(rawMaterials.outletId, outletId), eq(rawMaterials.active, true)));
    const out: ReorderSuggestion[] = [];
    for (const rm of materials) {
      const history = await this.rawMaterialConsumptionHistory(outletId, rm.id);
      const forecast = history.length >= MIN_HISTORY_DAYS ? forecastNextN(history, days) : [];
      const suggestion = projectReorder(rm, forecast, history.length);
      if (suggestion) out.push(suggestion);
    }
    return out.sort((a, b) => (a.projectedBreachDate ?? '9999-99-99').localeCompare(b.projectedBreachDate ?? '9999-99-99'));
  }

  /** One-click: turn a reorder suggestion into a DRAFT purchase order via PurchasingService. */
  async createPoFromSuggestion(actor: Actor, rawMaterialId: string) {
    const result = await this.rawMaterialForecast(actor.outletId, rawMaterialId, 14);
    if (!result?.suggestion) throw new BadRequestException('No reorder suggestion for this raw material right now');
    const s = result.suggestion;
    const item: PurchaseOrderItemSnapshot = { rawMaterialId: s.rawMaterialId, name: s.name, unit: s.unit, qty: s.suggestedQty, unitCost: s.avgCostPrice };
    return this.purchasing.create(actor, { vendorId: s.preferredVendorId ?? undefined, items: [item] });
  }
}
