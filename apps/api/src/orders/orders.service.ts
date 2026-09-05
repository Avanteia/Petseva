import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { DiscountSpec, OrderType, OutletSettings } from '@rms/shared';
import { Actor, hasPerm } from '../common/auth';
import { AuditService } from '../common/audit.service';
import { DB } from '../common/db.module';
import { EventsService } from '../common/events.service';
import { NumberingService } from '../common/numbering.service';
import { Db, Tx } from '../db/client';
import { addons, customers, kots, menuCategories, menuItems, orderItems, orders, tables, taxSlabs, variations, KotItemSnapshot } from '../db/schema';
import { FloorService } from '../floor/floor.module';
import { OutletsService } from '../outlets/outlets.module';
import { PrintService } from '../print/print.service';

export interface NewItemInput {
  id?: string;
  itemId: string;
  variationId?: string | null;
  addonIds?: string[];
  qty: number;
  note?: string;
  discount?: DiscountSpec | null;
}
export interface CreateOrderInput {
  id?: string;
  type: OrderType;
  tableId?: string | null;
  covers?: number;
  customerPhone?: string;
  customerName?: string;
  deliveryAddress?: string;
  notes?: string;
  items: NewItemInput[];
  createdAt?: string;
  deviceId?: string;
  sendKot?: boolean;
  /** if the table is already running, append items to that order instead of failing */
  joinExisting?: boolean;
}

