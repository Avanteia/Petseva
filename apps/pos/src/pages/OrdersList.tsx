import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ReceiptModal } from '../components/ReceiptModal';
import { Badge, Button, Input } from '../components/ui';
import { api } from '../lib/api';
import { db } from '../lib/db';
import { cn, fmtTime, inr } from '../lib/format';
import { useSync } from '../lib/sync';
import type { Order } from '../lib/types';
import { toast } from '../store/toast';

const TONE: Record<string, 'amber' | 'blue' | 'green' | 'red'> = { OPEN: 'amber', BILLED: 'blue', SETTLED: 'green', CANCELLED: 'red' };

/** Running + recent orders. Live ones come from the local mirror (works offline); history is fetched when online. */
export default function OrdersList() {
  const nav = useNavigate();
  const online = useSync((s) => s.online);
  const local = useLiveQuery(() => db.orders.orderBy('updatedAt').reverse().toArray(), []) ?? [];
  const [remote, setRemote] = useState<Order[]>([]);
  const [tab, setTab] = useState<'live' | 'history'>('live');
  const [q, setQ] = useState('');
  const [receipt, setReceipt] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== 'history' || !online) return;
    api<Order[]>('GET', '/orders?limit=100').then(setRemote).catch(() => undefined);
  }, [tab, online]);

  const rows = (tab === 'live' ? local.filter((o) => o.status === 'OPEN' || o.status === 'BILLED') : remote).filter((o) => !q || o.orderNumber.includes(q) || o.tableName?.toLowerCase().includes(q.toLowerCase()) || o.customerPhone?.includes(q));

  const reprint = async (o: Order) => {
    const b = o.bills.find((x) => x.status === 'PAID') ?? o.bills[0];
    if (!b) return toast('No bill yet', 'err');
    try {
      const r = await api('POST', `/bills/${b.id}/print`, { reprint: true });
      setReceipt(r.text);
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
        {(['live', 'history'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cn('rounded-lg px-3 py-1.5 text-sm capitalize', tab === t ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-800')}>
            {t === 'live' ? 'Running' : 'History'}
          </button>
        ))}
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order # / table / phone" className="ml-auto w-64" />
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-900 text-left text-xs uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2">Order</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const bill = o.bills.find((b) => b.status !== 'VOID');
              return (
                <tr key={o.id} className="border-b border-slate-800/60 hover:bg-slate-900">
                  <td className="px-3 py-2 font-semibold">
                    {o.orderNumber} {o.tableName && <span className="font-normal text-slate-400">· {o.tableName}</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{o.type.replace('_', '-')}</td>
                  <td className="px-3 py-2 text-slate-300">{o.customerName ?? o.customerPhone ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-400">{fmtTime(o.createdAt)}</td>
                  <td className="px-3 py-2">
                    <Badge tone={TONE[o.status]}>{o.status}</Badge> {bill && <span className="ml-1 text-xs text-slate-400">{bill.billNumber}</span>}
                  </td>
                  <td className="px-3 py-2 text-right">{bill ? inr(bill.grandTotal) : ''}</td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => nav(`/order/${o.id}`)}>
                      Open
                    </Button>{' '}
                    {bill && (
                      <Button size="sm" variant="ghost" onClick={() => reprint(o)}>
                        Reprint
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-slate-500">
                  {tab === 'history' && !online ? 'History needs a connection' : 'No orders'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ReceiptModal text={receipt} title="Duplicate bill" onClose={() => setReceipt(null)} />
    </div>
  );
}
