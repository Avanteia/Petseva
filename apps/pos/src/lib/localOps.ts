/**
 * Local (optimistic / offline) application of POS operations against the IndexedDB mirror.
 * The server re-applies the same ops authoritatively on sync; its response replaces the local rows.
 */
import { computeBill, type DiscountSpec, type OrderType } from '@rms/shared';
import { cache, db, meta } from './db';
import { uuid } from './format';
import type { Bill, Kot, Menu, Order, OrderItem, Outlet } from './types';

export interface NewItemInput {
  id?: string;
  itemId: string;
  variationId?: string | null;
  addonIds?: string[];
  qty: number;
  note?: string;
}

async function ctx() {
  const [menu, outlet] = await Promise.all([cache.menu(), cache.outlet()]);
  if (!menu || !outlet) throw new Error('POS not initialised — go online once to load the menu');
  return { menu, outlet };
}

async function nextLocalNumber(key: string) {
  const n = ((await meta.get<number>(key)) ?? 0) + 1;
  await meta.set(key, n);
  return n;
}

function resolveLine(menu: Menu, outlet: Outlet, inp: NewItemInput, orderId: string, seq: number): OrderItem {
  const cat = menu.categories.find((c) => c.items.some((i) => i.id === inp.itemId));
  const item = cat?.items.find((i) => i.id === inp.itemId);
  if (!item || !cat) throw new Error('Item not in menu');
  const v = inp.variationId ? item.variations.find((x) => x.id === inp.variationId) : undefined;
  const addons = (inp.addonIds ?? []).map((id) => {
    const a = menu.addonGroups.flatMap((g) => g.addons).find((x) => x.id === id)!;
    return { id: a.id, name: a.name, price: a.price };
  });
  return {
    id: inp.id ?? uuid(),
    orderId,
    seq,
    itemId: item.id,
    name: item.name,
    variationId: v?.id ?? null,
    variationName: v?.name ?? null,
    unitPrice: v?.price ?? item.price,
    addons,
    qty: inp.qty,
    note: inp.note ?? null,
    status: 'PENDING',
    taxRateBps: item.taxRateBps,
    taxInclusive: outlet.settings.taxInclusive,
    packagingCharge: item.packagingCharge,
    station: item.station ?? cat.station,
    discount: null,
    kotId: null,
  };
}

export async function createOrderLocal(input: {
  id: string;
  type: OrderType;
  tableId?: string | null;
  tableName?: string | null;
  covers?: number;
  customerPhone?: string;
  customerName?: string;
  deliveryAddress?: string;
  items: NewItemInput[];
}): Promise<Order> {
  const { menu, outlet } = await ctx();
  const n = await nextLocalNumber('local:order');
  const now = new Date().toISOString();
  const order: Order = {
    id: input.id,
    orderNumber: `L-${n}`,
    type: input.type,
    status: 'OPEN',
    tableId: input.type === 'DINE_IN' ? input.tableId ?? null : null,
    tableName: input.type === 'DINE_IN' ? input.tableName ?? null : null,
    customerName: input.customerName ?? null,
    customerPhone: input.customerPhone ?? null,
    deliveryAddress: input.deliveryAddress ?? null,
    covers: input.covers ?? 1,
    notes: null,
    discount: null,
    serviceChargeBps: null,
    deliveryCharge: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    items: input.items.map((it, i) => resolveLine(menu, outlet, it, input.id, i + 1)),
    kots: [],
    bills: [],
    payments: [],
    _local: true,
  };
  await db.orders.put(order);
  return order;
}

async function mutate(orderId: string, fn: (o: Order) => void | Promise<void>): Promise<Order> {
  const o = await db.orders.get(orderId);
  if (!o) throw new Error('Order not found locally');
  await fn(o);
  o.updatedAt = new Date().toISOString();
  o._local = true;
  await db.orders.put(o);
  return o;
}

export async function addItemsLocal(orderId: string, items: NewItemInput[]) {
  const { menu, outlet } = await ctx();
  return mutate(orderId, (o) => {
    const maxSeq = o.items.reduce((m, i) => Math.max(m, i.seq), 0);
    items.forEach((it, i) => o.items.push(resolveLine(menu, outlet, it, orderId, maxSeq + i + 1)));
  });
}

export async function updateItemLocal(orderId: string, orderItemId: string, patch: { qty?: number; note?: string | null; discount?: DiscountSpec | null }) {
  return mutate(orderId, (o) => {
    const it = o.items.find((i) => i.id === orderItemId);
    if (!it) return;
    if (patch.qty !== undefined) {
      if (it.status !== 'PENDING' && patch.qty > it.qty) {
        const maxSeq = o.items.reduce((m, i) => Math.max(m, i.seq), 0);
        o.items.push({ ...it, id: uuid(), qty: patch.qty - it.qty, status: 'PENDING', kotId: null, seq: maxSeq + 1 });
      } else it.qty = patch.qty;
    }
    if (patch.note !== undefined) it.note = patch.note;
    if (patch.discount !== undefined) it.discount = patch.discount;
  });
}

