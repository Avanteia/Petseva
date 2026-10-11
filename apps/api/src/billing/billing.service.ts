import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { BillInput, BillResult, computeBill, OrderType, OutletSettings, PaymentMode, ReceiptData, settlement } from '@rms/shared';
import { Actor, hasPerm } from '../common/auth';
import { AuditService } from '../common/audit.service';
import { DB } from '../common/db.module';
import { EventsService } from '../common/events.service';
import { NumberingService } from '../common/numbering.service';
import { Db, Tx } from '../db/client';
import { bills, customers, orderItems, orders, payments, users } from '../db/schema';
import { FloorService } from '../floor/floor.module';
import { InventoryService, LowStockAlert } from '../inventory/inventory.service';
import { OrdersService } from '../orders/orders.service';
import { OutletsService } from '../outlets/outlets.module';
import { PrintService } from '../print/print.service';

export interface PaymentInput {
  id?: string;
  mode: PaymentMode;
  amount: number;
  tendered?: number;
  reference?: string;
}

/** Build the BillInput for an order from its persisted item snapshots + outlet settings. */
export function billInputFor(order: { type: string; discount: any; serviceChargeBps: number | null; deliveryCharge: number }, items: (typeof orderItems.$inferSelect)[], settings: OutletSettings): BillInput {
  return {
    lines: items.map((i) => ({
      id: i.id,
      name: i.variationName ? `${i.name} (${i.variationName})` : i.name,
      qty: i.qty,
      unitPrice: i.unitPrice,
      addonsPerUnit: i.addons.reduce((a, x) => a + x.price, 0),
      packagingPerUnit: i.packagingCharge,
      taxRateBps: i.taxRateBps,
      taxInclusive: i.taxInclusive,
      discount: i.discount ?? undefined,
      voided: i.status === 'VOIDED',
    })),
    billDiscount: order.discount ?? undefined,
    serviceChargeBps: order.serviceChargeBps ?? settings.serviceChargeBps,
    serviceChargeTaxable: settings.serviceChargeTaxable,
    serviceChargeTaxRateBps: settings.serviceChargeTaxRateBps,
    roundingMode: settings.roundingMode,
    applyPackaging: order.type !== 'DINE_IN',
    deliveryCharge: order.type === 'DELIVERY' ? order.deliveryCharge : 0,
  };
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly floor: FloorService,
    private readonly outlets: OutletsService,
    private readonly ordersSvc: OrdersService,
    private readonly print: PrintService,
    private readonly inventory: InventoryService,
  ) {}

  async get(outletId: string, billId: string) {
    const b = await this.db.query.bills.findFirst({
      where: and(eq(bills.id, billId), eq(bills.outletId, outletId)),
      with: { payments: true, order: { with: { items: true } } },
    });
    if (!b) throw new NotFoundException('Bill not found');
    return b;
  }

  list(outletId: string, q: { from?: Date; to?: Date; status?: string; limit?: number }) {
    const conds = [eq(bills.outletId, outletId)];
    if (q.from) conds.push(gte(bills.createdAt, q.from));
    if (q.to) conds.push(lte(bills.createdAt, q.to));
    if (q.status) conds.push(inArray(bills.status, q.status.split(',')));
    return this.db.query.bills.findMany({ where: and(...conds), with: { payments: true, order: true }, orderBy: desc(bills.createdAt), limit: q.limit ?? 200 });
  }

  /** Preview the computed totals for an OPEN order without creating a bill. */
  async preview(outletId: string, orderId: string): Promise<BillResult> {
    const o = await this.ordersSvc.get(outletId, orderId);
    const settings = await this.outlets.settings(outletId);
    return computeBill(billInputFor(o, o.items, settings));
  }

  /**
   * Generate (or regenerate) the bill for an order. Auto-sends any pending KOT first.
   * Idempotent: re-calling for an order with an UNPAID bill recomputes into the same bill row.
   */
  async createBill(actor: Actor, orderId: string, opts: { id?: string; provisionalNumber?: string; print?: boolean } = {}) {
    const outlet = await this.outlets.get(actor.outletId);
    const settings = outlet.settings;
    let billId = '';
    let newKots: any[] = [];
    await this.db.transaction(async (tx) => {
      const [o] = await tx.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.outletId, actor.outletId))).for('update');
      if (!o) throw new NotFoundException('Order not found');
      if (o.status === 'CANCELLED' || o.status === 'SETTLED') throw new BadRequestException(`Order is ${o.status}`);
      newKots = await this.ordersSvc.sendPendingWithinTx(tx, actor, orderId);
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
      const live = items.filter((i) => i.status !== 'VOIDED');
      if (!live.length) throw new BadRequestException('Order has no items to bill');
      const computed = computeBill(billInputFor(o, items, settings));
      const existing = await tx.select().from(bills).where(and(eq(bills.orderId, orderId), eq(bills.status, 'UNPAID'))).for('update');
      const base = {
        computed: computed as unknown as Record<string, unknown>,
        subtotal: computed.subtotal,
        discountTotal: computed.discountTotal,
        serviceCharge: computed.serviceCharge,
        taxTotal: computed.taxTotal,
        cgstTotal: computed.cgstTotal,
        sgstTotal: computed.sgstTotal,
        roundOff: computed.roundOff,
        grandTotal: computed.grandTotal,
      };
      if (existing[0]) {
        billId = existing[0].id;
        await tx.update(bills).set({ ...base, provisionalNumber: opts.provisionalNumber ?? existing[0].provisionalNumber }).where(eq(bills.id, billId));
      } else if (opts.id && (await tx.select({ id: bills.id }).from(bills).where(eq(bills.id, opts.id)))[0]) {
        billId = opts.id; // idempotent replay
      } else {
        billId = opts.id ?? randomUUID();
        const billNumber = await this.numbering.billNumber(tx, actor.outletId, settings.billPrefix);
        await tx.insert(bills).values({ id: billId, outletId: actor.outletId, orderId, billNumber, provisionalNumber: opts.provisionalNumber ?? null, status: 'UNPAID', createdBy: actor.id, ...base });
      }
      await tx.update(orders).set({ status: 'BILLED', billedAt: new Date(), version: sql`${orders.version} + 1`, updatedAt: new Date() }).where(eq(orders.id, orderId));
      if (o.tableId) await this.floor.setTableStatus(tx, actor.outletId, o.tableId, 'BILLED', orderId);
    });
    const order = await this.ordersSvc.get(actor.outletId, orderId);
    this.events.publish({ type: 'order.updated', outletId: actor.outletId, orderId, order });
    this.events.publish({ type: 'bill.created', outletId: actor.outletId, billId, orderId });
    for (const k of newKots) {
      this.events.publish({ type: 'kot.created', outletId: actor.outletId, kot: k });
      await this.print.printKot(actor.outletId, order, k).catch(() => undefined);
    }
    const bill = await this.get(actor.outletId, billId);
    const print = opts.print ? await this.printBill(actor, billId, false) : undefined;
    return { bill, order, print };
  }

  /** Record one or more payments; settles the bill when fully paid. Idempotent by payment id. */
  async addPayments(actor: Actor, billId: string, inputs: PaymentInput[]) {
    if (!inputs.length) throw new BadRequestException('No payments given');
    for (const p of inputs) if (!Number.isInteger(p.amount) || p.amount <= 0) throw new BadRequestException('Payment amount must be a positive integer (paise)');
    let settledOrderId: string | null = null;
    let change = 0;
    let lowStock: LowStockAlert[] = [];
    await this.db.transaction(async (tx) => {
      const [b] = await tx.select().from(bills).where(and(eq(bills.id, billId), eq(bills.outletId, actor.outletId))).for('update');
      if (!b) throw new NotFoundException('Bill not found');
      if (b.status === 'VOID') throw new BadRequestException('Bill is void');
      if (b.status === 'PAID') {
        // idempotent replay – accept if all payment ids already exist
        const ids = inputs.map((p) => p.id).filter(Boolean) as string[];
        const have = ids.length ? await tx.select({ id: payments.id }).from(payments).where(inArray(payments.id, ids)) : [];
        if (have.length === ids.length && ids.length) return;
        throw new ConflictException({ message: 'Bill already paid', code: 'ALREADY_PAID' });
      }
      const ids = inputs.map((p) => p.id).filter(Boolean) as string[];
      const have = ids.length ? await tx.select({ id: payments.id }).from(payments).where(inArray(payments.id, ids)) : [];
      const fresh = inputs.filter((p) => !p.id || !have.some((h) => h.id === p.id));
      if (fresh.length) {
        await tx.insert(payments).values(
          fresh.map((p) => ({ id: p.id ?? randomUUID(), outletId: actor.outletId, billId, orderId: b.orderId, mode: p.mode, amount: p.amount, tendered: p.tendered ?? null, reference: p.reference ?? null, createdBy: actor.id })),
        );
      }
      const rows = await tx.select().from(payments).where(and(eq(payments.billId, billId), eq(payments.voided, false)));
      const { paid, due, change: ch } = settlement(b.grandTotal, rows);
      change = ch;
      const paidTotal = Math.min(paid, b.grandTotal);
      if (due === 0) {
        await tx.update(bills).set({ paidTotal, status: 'PAID', paidAt: new Date() }).where(eq(bills.id, billId));
        await tx.update(orders).set({ status: 'SETTLED', settledAt: new Date(), version: sql`${orders.version} + 1`, updatedAt: new Date() }).where(eq(orders.id, b.orderId));
        const [o] = await tx.select().from(orders).where(eq(orders.id, b.orderId));
        if (o?.tableId) await this.floor.setTableStatus(tx, actor.outletId, o.tableId, 'FREE', null);
        if (o?.customerId)
          await tx
            .update(customers)
            .set({ visits: sql`${customers.visits} + 1`, totalSpend: sql`${customers.totalSpend} + ${b.grandTotal}`, lastVisitAt: new Date() })
            .where(eq(customers.id, o.customerId));
        const soldItems = await tx.select({ itemId: orderItems.itemId, qty: orderItems.qty }).from(orderItems).where(and(eq(orderItems.orderId, b.orderId), sql`${orderItems.status} <> 'VOIDED'`));
        lowStock = await this.inventory.deductForSale(tx, actor.outletId, b.orderId, soldItems);
        settledOrderId = b.orderId;
      } else {
        await tx.update(bills).set({ paidTotal }).where(eq(bills.id, billId));
      }
    });
    const bill = await this.get(actor.outletId, billId);
    if (settledOrderId) {
      const order = await this.ordersSvc.get(actor.outletId, settledOrderId);
      this.events.publish({ type: 'order.updated', outletId: actor.outletId, orderId: settledOrderId, order });
      this.events.publish({ type: 'bill.paid', outletId: actor.outletId, billId, orderId: settledOrderId });
      for (const rm of lowStock) this.events.publish({ type: 'stock.low', outletId: actor.outletId, rawMaterialId: rm.id, name: rm.name, currentStock: rm.currentStock, reorderLevel: rm.reorderLevel });
    }
    return { bill, change, due: Math.max(0, bill.grandTotal - bill.paidTotal) };
  }

  /** Void a bill (manager). Unpaid → order back to OPEN. Paid → payments voided (refund) and order re-opened. */
  async voidBill(actor: Actor, billId: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('Reason required');
    if (!hasPerm(actor, 'pos.payment.refund') && !actor.override) throw new ForbiddenException({ message: 'Voiding a bill needs a manager PIN', code: 'OVERRIDE_REQUIRED' });
    let orderId = '';
    await this.db.transaction(async (tx) => {
      const [b] = await tx.select().from(bills).where(and(eq(bills.id, billId), eq(bills.outletId, actor.outletId))).for('update');
      if (!b) throw new NotFoundException('Bill not found');
      if (b.status === 'VOID') return;
      orderId = b.orderId;
      const wasPaid = b.status === 'PAID';
      await tx.update(payments).set({ voided: true }).where(eq(payments.billId, billId));
      await tx.update(bills).set({ status: 'VOID', voidedAt: new Date(), voidReason: reason, paidTotal: 0 }).where(eq(bills.id, billId));
      await tx.update(orders).set({ status: 'OPEN', billedAt: null, settledAt: null, version: sql`${orders.version} + 1`, updatedAt: new Date() }).where(eq(orders.id, orderId));
      const [o] = await tx.select().from(orders).where(eq(orders.id, orderId));
      if (o?.tableId) await this.floor.setTableStatus(tx, actor.outletId, o.tableId, 'RUNNING', orderId);
      await this.audit.log(tx, actor, wasPaid ? 'REFUND' : 'BILL_VOID', 'bill', billId, { billNumber: b.billNumber, amount: b.grandTotal, reason });
    });
    const order = await this.ordersSvc.get(actor.outletId, orderId);
    this.events.publish({ type: 'order.updated', outletId: actor.outletId, orderId, order });
    return order;
  }

  async receiptData(outletId: string, billId: string, duplicate = false): Promise<ReceiptData> {
    const b = await this.get(outletId, billId);
    const outlet = await this.outlets.get(outletId);
    const cashier = b.createdBy ? await this.db.query.users.findFirst({ where: eq(users.id, b.createdBy) }) : null;
    const live = b.order.items.filter((i) => i.status !== 'VOIDED');
    return {
      outlet: {
        name: outlet.name,
        addressLines: outlet.addressLines,
        phone: outlet.phone ?? undefined,
        gstin: outlet.gstin ?? undefined,
        fssai: outlet.fssai ?? undefined,
        header: outlet.settings.receiptHeader || undefined,
        footer: outlet.settings.receiptFooter || undefined,
      },
      billNumber: b.billNumber,
      orderNumber: b.order.orderNumber,
      orderType: b.order.type as OrderType,
      tableName: b.order.tableName ?? undefined,
      customerName: b.order.customerName ?? undefined,
      customerPhone: b.order.customerPhone ?? undefined,
      cashier: cashier?.name ?? 'POS',
      createdAt: b.createdAt,
      bill: b.computed as unknown as BillResult,
      lineMeta: live.map((i) => ({ id: i.id, variation: undefined, addons: i.addons.map((a) => a.name) })),
      payments: b.payments.filter((p) => !p.voided).map((p) => ({ mode: p.mode as PaymentMode, amount: p.amount, reference: p.reference ?? undefined })),
      change: Math.max(0, b.payments.filter((p) => !p.voided).reduce((a, p) => a + (p.tendered ?? p.amount), 0) - b.grandTotal) || undefined,
      duplicate,
    };
  }

  async receipt(outletId: string, billId: string) {
    const data = await this.receiptData(outletId, billId);
    return { data, ...this.print.renderReceipt(data) };
  }

  async printBill(actor: Actor, billId: string, reprint: boolean) {
    const [b] = await this.db.update(bills).set({ printCount: sql`${bills.printCount} + 1` }).where(and(eq(bills.id, billId), eq(bills.outletId, actor.outletId))).returning();
    if (!b) throw new NotFoundException('Bill not found');
    if (reprint) await this.audit.log(this.db, actor, 'BILL_REPRINT', 'bill', billId, { billNumber: b.billNumber, printCount: b.printCount });
    const data = await this.receiptData(actor.outletId, billId, reprint && b.printCount > 1);
    return this.print.printReceipt(actor.outletId, data);
  }

  /** Email/SMS the bill. Messaging providers are pluggable adapters (mock in Phase 1 → logs + returns the text). */
  async sendBill(actor: Actor, billId: string, via: 'EMAIL' | 'SMS' | 'WHATSAPP', to: string) {
    const r = await this.receipt(actor.outletId, billId);
    const msg = `${via} → ${to}: bill ${r.data.billNumber} for ${(r.data.bill.grandTotal / 100).toFixed(2)}`;
    await this.audit.log(this.db, actor, 'BILL_SEND', 'bill', billId, { via, to });
    return { ok: true, mock: true, message: msg, preview: r.text };
  }
}

export type BillingTx = Tx;
