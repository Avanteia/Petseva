import { useLiveQuery } from 'dexie-react-hooks';
import { Bike, ShoppingBag, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui';
import { cache, db } from '../lib/db';
import { cn, inrShort, timeAgo } from '../lib/format';
import type { Area, Order, Table } from '../lib/types';

type LiveTable = Table & { live?: Order };

export default function Floor() {
  const nav = useNavigate();
  const floor = useLiveQuery(() => cache.floor(), []) as Area[] | undefined;
  const orders = useLiveQuery(() => db.orders.where('status').anyOf('OPEN', 'BILLED').toArray(), []) ?? [];
  const [areaId, setAreaId] = useState<string>('');
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const areas = useMemo(() => {
    if (!floor) return [];
    // Merge server floor with local order mirror so offline-created orders light the table up immediately.
    const byTable = new Map<string, Order>();
    for (const o of orders) if (o.tableId) byTable.set(o.tableId, o);
    return floor.map((a) => ({
      ...a,
      tables: a.tables.map((t): LiveTable => {
        const live = byTable.get(t.id);
        const status = live ? (live.status === 'BILLED' ? 'BILLED' : 'RUNNING') : t.currentOrderId && orders.length === 0 ? t.status : t.status === 'RESERVED' ? 'RESERVED' : t.currentOrderId ? t.status : 'FREE';
        return { ...t, status, live };
      }),
    }));
  }, [floor, orders]);

  const current = areas.find((a) => a.id === areaId) ?? areas[0];
  const parked = orders.filter((o) => o.type !== 'DINE_IN');

  const open = (t: LiveTable) => {
    if (t.live) nav(`/order/${t.live.id}`);
    else if (t.status === 'FREE' || t.status === 'RESERVED') nav(`/order/new?type=DINE_IN&table=${t.id}`);
  };

  if (!floor) return <div className="p-6 text-slate-400">No floor data cached yet — connect to the server once.</div>;

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
          {areas.map((a) => (
            <button
              key={a.id}
              onClick={() => setAreaId(a.id)}
              className={cn('rounded-lg px-3 py-1.5 text-sm', current?.id === a.id ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-800')}
            >
              {a.name} <span className="ml-1 text-xs opacity-60">{a.tables.filter((t) => t.status !== 'FREE').length}/{a.tables.length}</span>
            </button>
          ))}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => nav('/order/new?type=TAKEAWAY')}>
              <ShoppingBag size={16} /> Takeaway
            </Button>
            <Button variant="outline" onClick={() => nav('/order/new?type=DELIVERY')}>
              <Bike size={16} /> Delivery
            </Button>
          </div>
        </div>
        <div className="scroll-thin grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto p-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {current?.tables.map((t) => (
            <button
              key={t.id}
              onClick={() => open(t)}
              className={cn(
                'flex h-28 flex-col justify-between rounded-xl border p-3 text-left transition active:scale-[0.98]',
                t.status === 'FREE' && 'border-slate-700 bg-slate-900 hover:border-slate-500',
                t.status === 'RUNNING' && 'border-amber-500/60 bg-amber-950/40 hover:bg-amber-950/60',
                t.status === 'BILLED' && 'border-sky-500/60 bg-sky-950/40 hover:bg-sky-950/60',
                t.status === 'RESERVED' && 'border-purple-500/60 bg-purple-950/30',
              )}
            >
              <div className="flex items-start justify-between">
                <span className="text-lg font-bold">{t.name}</span>
                <span className="flex items-center gap-1 text-xs text-slate-400">
                  <Users size={12} /> {t.live?.covers ?? t.capacity}
                </span>
              </div>
              {t.live ? (
                <div className="text-xs">
                  <div className="flex justify-between">
                    <span className={cn(t.status === 'BILLED' ? 'text-sky-300' : 'text-amber-300')}>{t.status === 'BILLED' ? 'Billed' : 'Running'}</span>
                    <span className="text-slate-400">{timeAgo(t.live.createdAt)}</span>
                  </div>
                  <div className="mt-1 flex justify-between font-semibold">
                    <span>{t.live.items.filter((i) => i.status !== 'VOIDED').reduce((n, i) => n + i.qty, 0)} items</span>
                    <span>{inrShort(approx(t.live))}</span>
                  </div>
                  {t.live.items.some((i) => i.status === 'PENDING') && <div className="mt-0.5 text-[10px] text-red-300">KOT pending</div>}
                </div>
              ) : (
                <div className="text-xs text-slate-500">{t.status === 'RESERVED' ? 'Reserved' : 'Free'}</div>
              )}
            </button>
          ))}
        </div>
      </div>
      <aside className="hidden w-64 shrink-0 flex-col border-l border-slate-800 lg:flex">
        <div className="border-b border-slate-800 px-3 py-2 text-sm font-semibold">Takeaway & Delivery</div>
        <div className="scroll-thin flex-1 overflow-y-auto p-2">
          {parked.length === 0 && <div className="p-3 text-xs text-slate-500">No open parcels</div>}
          {parked.map((o) => (
            <button key={o.id} onClick={() => nav(`/order/${o.id}`)} className="mb-2 w-full rounded-lg border border-slate-800 bg-slate-900 p-2 text-left hover:border-slate-600">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold">{o.orderNumber}</span>
                <span className="text-xs text-slate-400">{timeAgo(o.createdAt)}</span>
              </div>
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>
                  {o.type === 'TAKEAWAY' ? 'Takeaway' : 'Delivery'} {o.customerName ? `· ${o.customerName}` : ''}
                </span>
                <span className={o.status === 'BILLED' ? 'text-sky-300' : 'text-amber-300'}>{o.status}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

function approx(o: Order) {
  const b = o.bills.find((b) => b.status === 'UNPAID');
  if (b) return b.grandTotal;
  return o.items.filter((i) => i.status !== 'VOIDED').reduce((n, i) => n + (i.unitPrice + i.addons.reduce((a, x) => a + x.price, 0)) * i.qty, 0);
}
