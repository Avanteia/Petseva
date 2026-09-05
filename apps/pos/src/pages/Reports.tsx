import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { inr } from '../lib/format';
import { useSync } from '../lib/sync';

export default function Reports() {
  const online = useSync((s) => s.online);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api('GET', '/reports/summary')
      .then(setData)
      .catch((e) => setErr(e.message));
    const t = setInterval(() => api('GET', '/reports/summary').then(setData).catch(() => undefined), 30000);
    return () => clearInterval(t);
  }, [online]);
  if (err && !data) return <div className="p-6 text-slate-400">Dashboard needs a connection. ({err})</div>;
  if (!data) return <div className="p-6 text-slate-400">Loading…</div>;
  const Stat = ({ label, value }: { label: string; value: string }) => (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="text-xs uppercase text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      <h1 className="mb-3 text-lg font-semibold">Today</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sales" value={inr(data.sales)} />
        <Stat label="Bills" value={String(data.billCount)} />
        <Stat label="Avg bill" value={inr(data.avgOrderValue)} />
        <Stat label="GST collected" value={inr(data.tax)} />
        <Stat label="Discounts" value={inr(data.discount)} />
        <Stat label="Cancelled orders" value={String(data.cancelledOrders)} />
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <Panel title="By payment mode" rows={data.byMode.map((m: any) => [m.mode, inr(m.amount)])} />
        <Panel title="By order type" rows={data.byType.map((t: any) => [`${t.type.replace('_', '-')} (${t.count})`, inr(t.amount)])} />
        <Panel title="Top items" rows={data.topItems.map((t: any) => [`${t.name} × ${t.qty}`, inr(t.amount)])} />
      </div>
      <p className="mt-4 text-xs text-slate-500">Full reporting (item/category/time-slot/tax/staff, CSV & PDF export, date ranges) lands in Phase 2.</p>
    </div>
  );
}

function Panel({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900">
      <div className="border-b border-slate-800 px-4 py-2 text-sm font-semibold">{title}</div>
      <div className="p-2 text-sm">
        {rows.length === 0 && <div className="p-2 text-slate-500">—</div>}
        {rows.map(([a, b], i) => (
          <div key={i} className="flex justify-between px-2 py-1">
            <span className="text-slate-300">{a}</span>
            <span>{b}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
