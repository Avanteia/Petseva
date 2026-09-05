/**
 * Sync engine: the POS never talks to the server directly for order mutations.
 * Every mutation = (1) apply locally → (2) append to the op queue → (3) flush.
 * Online, flush completes in the same tick so the UI gets the server's authoritative state
 * (bill numbers, conflicts). Offline, the op waits; the local state is what the cashier sees.
 */
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import { api, OfflineError } from './api';
import { cache, db, meta } from './db';
import { uuid } from './format';
import type { Order, SyncOp } from './types';
import { useAuth } from '../store/auth';

interface SyncState {
  online: boolean;
  pending: number;
  rejected: number;
  syncing: boolean;
  lastSyncAt: string | null;
  bootstrapped: boolean;
  set: (p: Partial<SyncState>) => void;
}
export const useSync = create<SyncState>((set) => ({ online: navigator.onLine, pending: 0, rejected: 0, syncing: false, lastSyncAt: null, bootstrapped: false, set }));

let flushing: Promise<void> | null = null;
let socket: Socket | null = null;
let seqCounter = 0;

async function refreshCounts() {
  const [pending, rejected] = await Promise.all([db.ops.where('status').equals('PENDING').count(), db.ops.where('status').equals('REJECTED').count()]);
  useSync.getState().set({ pending, rejected });
}

export async function bootstrap(): Promise<boolean> {
  try {
    const b = await api('GET', '/sync/bootstrap', undefined, { timeoutMs: 15000 });
    await cache.saveBootstrap(b);
    useSync.getState().set({ online: true, bootstrapped: true, lastSyncAt: new Date().toISOString() });
    connectSocket();
    void flush();
    return true;
  } catch (e) {
    const hasCache = !!(await cache.menu());
    useSync.getState().set({ online: !(e instanceof OfflineError), bootstrapped: hasCache });
    await refreshCounts();
    return hasCache;
  }
}

export async function refreshOrder(id: string): Promise<Order | null> {
  try {
    const o = await api<Order>('GET', `/orders/${id}`);
    await db.orders.put({ ...o, _local: false });
    return o;
  } catch (e) {
    if (e instanceof OfflineError) useSync.getState().set({ online: false });
    return null;
  }
}

export async function refreshFloor() {
  try {
    const floor = await api('GET', '/floor');
    await meta.set('floor', floor);
  } catch (e) {
    if (e instanceof OfflineError) useSync.getState().set({ online: false });
  }
}

export async function refreshMenu() {
  try {
    await meta.set('menu', await api('GET', '/menu'));
  } catch {
    /* offline */
  }
}

/** Queue an op (already applied locally) and try to flush right away. Resolves once the op reached the server or we are offline. */
export async function enqueue(type: string, payload: any, orderId?: string): Promise<SyncOp> {
  const op: SyncOp = { id: uuid(), seq: Date.now() * 1000 + (seqCounter++ % 1000), type, payload, at: new Date().toISOString(), status: 'PENDING', orderId };
  await db.ops.put(op);
  await refreshCounts();
  await flush();
  return (await db.ops.get(op.id)) ?? op;
}

export function flush(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const st = useSync.getState();
    st.set({ syncing: true });
    try {
      for (;;) {
        const batch = await db.ops.where('status').equals('PENDING').sortBy('seq');
        if (!batch.length) break;
        const ops = batch.slice(0, 25);
        let res: { results: { id: string; status: string; error?: string; response?: any }[] };
        try {
          res = await api('POST', '/sync/push', { deviceId: useAuth.getState().deviceId, ops: ops.map(({ id, type, payload, at }) => ({ id, type, payload, at })) }, { timeoutMs: 20000 });
        } catch (e) {
          if (e instanceof OfflineError) {
            st.set({ online: false });
            return;
          }
          // auth / server error → leave ops pending, surface once
          console.warn('sync push failed', e);
          return;
        }
        st.set({ online: true, lastSyncAt: new Date().toISOString() });
        const touched = new Set<string>();
        for (const r of res.results) {
          const op = ops.find((o) => o.id === r.id)!;
          const status = r.status === 'REJECTED' ? 'REJECTED' : 'APPLIED';
          await db.ops.update(op.id, { status, error: r.error });
          if (op.orderId) touched.add(op.orderId);
          if (r.response?.orderId) touched.add(r.response.orderId);
        }
        for (const id of touched) {
          const o = await refreshOrder(id);
          if (!o) {
            // order never made it to the server (creation rejected) → keep local copy but flag it
            const local = await db.orders.get(id);
            if (local) await db.orders.put({ ...local, _local: true });
          }
        }
        await refreshFloor();
        await refreshCounts();
      }
      await flushPrintQueue();
    } finally {
      st.set({ syncing: false });
      flushing = null;
    }
  })();
  return flushing;
}

export async function queuePrint(station: string, escpos: string, text: string) {
  await db.printQueue.put({ id: uuid(), station, escpos, text, at: new Date().toISOString() });
}

async function flushPrintQueue() {
  const jobs = await db.printQueue.orderBy('at').toArray();
  for (const j of jobs) {
    try {
      await api('POST', '/print/raw', { station: j.station, escpos: j.escpos });
      await db.printQueue.delete(j.id);
    } catch (e) {
      if (e instanceof OfflineError) return;
      await db.printQueue.delete(j.id); // permanent failure – don't loop forever
    }
  }
}

export async function retryRejected(opId?: string) {
  if (opId) await db.ops.update(opId, { status: 'PENDING', error: undefined });
  else await db.ops.where('status').equals('REJECTED').modify({ status: 'PENDING', error: undefined });
  await refreshCounts();
  await flush();
}

export async function discardRejected(opId: string) {
  const op = await db.ops.get(opId);
  await db.ops.delete(opId);
  if (op?.orderId) {
    const server = await refreshOrder(op.orderId);
    if (!server) await db.orders.delete(op.orderId);
  }
  await refreshCounts();
}

export function connectSocket() {
  const { token } = useAuth.getState();
  if (!token) return;
  if (socket) socket.disconnect();
  socket = io(import.meta.env.VITE_API_URL ?? '/', { path: '/ws', auth: { token }, transports: ['websocket', 'polling'] });
  socket.on('connect', () => {
    useSync.getState().set({ online: true });
    void flush();
  });
  socket.on('disconnect', () => useSync.getState().set({ online: navigator.onLine ? useSync.getState().online : false }));
  socket.on('event', async (evt: any) => {
    switch (evt.type) {
      case 'order.updated':
        if (evt.order) {
          const local = await db.orders.get(evt.orderId);
          // don't clobber an order with unsynced local edits
          if (!local?._local) await db.orders.put({ ...evt.order, _local: false });
        }
        break;
      case 'table.updated':
      case 'floor.updated':
        await refreshFloor();
        break;
      case 'menu.updated':
        await refreshMenu();
        break;
    }
  });
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

// browser online/offline hints
window.addEventListener('online', () => {
  useSync.getState().set({ online: true });
  void flush();
});
window.addEventListener('offline', () => useSync.getState().set({ online: false }));
// periodic retry while offline / idle
setInterval(() => {
  if (useAuth.getState().token) void flush();
}, 15000);
