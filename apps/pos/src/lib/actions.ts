/**
 * POS command layer: local apply → queue → sync. Each returns the freshest known Order.
 * Throws ApiError-like {code} when the server rejected the op while online (e.g. OVERRIDE_REQUIRED).
 */
import type { DiscountSpec, OrderType, PaymentMode } from '@rms/shared';
import { buildKot, buildReceipt, bytesToBase64, escposToText } from '@rms/shared';
import { cache, db } from './db';
import { uuid } from './format';
import * as L from './localOps';
import { enqueue, queuePrint, refreshOrder, useSync } from './sync';
import type { Bill, Kot, Order } from './types';
import { useAuth } from '../store/auth';

export class OpRejected extends Error {
  code?: string;
  constructor(err: string) {
    let msg = err;
    let code: string | undefined;
    try {
      const j = JSON.parse(err);
      msg = j.message?.message ?? j.message ?? err;
      code = j.code ?? j.message?.code;
    } catch {
      /* plain text */
    }
    super(msg);
    this.code = code;
  }
}

async function run(type: string, payload: any, orderId: string): Promise<Order> {
  const op = await enqueue(type, { ...payload, overrideToken: undefined }, orderId);
  if (op.status === 'REJECTED') {
    // roll the local mirror back to the server's truth (if the order exists there)
    const server = await refreshOrder(orderId);
    if (!server && type === 'ORDER_CREATE') await db.orders.delete(orderId);
    await db.ops.delete(op.id);
    throw new OpRejected(op.error ?? 'Rejected');
  }
  return (await db.orders.get(orderId))!;
}

export const actions = {
  async createOrder(input: { type: OrderType; tableId?: string | null; tableName?: string | null; covers?: number; customerPhone?: string; customerName?: string; deliveryAddress?: string; items: L.NewItemInput[] }) {
    const id = uuid();
    const items = input.items.map((i) => ({ ...i, id: i.id ?? uuid() }));
    await L.createOrderLocal({ ...input, id, items });
    return run('ORDER_CREATE', { id, type: input.type, tableId: input.tableId, covers: input.covers, customerPhone: input.customerPhone, customerName: input.customerName, deliveryAddress: input.deliveryAddress, items, createdAt: new Date().toISOString() }, id);
  },

  async addItems(orderId: string, items: L.NewItemInput[]) {
    const withIds = items.map((i) => ({ ...i, id: i.id ?? uuid() }));
    await L.addItemsLocal(orderId, withIds);
    return run('ORDER_ADD_ITEMS', { orderId, items: withIds }, orderId);
  },

  async updateItem(orderId: string, orderItemId: string, patch: { qty?: number; note?: string | null; discount?: DiscountSpec | null }) {
    const o = await db.orders.get(orderId);
    const it = o?.items.find((i) => i.id === orderItemId);
    // removing an unsent line entirely is a pure local edit until KOT — but the server may already know it, so send a void
    if (it && it.status === 'PENDING' && patch.qty === 0) {
      await L.removeItemLocal(orderId, orderItemId);
      return run('ORDER_VOID_ITEM', { orderId, orderItemId, reason: 'Removed before KOT' }, orderId);
    }
    await L.updateItemLocal(orderId, orderItemId, patch);
    return run('ORDER_UPDATE_ITEM', { orderId, orderItemId, patch }, orderId);
  },

  async voidItem(orderId: string, orderItemId: string, reason: string, qty?: number) {
    await L.voidItemLocal(orderId, orderItemId, reason, qty);
    return run('ORDER_VOID_ITEM', { orderId, orderItemId, reason, qty }, orderId);
  },

  async sendKot(orderId: string): Promise<{ order: Order; kots: Kot[] }> {
    const { kots } = await L.sendKotLocal(orderId);
    const order = await run('KOT_SEND', { orderId }, orderId);
    if (!useSync.getState().online) await printKotsOffline(order, kots);
    return { order, kots };
  },

  async setDiscount(orderId: string, discount: DiscountSpec | null) {
    await L.setDiscountLocal(orderId, discount);
    return run('ORDER_DISCOUNT', { orderId, discount }, orderId);
  },

  async updateOrder(orderId: string, patch: Parameters<typeof L.updateOrderLocal>[1]) {
    await L.updateOrderLocal(orderId, patch);
    return run('ORDER_UPDATE', { orderId, patch }, orderId);
  },

  async cancelOrder(orderId: string, reason: string) {
    await L.cancelOrderLocal(orderId, reason);
    return run('ORDER_CANCEL', { orderId, reason }, orderId);
  },

  async createBill(orderId: string): Promise<{ order: Order; bill: Bill }> {
    const existing = (await db.orders.get(orderId))?.bills.find((b) => b.status === 'UNPAID');
    const billId = existing?.id ?? uuid();
    const { bill, kots } = await L.createBillLocal(orderId, billId, useAuth.getState().deviceId);
    const order = await run('BILL_CREATE', { orderId, billId, provisionalNumber: bill.provisionalNumber }, orderId);
    if (!useSync.getState().online) await printKotsOffline(order, kots);
    const serverBill = order.bills.find((b) => b.id === billId) ?? order.bills.find((b) => b.status === 'UNPAID') ?? bill;
    return { order, bill: serverBill };
  },

  async addPayments(orderId: string, billId: string, payments: { mode: PaymentMode; amount: number; tendered?: number; reference?: string }[]) {
    const withIds = payments.map((p) => ({ ...p, id: uuid() }));
    await L.addPaymentsLocal(orderId, billId, withIds);
    return run('PAYMENT_ADD', { billId, payments: withIds }, orderId);
  },

  /** Direct (online-only) server calls that don't make sense offline. */
  transfer: (orderId: string, tableId: string) => import('./api').then(({ api }) => api<Order>('POST', `/orders/${orderId}/transfer`, { tableId })).then(saveServerOrder),
  merge: (fromId: string, intoId: string) => import('./api').then(({ api }) => api<Order>('POST', `/orders/${fromId}/merge-into/${intoId}`)).then(saveServerOrder),
  split: (orderId: string, parts: { orderItemId: string; qty: number }[]) => import('./api').then(({ api }) => api<Order>('POST', `/orders/${orderId}/split`, { parts })).then(saveServerOrder),
  voidBill: (billId: string, reason: string) => import('./api').then(({ api }) => api<Order>('POST', `/bills/${billId}/void`, { reason })).then(saveServerOrder),
};