export async function voidItemLocal(orderId: string, orderItemId: string, reason: string, qty?: number) {
  return mutate(orderId, (o) => {
    const it = o.items.find((i) => i.id === orderItemId);
    if (!it) return;
    if (qty && qty < it.qty) {
      it.qty -= qty;
      o.items.push({ ...it, id: uuid(), qty, status: 'VOIDED', voidReason: reason });
    } else {
      it.status = 'VOIDED';
      it.voidReason = reason;
    }
  });
}

export async function removeItemLocal(orderId: string, orderItemId: string) {
  return mutate(orderId, (o) => {
    o.items = o.items.filter((i) => !(i.id === orderItemId && i.status === 'PENDING'));
  });
}

/** Marks pending items SENT and creates local KOT objects (one per station). */
export async function sendKotLocal(orderId: string): Promise<{ order: Order; kots: Kot[] }> {
  const kots: Kot[] = [];
  const order = await mutate(orderId, async (o) => {
    const pending = o.items.filter((i) => i.status === 'PENDING');
    const isEdit = o.kots.some((k) => k.kind !== 'CANCEL');
    const stations = [...new Set(pending.map((i) => i.station))];
    for (const st of stations) {
      const n = await nextLocalNumber('local:kot');
      const k: Kot = {
        id: uuid(),
        orderId,
        kotNumber: `L${n}`,
        station: st,
        kind: isEdit ? 'EDIT' : 'NEW',
        status: 'NEW',
        createdAt: new Date().toISOString(),
        items: pending.filter((i) => i.station === st).map((i) => ({ orderItemId: i.id, name: i.name, variation: i.variationName ?? undefined, qty: i.qty, addons: i.addons.map((a) => a.name), note: i.note ?? undefined })),
      };
      pending.filter((i) => i.station === st).forEach((i) => {
        i.status = 'SENT';
        i.kotId = k.id;
      });
      o.kots.push(k);
      kots.push(k);
    }
  });
  return { order, kots };
}

export async function setDiscountLocal(orderId: string, discount: DiscountSpec | null) {
  return mutate(orderId, (o) => {
    o.discount = discount;
  });
}

export async function updateOrderLocal(orderId: string, patch: Partial<Pick<Order, 'covers' | 'notes' | 'customerName' | 'customerPhone' | 'deliveryAddress' | 'type' | 'serviceChargeBps' | 'deliveryCharge'>>) {
  return mutate(orderId, (o) => {
    Object.assign(o, patch);
  });
}

export async function cancelOrderLocal(orderId: string, reason: string) {
  return mutate(orderId, (o) => {
    o.status = 'CANCELLED';
    o.items.forEach((i) => {
      if (i.status !== 'VOIDED') {
        i.status = 'VOIDED';
        i.voidReason = reason;
      }
    });
  });
}

export function billInputFor(o: Order, outlet: Outlet) {
  const s = outlet.settings;
  return {
    lines: o.items.map((i) => ({
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
    billDiscount: o.discount ?? undefined,
    serviceChargeBps: o.serviceChargeBps ?? s.serviceChargeBps,
    serviceChargeTaxable: s.serviceChargeTaxable,
    serviceChargeTaxRateBps: s.serviceChargeTaxRateBps,
    roundingMode: s.roundingMode,
    applyPackaging: o.type !== 'DINE_IN',
    deliveryCharge: o.type === 'DELIVERY' ? o.deliveryCharge : 0,
  };
}

export async function previewLocal(o: Order) {
  const { outlet } = await ctx();
  return computeBill(billInputFor(o, outlet));
}

export async function createBillLocal(orderId: string, billId: string, deviceId: string): Promise<{ order: Order; bill: Bill; kots: Kot[] }> {
  const { outlet } = await ctx();
  const { kots } = await sendKotLocal(orderId);
  let bill!: Bill;
  const order = await mutate(orderId, async (o) => {
    const existing = o.bills.find((b) => b.status === 'UNPAID');
    const computed = computeBill(billInputFor(o, outlet));
    if (existing) {
      existing.computed = computed;
      existing.grandTotal = computed.grandTotal;
      bill = existing;
    } else {
      const n = await nextLocalNumber('local:bill');
      bill = {
        id: billId,
        orderId,
        billNumber: `OFF-${deviceId}-${n}`,
        provisionalNumber: `OFF-${deviceId}-${n}`,
        status: 'UNPAID',
        computed,
        grandTotal: computed.grandTotal,
        paidTotal: 0,
        createdAt: new Date().toISOString(),
        payments: [],
      };
      o.bills.push(bill);
    }
    o.status = 'BILLED';
  });
  return { order, bill, kots };
}

export async function addPaymentsLocal(orderId: string, billId: string, payments: { id: string; mode: any; amount: number; tendered?: number; reference?: string }[]) {
  return mutate(orderId, (o) => {
    const b = o.bills.find((x) => x.id === billId);
    if (!b) throw new Error('Bill not found locally');
    for (const p of payments) {
      if (o.payments.some((x) => x.id === p.id)) continue;
      const row = { ...p, billId, voided: false, createdAt: new Date().toISOString() };
      o.payments.push(row);
      b.payments = [...(b.payments ?? []), row];
    }
    const paid = o.payments.filter((p) => p.billId === billId && !p.voided).reduce((a, p) => a + p.amount, 0);
    b.paidTotal = Math.min(paid, b.grandTotal);
    if (paid >= b.grandTotal) {
      b.status = 'PAID';
      o.status = 'SETTLED';
    }
  });
}
