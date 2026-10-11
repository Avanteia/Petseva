import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { Actor } from '../common/auth';
import { AuditService } from '../common/audit.service';
import { DB } from '../common/db.module';
import { Db, Tx } from '../db/client';
import { rawMaterials, recipeItems, stockMovements } from '../db/schema';

export interface RecipeMapEntry {
  rawMaterialId: string;
  qtyPerUnit: number;
}
export type RecipeMap = Map<string, RecipeMapEntry[]>; // menuItemId -> BOM

/**
 * Pure — combines sold-item quantities with each item's BOM into a per-raw-material deduction.
 * Extracted (same reasoning as `billInputFor` in billing.service.ts) so it's unit-testable with
 * plain fixtures, no DB.
 */
export function computeDeductions(items: { itemId: string | null; qty: number }[], recipeMap: RecipeMap): { rawMaterialId: string; qtyDelta: number }[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    if (!item.itemId) continue;
    const bom = recipeMap.get(item.itemId);
    if (!bom) continue;
    for (const line of bom) totals.set(line.rawMaterialId, (totals.get(line.rawMaterialId) ?? 0) - line.qtyPerUnit * item.qty);
  }
  return [...totals.entries()].map(([rawMaterialId, qtyDelta]) => ({ rawMaterialId, qtyDelta }));
}

export interface LowStockAlert {
  id: string;
  name: string;
  currentStock: number;
  reorderLevel: number;
}

