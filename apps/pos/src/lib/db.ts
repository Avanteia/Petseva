import Dexie, { type Table as DxTable } from 'dexie';
import type { Area, Bill, Kot, Menu, Order, Outlet, Printer, SyncOp } from './types';

/** IndexedDB mirror of everything the POS needs offline + the outbound operation queue. */
export class PosDb extends Dexie {
  meta!: DxTable<{ key: string; value: any }, string>;
  orders!: DxTable<Order, string>;
  ops!: DxTable<SyncOp, string>;
  /** ESC/POS tickets generated offline, flushed to the print endpoint when back online */
  printQueue!: DxTable<{ id: string; station: string; escpos: string; text: string; at: string }, string>;

  constructor() {
    super('rms-pos');
    this.version(1).stores({
      meta: 'key',
      orders: 'id, status, tableId, updatedAt',
      ops: 'id, seq, status',
      printQueue: 'id, at',
    });
  }
}
export const db = new PosDb();

export const meta = {
  get: async <T>(key: string): Promise<T | undefined> => (await db.meta.get(key))?.value,
  set: (key: string, value: unknown) => db.meta.put({ key, value }),
};

export const cache = {
  outlet: () => meta.get<Outlet>('outlet'),
  menu: () => meta.get<Menu>('menu'),
  floor: () => meta.get<Area[]>('floor'),
  printers: () => meta.get<Printer[]>('printers'),
  saveBootstrap: async (b: { outlet: Outlet; menu: Menu; floor: Area[]; openOrders: Order[]; printers: Printer[] }) => {
    await db.transaction('rw', db.meta, db.orders, async () => {
      await meta.set('outlet', b.outlet);
      await meta.set('menu', b.menu);
      await meta.set('floor', b.floor);
      await meta.set('printers', b.printers);
      await meta.set('bootstrapAt', new Date().toISOString());
      // keep local-only orders (not yet synced), replace the rest with the server's view
      const local = await db.orders.filter((o) => !!o._local).toArray();
      const serverIds = new Set(b.openOrders.map((o) => o.id));
      const stale = await db.orders.filter((o) => !o._local && !serverIds.has(o.id) && (o.status === 'OPEN' || o.status === 'BILLED')).primaryKeys();
      await db.orders.bulkDelete(stale);
      await db.orders.bulkPut(b.openOrders.map((o) => ({ ...o, _local: false })));
      await db.orders.bulkPut(local);
    });
  },
};

export type { Bill, Kot };
