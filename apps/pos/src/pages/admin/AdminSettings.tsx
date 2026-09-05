import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { ReceiptModal } from '../../components/ReceiptModal';
import { Button, Input } from '../../components/ui';
import { api } from '../../lib/api';
import { cache } from '../../lib/db';
import { bootstrap } from '../../lib/sync';
import type { Printer } from '../../lib/types';
import { toast } from '../../store/toast';

export default function AdminSettings() {
  const outlet = useLiveQuery(() => cache.outlet(), []);
  const printers = useLiveQuery(() => cache.printers(), []) as Printer[] | undefined;
  const [form, setForm] = useState<any>(null);
  const [test, setTest] = useState<string | null>(null);
  useEffect(() => {
    if (outlet && !form) setForm({ name: outlet.name, addressLines: outlet.addressLines.join('\n'), phone: outlet.phone ?? '', ...outlet.settings, gstin: outlet.gstin ?? '', fssai: outlet.fssai ?? '' });
  }, [outlet]);
  if (!outlet || !form) return null;
  const save = async () => {
    try {
      const { name, addressLines, phone, gstin, fssai, ...settings } = form;
      await api('PATCH', '/outlets/me/settings', { name, addressLines: addressLines.split('\n').filter(Boolean), phone, gstin, fssai, ...settings, serviceChargeBps: Number(settings.serviceChargeBps), cashierMaxDiscountBps: Number(settings.cashierMaxDiscountBps), serviceChargeTaxRateBps: Number(settings.serviceChargeTaxRateBps) });
      await bootstrap();
      toast('Settings saved', 'ok');
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };
  const F = ({ k, label, type = 'text' }: { k: string; label: string; type?: string }) => (
    <label className="text-sm">
      {label}
      <Input type={type} value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: type === 'number' ? Number(e.target.value) : e.target.value })} />
    </label>
  );
  const Sel = ({ k, label, opts }: { k: string; label: string; opts: [string, string][] }) => (
    <label className="text-sm">
      {label}
      <select className="h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm" value={String(form[k])} onChange={(e) => setForm({ ...form, [k]: e.target.value === 'true' ? true : e.target.value === 'false' ? false : e.target.value })}>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      <h1 className="mb-3 font-semibold">Outlet settings</h1>
      <div className="grid max-w-3xl grid-cols-2 gap-3">
        <F k="name" label="Outlet name" />
        <F k="phone" label="Phone" />
        <label className="col-span-2 text-sm">Address (one line per row)<textarea value={form.addressLines} onChange={(e) => setForm({ ...form, addressLines: e.target.value })} className="h-16 w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-sm" /></label>
        <F k="gstin" label="GSTIN" />
        <F k="fssai" label="FSSAI" />
        <Sel k="taxInclusive" label="Menu prices are" opts={[['false', 'Exclusive of GST (tax added on bill)'], ['true', 'Inclusive of GST']]} />
        <Sel k="roundingMode" label="Round-off" opts={[['NEAREST_RUPEE', 'Nearest rupee'], ['NEAREST_50P', 'Nearest 50 paise'], ['UP_RUPEE', 'Always up'], ['DOWN_RUPEE', 'Always down'], ['NONE', 'None']]} />
        <F k="serviceChargeBps" label="Service charge (bps, 1000 = 10%)" type="number" />
        <Sel k="serviceChargeTaxable" label="Service charge taxable?" opts={[['false', 'No'], ['true', 'Yes (18%)']]} />
        <F k="cashierMaxDiscountBps" label="Cashier discount limit (bps)" type="number" />
        <F k="billPrefix" label="Bill number prefix" />
        <F k="receiptHeader" label="Receipt header line" />
        <F k="receiptFooter" label="Receipt footer" />
        <div className="col-span-2 flex gap-2">
          <Button variant="primary" onClick={save}>Save</Button>
        </div>
      </div>
      <h2 className="mb-2 mt-6 font-semibold">Printers</h2>
      <p className="mb-2 text-xs text-slate-400">Network ESC/POS printers (port 9100). With PRINT_DRY_RUN=true on the server, tickets are previewed instead of sent; the POS always offers browser printing as a fallback.</p>
      <div className="max-w-3xl">
        {(printers ?? []).map((p) => (
          <div key={p.id} className="flex items-center gap-3 border-b border-slate-800 py-2 text-sm">
            <span className="w-40 font-medium">{p.name}</span>
            <span className="w-24 text-slate-400">{p.station}</span>
            <span className="text-slate-400">{p.kind === 'NETWORK' ? `${p.host}:${p.port}` : p.kind} · {p.width} cols</span>
            <Button size="sm" className="ml-auto" onClick={() => api('POST', '/print/test', { station: p.station }).then((r) => { setTest(r.text); toast(r.dryRun ? 'Dry-run: preview only' : r.ok ? 'Sent to printer' : `Printer error: ${r.error}`, r.ok ? 'ok' : 'err'); }).catch((e) => toast(e.message, 'err'))}>Test</Button>
          </div>
        ))}
      </div>
      <ReceiptModal text={test} title="Printer test" onClose={() => setTest(null)} />
    </div>
  );
}