@Injectable()
export class InventoryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  listRawMaterials(outletId: string) {
    return this.db.select().from(rawMaterials).where(eq(rawMaterials.outletId, outletId)).orderBy(rawMaterials.name);
  }

  async upsertRawMaterial(actor: Actor, body: any) {
    const data = {
      outletId: actor.outletId,
      name: body.name,
      unit: body.unit,
      reorderLevel: body.reorderLevel ?? 0,
      reorderQty: body.reorderQty ?? 0,
      avgCostPrice: body.avgCostPrice ?? 0,
      preferredVendorId: body.preferredVendorId ?? null,
      active: body.active ?? true,
    };
    if (body.id) {
      const [row] = await this.db.update(rawMaterials).set(data).where(and(eq(rawMaterials.id, body.id), eq(rawMaterials.outletId, actor.outletId))).returning();
      if (!row) throw new NotFoundException('Raw material not found');
      return row;
    }
    const [row] = await this.db.insert(rawMaterials).values({ ...data, currentStock: 0 }).returning();
    await this.audit.log(this.db, actor, 'RAW_MATERIAL_CREATE', 'raw_material', row.id, { name: row.name });
    return row;
  }

  recipe(outletId: string, menuItemId: string) {
    return this.db.select().from(recipeItems).where(and(eq(recipeItems.outletId, outletId), eq(recipeItems.menuItemId, menuItemId)));
  }

  async setRecipe(actor: Actor, menuItemId: string, lines: { rawMaterialId: string; qtyPerUnit: number }[]) {
    await this.db.transaction(async (tx) => {
      await tx.delete(recipeItems).where(and(eq(recipeItems.outletId, actor.outletId), eq(recipeItems.menuItemId, menuItemId)));
      if (lines.length) await tx.insert(recipeItems).values(lines.map((l) => ({ outletId: actor.outletId, menuItemId, rawMaterialId: l.rawMaterialId, qtyPerUnit: l.qtyPerUnit })));
    });
    await this.audit.log(this.db, actor, 'RECIPE_UPDATE', 'menu_item', menuItemId, { lines: lines.length });
    return this.recipe(actor.outletId, menuItemId);
  }

  private async recipeMapFor(tx: Tx | Db, outletId: string, menuItemIds: string[]): Promise<RecipeMap> {
    if (!menuItemIds.length) return new Map();
    const rows = await tx.select().from(recipeItems).where(and(eq(recipeItems.outletId, outletId), inArray(recipeItems.menuItemId, menuItemIds)));
    const map: RecipeMap = new Map();
    for (const r of rows) {
      const arr = map.get(r.menuItemId) ?? [];
      arr.push({ rawMaterialId: r.rawMaterialId, qtyPerUnit: r.qtyPerUnit });
      map.set(r.menuItemId, arr);
    }
    return map;
  }

  /**
   * Auto-deduct stock for a settled sale — the README's "recipe mapping ... stock auto-deducts on
   * each sale." Called inside the SAME transaction that settles the bill (see billing.service.ts).
   * Returns raw materials that just crossed below their reorder level, so the caller can publish
   * `stock.low` events after the transaction commits (events must never fire before a commit).
   */
  async deductForSale(tx: Tx, outletId: string, orderId: string, items: { itemId: string | null; qty: number }[]): Promise<LowStockAlert[]> {
    const menuItemIds = [...new Set(items.map((i) => i.itemId).filter((x): x is string => !!x))];
    if (!menuItemIds.length) return [];
    const recipeMap = await this.recipeMapFor(tx, outletId, menuItemIds);
    const deductions = computeDeductions(items, recipeMap);
    if (!deductions.length) return [];
    const lowStock: LowStockAlert[] = [];
    for (const d of deductions) {
      const [before] = await tx
        .select({ currentStock: rawMaterials.currentStock, reorderLevel: rawMaterials.reorderLevel, name: rawMaterials.name })
        .from(rawMaterials)
        .where(and(eq(rawMaterials.id, d.rawMaterialId), eq(rawMaterials.outletId, outletId)))
        .for('update');
      if (!before) continue;
      const after = before.currentStock + d.qtyDelta;
      await tx.update(rawMaterials).set({ currentStock: after }).where(eq(rawMaterials.id, d.rawMaterialId));
      await tx.insert(stockMovements).values({ outletId, rawMaterialId: d.rawMaterialId, type: 'SALE_DEDUCT', qtyDelta: d.qtyDelta, refType: 'ORDER', refId: orderId });
      if (before.currentStock > before.reorderLevel && after <= before.reorderLevel) lowStock.push({ id: d.rawMaterialId, name: before.name, currentStock: after, reorderLevel: before.reorderLevel });
    }
    return lowStock;
  }

  async recordMovement(actor: Actor, body: { rawMaterialId: string; type: 'WASTAGE' | 'ADJUSTMENT'; qtyDelta: number; note?: string }) {
    if (!Number.isInteger(body.qtyDelta) || body.qtyDelta === 0) throw new BadRequestException('qtyDelta must be a non-zero integer');
    let row: typeof stockMovements.$inferSelect;
    await this.db.transaction(async (tx) => {
      const [rm] = await tx.select().from(rawMaterials).where(and(eq(rawMaterials.id, body.rawMaterialId), eq(rawMaterials.outletId, actor.outletId))).for('update');
      if (!rm) throw new NotFoundException('Raw material not found');
      const after = rm.currentStock + body.qtyDelta;
      await tx.update(rawMaterials).set({ currentStock: after }).where(eq(rawMaterials.id, rm.id));
      [row] = await tx
        .insert(stockMovements)
        .values({ outletId: actor.outletId, rawMaterialId: rm.id, type: body.type, qtyDelta: body.qtyDelta, refType: 'MANUAL', note: body.note ?? null, createdBy: actor.id })
        .returning();
    });
    await this.audit.log(this.db, actor, 'STOCK_ADJUSTMENT', 'raw_material', body.rawMaterialId, { type: body.type, qtyDelta: body.qtyDelta, note: body.note });
    return row!;
  }

  listMovements(outletId: string, q: { rawMaterialId?: string; limit?: number }) {
    const conds = [eq(stockMovements.outletId, outletId)];
    if (q.rawMaterialId) conds.push(eq(stockMovements.rawMaterialId, q.rawMaterialId));
    return this.db
      .select()
      .from(stockMovements)
      .where(and(...conds))
      .orderBy(desc(stockMovements.createdAt))
      .limit(q.limit ?? 200);
  }
}