export type OrderFull = NonNullable<Awaited<ReturnType<OrdersService['get']>>>;

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly floor: FloorService,
    private readonly outlets: OutletsService,
    private readonly print: PrintService,
  ) {}

  // ------------------------------------------------------------ queries
  async get(outletId: string, orderId: string) {
    const o = await this.db.query.orders.findFirst({
      where: and(eq(orders.id, orderId), eq(orders.outletId, outletId)),
      with: {
        items: { orderBy: asc(orderItems.seq) },
        kots: { orderBy: asc(kots.createdAt) },
        bills: true,
        payments: true,
      },
    });
    if (!o) throw new NotFoundException('Order not found');
    return o;
  }

  list(outletId: string, q: { status?: string; type?: string; from?: Date; to?: Date; limit?: number }) {
    const conds = [eq(orders.outletId, outletId)];
    if (q.status) conds.push(inArray(orders.status, q.status.split(',')));
    if (q.type) conds.push(eq(orders.type, q.type));
    if (q.from) conds.push(gte(orders.createdAt, q.from));
    if (q.to) conds.push(lte(orders.createdAt, q.to));
    return this.db.query.orders.findMany({
      where: and(...conds),
      with: { items: { orderBy: asc(orderItems.seq) }, bills: true },
      orderBy: desc(orders.createdAt),
      limit: q.limit ?? 200,
    });
  }

  // ------------------------------------------------------------ helpers
  /** Lock the order row; enforce optimistic version if provided. */
  private async lock(tx: Tx, outletId: string, orderId: string, expectedVersion?: number) {
    const rows = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.outletId, outletId)))
      .for('update');
    const o = rows[0];
    if (!o) throw new NotFoundException('Order not found');
    if (expectedVersion !== undefined && expectedVersion !== null && o.version !== expectedVersion) {
      throw new ConflictException({ message: 'Order was modified by someone else', code: 'VERSION_CONFLICT', currentVersion: o.version });
    }
    return o;
  }

  private async bump(tx: Tx, orderId: string) {
    await tx
      .update(orders)
      .set({ version: sql`${orders.version} + 1`, updatedAt: new Date() })
      .where(eq(orders.id, orderId));
  }

  private async emit(outletId: string, orderId: string) {
    const order = await this.get(outletId, orderId);
    this.events.publish({ type: 'order.updated', outletId, orderId, order });
    return order;
  }

  /** Resolve menu snapshots (price, tax, station) for incoming item lines. */
  private async resolveItems(tx: Tx | Db, outletId: string, inputs: NewItemInput[], settings: OutletSettings) {
    const ids = [...new Set(inputs.map((i) => i.itemId))];
    const items = ids.length
      ? await tx
          .select({ item: menuItems, cat: menuCategories, slab: taxSlabs })
          .from(menuItems)
          .innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
          .leftJoin(taxSlabs, eq(menuItems.taxSlabId, taxSlabs.id))
          .where(and(eq(menuItems.outletId, outletId), inArray(menuItems.id, ids)))
      : [];
    const varIds = inputs.map((i) => i.variationId).filter((x): x is string => !!x);
    const vars = varIds.length ? await tx.select().from(variations).where(inArray(variations.id, varIds)) : [];
    const addonIds = [...new Set(inputs.flatMap((i) => i.addonIds ?? []))];
    const adds = addonIds.length ? await tx.select().from(addons).where(inArray(addons.id, addonIds)) : [];

    return inputs.map((inp) => {
      const m = items.find((x) => x.item.id === inp.itemId);
      if (!m) throw new BadRequestException(`Menu item not found: ${inp.itemId}`);
      if (!m.item.available || m.item.stockOut) throw new BadRequestException(`${m.item.name} is not available right now`);
      if (!Number.isInteger(inp.qty) || inp.qty <= 0) throw new BadRequestException('qty must be a positive integer');
      const v = inp.variationId ? vars.find((x) => x.id === inp.variationId && x.itemId === inp.itemId) : undefined;
      if (inp.variationId && !v) throw new BadRequestException(`Variation not found for ${m.item.name}`);
      const chosenAddons = (inp.addonIds ?? []).map((id) => {
        const a = adds.find((x) => x.id === id);
        if (!a) throw new BadRequestException(`Addon not found: ${id}`);
        return { id: a.id, name: a.name, price: a.price };
      });
      return {
        id: inp.id ?? randomUUID(),
        outletId,
        itemId: m.item.id,
        name: m.item.name,
        variationId: v?.id ?? null,
        variationName: v?.name ?? null,
        unitPrice: v?.price ?? m.item.price,
        addons: chosenAddons,
        qty: inp.qty,
        note: inp.note ?? null,
        status: 'PENDING',
        taxRateBps: m.slab?.rateBps ?? 0,
        taxInclusive: settings.taxInclusive,
        packagingCharge: m.item.packagingCharge,
        station: m.item.station ?? m.cat.station ?? 'KITCHEN',
        discount: inp.discount ?? null,
      };
    });
  }

  private checkDiscountLimit(actor: Actor, settings: OutletSettings, discount: DiscountSpec | null | undefined, base: number) {
    if (!discount) return;
    if (hasPerm(actor, 'pos.bill.discount.unlimited') || actor.override) return;
    if (!hasPerm(actor, 'pos.bill.discount')) throw new ForbiddenException('Not allowed to give discounts');
    const bps = discount.type === 'PERCENT' ? discount.value : base > 0 ? Math.round((discount.value * 10000) / base) : 0;
    if (bps > settings.cashierMaxDiscountBps)
      throw new ForbiddenException({
        message: `Discount above ${settings.cashierMaxDiscountBps / 100}% needs a manager PIN`,
        code: 'OVERRIDE_REQUIRED',
      });
  }

  private async upsertCustomer(tx: Tx, outletId: string, phone?: string, name?: string) {
    if (!phone) return null;
    const p = phone.replace(/\D/g, '');
    if (p.length < 6) return null;
    const [c] = await tx
      .insert(customers)
      .values({ outletId, phone: p, name: name ?? null })
      .onConflictDoUpdate({ target: [customers.outletId, customers.phone], set: { name: name ? name : sql`${customers.name}` } })
      .returning();
    return c;
  }

  // ------------------------------------------------------------ commands
  async create(actor: Actor, input: CreateOrderInput) {
    const outletId = actor.outletId;
    if (input.id) {
      const existing = await this.db.query.orders.findFirst({ where: and(eq(orders.id, input.id), eq(orders.outletId, outletId)) });
      if (existing) return this.get(outletId, existing.id); // idempotent replay from offline queue
    }
    const outlet = await this.outlets.get(outletId);
    const settings = outlet.settings;
    if (!input.items?.length) throw new BadRequestException('Order needs at least one item');

    const result = await this.db.transaction(async (tx) => {
      let tableName: string | null = null;
      if (input.type === 'DINE_IN') {
        if (!input.tableId) throw new BadRequestException('Dine-in order needs a table');
        const [t] = await tx.select().from(tables).where(and(eq(tables.id, input.tableId), eq(tables.outletId, outletId))).for('update');
        if (!t) throw new NotFoundException('Table not found');
        if (t.currentOrderId) {
          if (!input.joinExisting) throw new ConflictException({ message: `Table ${t.name} already has a running order`, code: 'TABLE_RUNNING', orderId: t.currentOrderId });
          const merged = await this.addItemsTx(tx, actor, t.currentOrderId, input.items, undefined, settings);
          if (input.sendKot) await this.sendKotTx(tx, actor, merged.id, outlet);
          return merged.id;
        }
        tableName = t.name;
      }
      const id = input.id ?? randomUUID();
      const orderNumber = await this.numbering.orderNumber(tx, outletId, outlet.timezone);
      const cust = await this.upsertCustomer(tx, outletId, input.customerPhone, input.customerName);
      await tx.insert(orders).values({
        id,
        outletId,
        orderNumber,
        type: input.type,
        status: 'OPEN',
        tableId: input.type === 'DINE_IN' ? input.tableId : null,
        tableName,
        customerId: cust?.id ?? null,
        customerName: input.customerName ?? cust?.name ?? null,
        customerPhone: cust?.phone ?? input.customerPhone ?? null,
        deliveryAddress: input.deliveryAddress ?? null,
        covers: input.covers ?? 1,
        notes: input.notes ?? null,
        serviceChargeBps: null,
        createdBy: actor.id,
        deviceId: input.deviceId ?? null,
        createdAt: input.createdAt ? new Date(input.createdAt) : new Date(),
      });
      const lines = await this.resolveItems(tx, outletId, input.items, settings);
      await tx.insert(orderItems).values(lines.map((l, i) => ({ ...l, orderId: id, seq: i + 1 })));
      if (input.type === 'DINE_IN' && input.tableId) await this.floor.setTableStatus(tx, outletId, input.tableId, 'RUNNING', id);
      if (input.sendKot) await this.sendKotTx(tx, actor, id, outlet);
      return id;
    });
    return this.emit(outletId, result);
  }

  private async addItemsTx(tx: Tx, actor: Actor, orderId: string, items: NewItemInput[], expectedVersion: number | undefined, settings: OutletSettings) {
    const o = await this.lock(tx, actor.outletId, orderId, expectedVersion);
    if (o.status !== 'OPEN') throw new BadRequestException(`Cannot add items to a ${o.status} order`);
    const [{ maxSeq }] = await tx.select({ maxSeq: sql<number>`coalesce(max(${orderItems.seq}), 0)` }).from(orderItems).where(eq(orderItems.orderId, orderId));
    const existingIds = items.filter((i) => i.id).map((i) => i.id!);
    const already = existingIds.length ? await tx.select({ id: orderItems.id }).from(orderItems).where(inArray(orderItems.id, existingIds)) : [];
    const fresh = items.filter((i) => !i.id || !already.some((a) => a.id === i.id));
    if (fresh.length) {
      const lines = await this.resolveItems(tx, actor.outletId, fresh, settings);
      await tx.insert(orderItems).values(lines.map((l, i) => ({ ...l, orderId, seq: Number(maxSeq) + i + 1 })));
      await this.bump(tx, orderId);
    }
    return o;
  }

  async addItems(actor: Actor, orderId: string, items: NewItemInput[], expectedVersion?: number, sendKot = false) {
    const outlet = await this.outlets.get(actor.outletId);
    await this.db.transaction(async (tx) => {
      await this.addItemsTx(tx, actor, orderId, items, expectedVersion, outlet.settings);
      if (sendKot) await this.sendKotTx(tx, actor, orderId, outlet);
    });
    return this.emit(actor.outletId, orderId);
  }

  async updateItem(actor: Actor, orderId: string, orderItemId: string, patch: { qty?: number; note?: string | null; discount?: DiscountSpec | null }, expectedVersion?: number) {
    const settings = await this.outlets.settings(actor.outletId);
    await this.db.transaction(async (tx) => {
      const o = await this.lock(tx, actor.outletId, orderId, expectedVersion);
      if (o.status !== 'OPEN') throw new BadRequestException(`Order is ${o.status}`);
      const [it] = await tx.select().from(orderItems).where(and(eq(orderItems.id, orderItemId), eq(orderItems.orderId, orderId)));
      if (!it) throw new NotFoundException('Order item not found');
      if (it.status === 'VOIDED') throw new BadRequestException('Item is voided');
      const set: Partial<typeof it> = {};
      if (patch.qty !== undefined) {
        if (!Number.isInteger(patch.qty) || patch.qty <= 0) throw new BadRequestException('qty must be positive');
        if (it.status !== 'PENDING' && patch.qty > it.qty) {
          // increasing a sent item → the extra qty needs a fresh KOT: add as a new pending line
          const extra = patch.qty - it.qty;
          const [{ maxSeq }] = await tx.select({ maxSeq: sql<number>`coalesce(max(${orderItems.seq}), 0)` }).from(orderItems).where(eq(orderItems.orderId, orderId));
          await tx.insert(orderItems).values({ ...it, id: randomUUID(), qty: extra, status: 'PENDING', kotId: null, seq: Number(maxSeq) + 1, createdAt: new Date() });
        } else if (it.status !== 'PENDING' && patch.qty < it.qty) {
          throw new BadRequestException({ message: 'Item already sent to kitchen — use void with a reason to reduce quantity', code: 'VOID_REQUIRED' });
        } else set.qty = patch.qty;
      }
      if (patch.note !== undefined) set.note = patch.note;
      if (patch.discount !== undefined) {
        this.checkDiscountLimit(actor, settings, patch.discount, (it.unitPrice + it.addons.reduce((a, x) => a + x.price, 0)) * (patch.qty ?? it.qty));
        set.discount = patch.discount;
        if (patch.discount) await this.audit.log(tx, actor, 'DISCOUNT', 'order_item', orderItemId, { orderId, discount: patch.discount, item: it.name });
      }
      if (Object.keys(set).length) await tx.update(orderItems).set(set).where(eq(orderItems.id, orderItemId));
      await this.bump(tx, orderId);
    });
    return this.emit(actor.outletId, orderId);
  }

  async voidItem(actor: Actor, orderId: string, orderItemId: string, reason: string, qty?: number, expectedVersion?: number) {
    if (!reason?.trim()) throw new BadRequestException('A reason is required to void an item');
    const outlet = await this.outlets.get(actor.outletId);
    let cancelKot: any = null;
    await this.db.transaction(async (tx) => {
      const o = await this.lock(tx, actor.outletId, orderId, expectedVersion);
      if (o.status !== 'OPEN' && o.status !== 'BILLED') throw new BadRequestException(`Order is ${o.status}`);
      const [it] = await tx.select().from(orderItems).where(and(eq(orderItems.id, orderItemId), eq(orderItems.orderId, orderId)));
      if (!it) throw new NotFoundException('Order item not found');
      if (it.status === 'VOIDED') return;
      const wasSent = it.status !== 'PENDING';
      // permission: voiding a PENDING (unsent) line is a plain edit; voiding a SENT line needs pos.order.void_item or override
      if (wasSent && !hasPerm(actor, 'pos.order.void_item') && !actor.override)
        throw new ForbiddenException({ message: 'Voiding a sent item needs a manager PIN', code: 'OVERRIDE_REQUIRED' });
      const voidQty = qty && qty < it.qty ? qty : it.qty;
      if (voidQty < it.qty) {
        await tx.update(orderItems).set({ qty: it.qty - voidQty }).where(eq(orderItems.id, it.id));
        await tx.insert(orderItems).values({ ...it, id: randomUUID(), qty: voidQty, status: 'VOIDED', voidReason: reason, voidedBy: actor.id, voidedAt: new Date(), seq: it.seq });
      } else {
        await tx.update(orderItems).set({ status: 'VOIDED', voidReason: reason, voidedBy: actor.id, voidedAt: new Date() }).where(eq(orderItems.id, it.id));
      }
      if (wasSent) {
        const kotId = randomUUID();
        const kotNumber = await this.numbering.kotNumber(tx, actor.outletId, outlet.timezone);
        const snap: KotItemSnapshot = { orderItemId: it.id, name: it.name, variation: it.variationName ?? undefined, qty: voidQty, addons: it.addons.map((a) => a.name), note: reason, cancelled: true };
        const [k] = await tx
          .insert(kots)
          .values({ id: kotId, outletId: actor.outletId, orderId, kotNumber, station: it.station, kind: 'CANCEL', status: 'NEW', items: [snap], createdBy: actor.id })
          .returning();
        cancelKot = k;
      }
      await this.audit.log(tx, actor, 'ITEM_VOID', 'order_item', it.id, { orderId, item: it.name, qty: voidQty, reason, wasSent });
      await this.bump(tx, orderId);
    });
    const order = await this.emit(actor.outletId, orderId);
    if (cancelKot) {
      this.events.publish({ type: 'kot.created', outletId: actor.outletId, kot: cancelKot });
      await this.print.printKot(actor.outletId, order, cancelKot).catch(() => undefined);
    }
    return order;
  }

  /** Group PENDING items by station → one KOT per station; mark items SENT. Returns created KOTs. */
  private async sendKotTx(tx: Tx, actor: Actor, orderId: string, outlet: Awaited<ReturnType<OutletsService['get']>>) {
    const pending = await tx.select().from(orderItems).where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, 'PENDING'))).orderBy(asc(orderItems.seq));
    if (!pending.length) return [];
    const [{ n }] = await tx.select({ n: sql<number>`count(*)` }).from(kots).where(and(eq(kots.orderId, orderId), eq(kots.kind, 'NEW')));
    const isEdit = Number(n) > 0;
    const byStation = new Map<string, typeof pending>();
    for (const it of pending) byStation.set(it.station, [...(byStation.get(it.station) ?? []), it]);
    const created: (typeof kots.$inferSelect)[] = [];
    for (const [station, its] of byStation) {
      const kotId = randomUUID();
      const kotNumber = await this.numbering.kotNumber(tx, actor.outletId, outlet.timezone);
      const snap: KotItemSnapshot[] = its.map((it) => ({
        orderItemId: it.id,
        name: it.name,
        variation: it.variationName ?? undefined,
        qty: it.qty,
        addons: it.addons.map((a) => a.name),
        note: it.note ?? undefined,
      }));
      const [k] = await tx
        .insert(kots)
        .values({ id: kotId, outletId: actor.outletId, orderId, kotNumber, station, kind: isEdit ? 'EDIT' : 'NEW', status: 'NEW', items: snap, createdBy: actor.id })
        .returning();
      await tx.update(orderItems).set({ status: 'SENT', kotId }).where(inArray(orderItems.id, its.map((i) => i.id)));
      created.push(k);
    }
    await this.bump(tx, orderId);
    return created;
  }

  async sendKot(actor: Actor, orderId: string, expectedVersion?: number) {
    const outlet = await this.outlets.get(actor.outletId);
    const created = await this.db.transaction(async (tx) => {
      const o = await this.lock(tx, actor.outletId, orderId, expectedVersion);
      if (o.status !== 'OPEN') throw new BadRequestException(`Order is ${o.status}`);
      return this.sendKotTx(tx, actor, orderId, outlet);
    });
    const order = await this.emit(actor.outletId, orderId);
    const prints: unknown[] = [];
    for (const k of created) {
      this.events.publish({ type: 'kot.created', outletId: actor.outletId, kot: k });
      prints.push(await this.print.printKot(actor.outletId, order, k).catch((e) => ({ ok: false, error: String(e?.message ?? e) })));
    }
    return { order, kots: created, prints };
  }

  /** Used by billing: ensure nothing is left un-sent before a bill is generated. */
  async sendPendingWithinTx(tx: Tx, actor: Actor, orderId: string) {
    const outlet = await this.outlets.get(actor.outletId);
    return this.sendKotTx(tx, actor, orderId, outlet);
  }

  async setDiscount(actor: Actor, orderId: string, discount: DiscountSpec | null, expectedVersion?: number) {
    const settings = await this.outlets.settings(actor.outletId);
    await this.db.transaction(async (tx) => {
      const o = await this.lock(tx, actor.outletId, orderId, expectedVersion);
      if (o.status !== 'OPEN' && o.status !== 'BILLED') throw new BadRequestException(`Order is ${o.status}`);
      const its = await tx.select().from(orderItems).where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, 'SENT')));
      const base = its.reduce((a, i) => a + (i.unitPrice + i.addons.reduce((x, y) => x + y.price, 0)) * i.qty, 0);
      this.checkDiscountLimit(actor, settings, discount, base);
      await tx.update(orders).set({ discount: discount ? { ...discount, byUserId: actor.override?.byUserId ?? actor.id } : null }).where(eq(orders.id, orderId));
      await this.audit.log(tx, actor, discount ? 'DISCOUNT' : 'DISCOUNT_REMOVE', 'order', orderId, { discount });
      await this.bump(tx, orderId);
    });
    return this.emit(actor.outletId, orderId);
  }

  async update(
    actor: Actor,
    orderId: string,
    patch: { covers?: number; notes?: string | null; customerPhone?: string; customerName?: string; deliveryAddress?: string; type?: OrderType; serviceChargeBps?: number | null; deliveryCharge?: number },
    expectedVersion?: number,
  ) {
    await this.db.transaction(async (tx) => {
      const o = await this.lock(tx, actor.outletId, orderId, expectedVersion);
      if (o.status === 'SETTLED' || o.status === 'CANCELLED') throw new BadRequestException(`Order is ${o.status}`);
      const set: any = {};
      if (patch.covers !== undefined) set.covers = patch.covers;
      if (patch.notes !== undefined) set.notes = patch.notes;
      if (patch.deliveryAddress !== undefined) set.deliveryAddress = patch.deliveryAddress;
      if (patch.serviceChargeBps !== undefined) set.serviceChargeBps = patch.serviceChargeBps;
      if (patch.deliveryCharge !== undefined) set.deliveryCharge = patch.deliveryCharge;
      if (patch.type && patch.type !== 'DINE_IN' && o.type !== 'DINE_IN') set.type = patch.type;
      if (patch.customerPhone !== undefined || patch.customerName !== undefined) {
        const c = await this.upsertCustomer(tx, actor.outletId, patch.customerPhone ?? o.customerPhone ?? undefined, patch.customerName);
        set.customerId = c?.id ?? o.customerId;
        set.customerPhone = c?.phone ?? patch.customerPhone ?? o.customerPhone;
        set.customerName = patch.customerName ?? c?.name ?? o.customerName;
      }
      if (Object.keys(set).length) await tx.update(orders).set(set).where(eq(orders.id, orderId));
      await this.bump(tx, orderId);
    });
    return this.emit(actor.outletId, orderId);
  }

  async cancel(actor: Actor, orderId: string, reason: string, expectedVersion?: number) {
    if (!reason?.trim()) throw new BadRequestException('A reason is required to cancel an order');
    const outlet = await this.outlets.get(actor.outletId);
    const cancelKots: any[] = [];
    await this.db.transaction(async (tx) => {
      const o = await this.lock(tx, actor.outletId, orderId, expectedVersion);
      if (o.status === 'SETTLED') throw new BadRequestException('Settled orders cannot be cancelled — void the bill instead');
      if (o.status === 'CANCELLED') return;
      const sent = await tx.select().from(orderItems).where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, 'SENT')));
      if (sent.length && !hasPerm(actor, 'pos.order.cancel') && !actor.override)
        throw new ForbiddenException({ message: 'Cancelling an order with sent items needs a manager PIN', code: 'OVERRIDE_REQUIRED' });
      const byStation = new Map<string, typeof sent>();
      for (const it of sent) byStation.set(it.station, [...(byStation.get(it.station) ?? []), it]);
      for (const [station, its] of byStation) {
        const kotNumber = await this.numbering.kotNumber(tx, actor.outletId, outlet.timezone);
        const [k] = await tx
          .insert(kots)
          .values({
            id: randomUUID(),
            outletId: actor.outletId,
            orderId,
            kotNumber,
            station,
            kind: 'CANCEL',
            status: 'NEW',
            items: its.map((it) => ({ orderItemId: it.id, name: it.name, variation: it.variationName ?? undefined, qty: it.qty, cancelled: true, note: reason })),
            createdBy: actor.id,
          })
          .returning();
        cancelKots.push(k);
      }
      await tx.update(orderItems).set({ status: 'VOIDED', voidReason: reason, voidedBy: actor.id, voidedAt: new Date() }).where(and(eq(orderItems.orderId, orderId), inArray(orderItems.status, ['PENDING', 'SENT', 'READY', 'SERVED'])));
      await tx.update(kots).set({ status: 'CANCELLED' }).where(and(eq(kots.orderId, orderId), inArray(kots.status, ['NEW', 'PREPARING'])));
      await tx.update(orders).set({ status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason }).where(eq(orders.id, orderId));
      if (o.tableId) await this.floor.setTableStatus(tx, actor.outletId, o.tableId, 'FREE', null);
      await this.audit.log(tx, actor, 'ORDER_CANCEL', 'order', orderId, { reason, orderNumber: o.orderNumber, sentItems: sent.length });
      await this.bump(tx, orderId);
    });
    const order = await this.emit(actor.outletId, orderId);
    for (const k of cancelKots) {
      this.events.publish({ type: 'kot.created', outletId: actor.outletId, kot: k });
      await this.print.printKot(actor.outletId, order, k).catch(() => undefined);
    }
    return order;
  }

  async transfer(actor: Actor, orderId: string, toTableId: string, expectedVersion?: number) {
    await this.db.transaction(async (tx) => {
      const o = await this.lock(tx, actor.outletId, orderId, expectedVersion);
      if (o.status !== 'OPEN') throw new BadRequestException(`Order is ${o.status}`);
      const [to] = await tx.select().from(tables).where(and(eq(tables.id, toTableId), eq(tables.outletId, actor.outletId))).for('update');
      if (!to) throw new NotFoundException('Target table not found');
      if (to.currentOrderId) throw new ConflictException({ message: `Table ${to.name} is not free`, code: 'TABLE_RUNNING' });
      if (o.tableId) await this.floor.setTableStatus(tx, actor.outletId, o.tableId, 'FREE', null);
      await this.floor.setTableStatus(tx, actor.outletId, to.id, 'RUNNING', orderId);
      await tx.update(orders).set({ tableId: to.id, tableName: to.name, type: 'DINE_IN' }).where(eq(orders.id, orderId));
      await this.audit.log(tx, actor, 'TABLE_TRANSFER', 'order', orderId, { from: o.tableName, to: to.name });
      await this.bump(tx, orderId);
    });
    return this.emit(actor.outletId, orderId);
  }

  /** Merge `fromOrderId` into `intoOrderId` (items move, source table freed). */
  async merge(actor: Actor, fromOrderId: string, intoOrderId: string) {
    if (fromOrderId === intoOrderId) throw new BadRequestException('Cannot merge an order into itself');
    await this.db.transaction(async (tx) => {
      const [a, b] = [fromOrderId, intoOrderId].sort();
      const la = await this.lock(tx, actor.outletId, a);
      const lb = await this.lock(tx, actor.outletId, b);
      const from = la.id === fromOrderId ? la : lb;
      const into = la.id === intoOrderId ? la : lb;
      if (from.status !== 'OPEN' || into.status !== 'OPEN') throw new BadRequestException('Both orders must be OPEN to merge');
      const [{ maxSeq }] = await tx.select({ maxSeq: sql<number>`coalesce(max(${orderItems.seq}), 0)` }).from(orderItems).where(eq(orderItems.orderId, intoOrderId));
      await tx
        .update(orderItems)
        .set({ orderId: intoOrderId, seq: sql`${orderItems.seq} + ${Number(maxSeq)}` })
        .where(eq(orderItems.orderId, fromOrderId));
      await tx.update(kots).set({ orderId: intoOrderId }).where(eq(kots.orderId, fromOrderId));
      await tx.update(orders).set({ status: 'CANCELLED', cancelReason: `Merged into ${into.orderNumber}`, mergedIntoOrderId: intoOrderId, cancelledAt: new Date() }).where(eq(orders.id, fromOrderId));
      if (from.tableId) await this.floor.setTableStatus(tx, actor.outletId, from.tableId, 'FREE', null);
      await tx.update(orders).set({ covers: from.covers + into.covers }).where(eq(orders.id, intoOrderId));
      await this.audit.log(tx, actor, 'TABLE_MERGE', 'order', intoOrderId, { from: from.orderNumber, fromTable: from.tableName, into: into.orderNumber });
      await this.bump(tx, fromOrderId);
      await this.bump(tx, intoOrderId);
    });
    await this.emit(actor.outletId, fromOrderId);
    return this.emit(actor.outletId, intoOrderId);
  }

  /** Split items (by orderItemId + qty) off into a new order so they can be billed separately. */
  async split(actor: Actor, orderId: string, parts: { orderItemId: string; qty: number }[], expectedVersion?: number) {
    if (!parts.length) throw new BadRequestException('Nothing to split');
    const outlet = await this.outlets.get(actor.outletId);
    let newId = '';
    await this.db.transaction(async (tx) => {
      const o = await this.lock(tx, actor.outletId, orderId, expectedVersion);
      if (o.status !== 'OPEN') throw new BadRequestException(`Order is ${o.status}`);
      const its = await tx.select().from(orderItems).where(and(eq(orderItems.orderId, orderId), inArray(orderItems.id, parts.map((p) => p.orderItemId))));
      if (its.every((i) => parts.find((p) => p.orderItemId === i.id)!.qty >= i.qty)) {
        const all = await tx.select({ n: sql<number>`count(*)` }).from(orderItems).where(and(eq(orderItems.orderId, orderId), sql`${orderItems.status} <> 'VOIDED'`));
        if (Number(all[0].n) === its.length) throw new BadRequestException('Cannot split all items out — at least one must remain');
      }
      newId = randomUUID();
      const orderNumber = await this.numbering.orderNumber(tx, actor.outletId, outlet.timezone);
      await tx.insert(orders).values({
        ...o,
        id: newId,
        orderNumber,
        version: 1,
        discount: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        notes: `Split from ${o.orderNumber}`,
      });
      let seq = 1;
      for (const it of its) {
        const want = Math.min(parts.find((p) => p.orderItemId === it.id)!.qty, it.qty);
        if (want <= 0) continue;
        if (want === it.qty) await tx.update(orderItems).set({ orderId: newId, seq: seq++ }).where(eq(orderItems.id, it.id));
        else {
          await tx.update(orderItems).set({ qty: it.qty - want }).where(eq(orderItems.id, it.id));
          await tx.insert(orderItems).values({ ...it, id: randomUUID(), orderId: newId, qty: want, seq: seq++, createdAt: new Date() });
        }
      }
      await this.audit.log(tx, actor, 'ORDER_SPLIT', 'order', orderId, { into: orderNumber, parts });
      await this.bump(tx, orderId);
    });
    await this.emit(actor.outletId, orderId);
    return this.emit(actor.outletId, newId);
  }

  // ------------------------------------------------------------ KOT queries/actions
  listKots(outletId: string, q: { status?: string; station?: string; limit?: number }) {
    const conds = [eq(kots.outletId, outletId)];
    if (q.status) conds.push(inArray(kots.status, q.status.split(',')));
    if (q.station) conds.push(eq(kots.station, q.station));
    return this.db.query.kots.findMany({ where: and(...conds), with: { order: true }, orderBy: desc(kots.createdAt), limit: q.limit ?? 100 });
  }

  async setKotStatus(actor: Actor, kotId: string, status: string) {
    const [k] = await this.db
      .update(kots)
      .set({ status, bumpedAt: status === 'READY' || status === 'SERVED' ? new Date() : undefined })
      .where(and(eq(kots.id, kotId), eq(kots.outletId, actor.outletId)))
      .returning();
    if (!k) throw new NotFoundException('KOT not found');
    if (status === 'READY' || status === 'SERVED') {
      await this.db.update(orderItems).set({ status }).where(and(eq(orderItems.kotId, kotId), sql`${orderItems.status} <> 'VOIDED'`));
    }
    this.events.publish({ type: 'kot.updated', outletId: actor.outletId, kot: k });
    await this.emit(actor.outletId, k.orderId);
    return k;
  }

  async reprintKot(actor: Actor, kotId: string) {
    const k = await this.db.query.kots.findFirst({ where: and(eq(kots.id, kotId), eq(kots.outletId, actor.outletId)) });
    if (!k) throw new NotFoundException('KOT not found');
    await this.db.update(kots).set({ printCount: sql`${kots.printCount} + 1` }).where(eq(kots.id, kotId));
    await this.audit.log(this.db, actor, 'KOT_REPRINT', 'kot', kotId, { kotNumber: k.kotNumber });
    const order = await this.get(actor.outletId, k.orderId);
    return this.print.printKot(actor.outletId, order, k, true);
  }
}