async function saveServerOrder(o: Order) {
  await db.orders.put({ ...o, _local: false });
  return o;
}

/** Offline: generate the ESC/POS bytes locally so the ticket can be browser-printed now and pushed to the network printer later. */
async function printKotsOffline(order: Order, kots: Kot[]) {
  const printers = (await cache.printers()) ?? [];
  for (const k of kots) {
    const width = printers.find((p) => p.station === k.station)?.width ?? 42;
    const bytes = buildKot({ outletName: '', kotNumber: k.kotNumber, orderNumber: order.orderNumber, orderType: order.type, tableName: order.tableName ?? undefined, station: k.station, createdAt: k.createdAt, items: k.items, isEdit: k.kind === 'EDIT' }, width).build();
    await queuePrint(k.station, bytesToBase64(bytes), escposToText(bytes));
  }
}

/** Build a receipt preview from the local order (used offline and for instant preview). */
export async function localReceipt(order: Order, bill: Bill, duplicate = false) {
  const outlet = (await cache.outlet())!;
  const user = useAuth.getState().user;
  const payments = order.payments.filter((p) => p.billId === bill.id && !p.voided);
  const tendered = payments.reduce((a, p) => a + (p.tendered ?? p.amount), 0);
  const data = {
    outlet: { name: outlet.name, addressLines: outlet.addressLines, phone: outlet.phone ?? undefined, gstin: outlet.gstin ?? undefined, fssai: outlet.fssai ?? undefined, header: outlet.settings.receiptHeader || undefined, footer: outlet.settings.receiptFooter || undefined },
    billNumber: bill.billNumber,
    provisional: !!bill.provisionalNumber && bill.billNumber === bill.provisionalNumber,
    orderNumber: order.orderNumber,
    orderType: order.type,
    tableName: order.tableName ?? undefined,
    customerName: order.customerName ?? undefined,
    customerPhone: order.customerPhone ?? undefined,
    cashier: user?.name ?? 'POS',
    createdAt: bill.createdAt,
    bill: bill.computed,
    lineMeta: order.items.map((i) => ({ id: i.id, addons: i.addons.map((a) => a.name) })),
    payments: payments.map((p) => ({ mode: p.mode, amount: p.amount, reference: p.reference ?? undefined })),
    change: Math.max(0, tendered - bill.grandTotal) || undefined,
    duplicate,
  };
  const width = ((await cache.printers()) ?? []).find((p) => p.station === 'BILL')?.width ?? 42;
  const bytes = buildReceipt(data, width).build();
  return { escpos: bytesToBase64(bytes), text: escposToText(bytes) };
}
