import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { Actor } from '../common/auth';
import { AuditService } from '../common/audit.service';
import { DB } from '../common/db.module';
import { Db } from '../db/client';
import { PurchaseOrderItemSnapshot, purchaseOrders, rawMaterials, stockMovements, vendors } from '../db/schema';
import { NumberingService } from '../common/numbering.service';

@Injectable()
export class PurchasingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  listVendors(outletId: string) {
    return this.db.select().from(vendors).where(eq(vendors.outletId, outletId)).orderBy(vendors.name);
  }

  async upsertVendor(actor: Actor, body: any) {
    const data = { outletId: actor.outletId, name: body.name, phone: body.phone ?? null, email: body.email ?? null, address: body.address ?? null, active: body.active ?? true };
    if (body.id) {
      const [row] = await this.db.update(vendors).set(data).where(and(eq(vendors.id, body.id), eq(vendors.outletId, actor.outletId))).returning();
      if (!row) throw new NotFoundException('Vendor not found');
      return row;
    }
    const [row] = await this.db.insert(vendors).values(data).returning();
    return row;
  }

  list(outletId: string, q: { status?: string }) {
    const conds = [eq(purchaseOrders.outletId, outletId)];
    if (q.status) conds.push(inArray(purchaseOrders.status, q.status.split(',')));
    return this.db
      .select()
      .from(purchaseOrders)
      .where(and(...conds))
      .orderBy(desc(purchaseOrders.createdAt));
  }

  async get(outletId: string, id: string) {
    const [row] = await this.db.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.outletId, outletId)));
    if (!row) throw new NotFoundException('Purchase order not found');
    return row;
  }

  /** Create a DRAFT purchase order. `items` are a snapshot at creation time (same pattern as kots.items). */
  async create(actor: Actor, body: { vendorId?: string; items: PurchaseOrderItemSnapshot[]; expectedAt?: string }) {
    if (!body.items?.length) throw new BadRequestException('At least one item is required');
    const totalCost = body.items.reduce((a, i) => a + i.qty * i.unitCost, 0);
    let row!: typeof purchaseOrders.$inferSelect;
    await this.db.transaction(async (tx) => {
      const poNumber = await this.numbering.poNumber(tx, actor.outletId);
      [row] = await tx
        .insert(purchaseOrders)
        .values({ outletId: actor.outletId, vendorId: body.vendorId ?? null, poNumber, status: 'DRAFT', items: body.items, totalCost, createdBy: actor.id, expectedAt: body.expectedAt ? new Date(body.expectedAt) : null })
        .returning();
    });
    await this.audit.log(this.db, actor, 'PURCHASE_ORDER_CREATE', 'purchase_order', row.id, { poNumber: row.poNumber, totalCost });
    return row;
  }

  /** Marks a PO fully received: writes PURCHASE_IN stock movements, bumps currentStock, and updates a weighted-average cost price. */
  async receive(actor: Actor, id: string) {
    let row!: typeof purchaseOrders.$inferSelect;
    await this.db.transaction(async (tx) => {
      const [po] = await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.outletId, actor.outletId))).for('update');
      if (!po) throw new NotFoundException('Purchase order not found');
      if (po.status === 'RECEIVED') {
        row = po;
        return;
      }
      for (const item of po.items as PurchaseOrderItemSnapshot[]) {
        const [rm] = await tx.select().from(rawMaterials).where(and(eq(rawMaterials.id, item.rawMaterialId), eq(rawMaterials.outletId, actor.outletId))).for('update');
        if (!rm) continue;
        const newStock = rm.currentStock + item.qty;
        const newAvgCost = newStock > 0 ? Math.round((rm.avgCostPrice * rm.currentStock + item.unitCost * item.qty) / newStock) : item.unitCost;
        await tx.update(rawMaterials).set({ currentStock: newStock, avgCostPrice: newAvgCost, preferredVendorId: rm.preferredVendorId ?? po.vendorId }).where(eq(rawMaterials.id, rm.id));
        await tx.insert(stockMovements).values({ outletId: actor.outletId, rawMaterialId: rm.id, type: 'PURCHASE_IN', qtyDelta: item.qty, refType: 'PURCHASE_ORDER', refId: po.id, createdBy: actor.id });
      }
      [row] = await tx.update(purchaseOrders).set({ status: 'RECEIVED', receivedAt: new Date() }).where(eq(purchaseOrders.id, id)).returning();
    });
    await this.audit.log(this.db, actor, 'PURCHASE_ORDER_RECEIVE', 'purchase_order', id, { poNumber: row.poNumber });
    return row;
  }
}
