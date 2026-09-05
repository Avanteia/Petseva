import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Badge, Button, Input, Modal } from '../../components/ui';
import { api } from '../../lib/api';
import { cache } from '../../lib/db';
import { cn, FOOD_DOT, inr } from '../../lib/format';
import { refreshMenu } from '../../lib/sync';
import type { MenuItem } from '../../lib/types';
import { toast } from '../../store/toast';

/** Menu admin: quick availability / stock-out toggles, price + item editor, CSV import/export. */
export default function AdminMenu() {
  const menu = useLiveQuery(() => cache.menu(), []);
  const [edit, setEdit] = useState<Partial<MenuItem> & { categoryId?: string } | null>(null);
  const [q, setQ] = useState('');
  const [csv, setCsv] = useState<string | null>(null);
  if (!menu) return null;

  const flag = async (i: MenuItem, patch: { available?: boolean; stockOut?: boolean }) => {
    try {
      await api('PATCH', `/menu/items/${i.id}/flags`, patch);
      await refreshMenu();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };
  const save = async () => {
    if (!edit) return;
    try {
      await api('POST', '/menu/items', {
        id: edit.id,
        categoryId: edit.categoryId,
        name: edit.name,
        shortCode: edit.shortCode,
        foodType: edit.foodType ?? 'VEG',
        price: edit.price ?? 0,
        taxSlabId: edit.taxSlabId,
        packagingCharge: edit.packagingCharge ?? 0,
        variations: edit.variations?.map((v) => ({ name: v.name, price: v.price, isDefault: v.isDefault })),
        addonGroupIds: edit.addonGroupIds,
      });
      await refreshMenu();
      setEdit(null);
      toast('Saved', 'ok');
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };
  const exportCsv = async () => {
    const { token } = (await import('../../store/auth')).useAuth.getState();
    const res = await fetch('/api/menu/export.csv', { headers: { authorization: `Bearer ${token}` } });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'menu.csv';
    a.click();
  };
  const importCsv = async () => {
    if (!csv) return;
    try {
      const r = await api('POST', '/menu/import', { csv });
      toast(`Imported: ${r.created} created, ${r.updated} updated`, 'ok');
      await refreshMenu();
      setCsv(null);
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };
  const rows = menu.categories.flatMap((c) => c.items.map((i) => ({ ...i, category: c.name }))).filter((i) => !q || i.name.toLowerCase().includes(q.toLowerCase()) || i.category.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
        <h1 className="font-semibold">Menu</h1>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" className="w-56" />
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={exportCsv}>Export CSV</Button>
          <Button variant="outline" onClick={() => setCsv('')}>Import CSV</Button>
          <Button variant="primary" onClick={() => setEdit({ categoryId: menu.categories[0]?.id, foodType: 'VEG', price: 0, variations: [], addonGroupIds: [] })}>+ Item</Button>
        </div>
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-900 text-left text-xs uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Station</th>
              <th className="px-3 py-2 text-right">Price</th>
              <th className="px-3 py-2">GST</th>
              <th className="px-3 py-2">Available</th>
              <th className="px-3 py-2">In stock</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} className="border-b border-slate-800/60">
                <td className="px-3 py-1.5">
                  <span className={cn('mr-2 inline-block h-2 w-2 rounded-sm', FOOD_DOT[i.foodType])} />
                  {i.name} <span className="text-xs text-slate-500">{i.shortCode}</span>
                  {i.variations.length > 0 && <span className="ml-1 text-xs text-slate-500">({i.variations.map((v) => v.name).join('/')})</span>}
                </td>
                <td className="px-3 py-1.5 text-slate-400">{i.category}</td>
                <td className="px-3 py-1.5 text-slate-400">{i.station}</td>
                <td className="px-3 py-1.5 text-right">{inr(i.price)}</td>
                <td className="px-3 py-1.5 text-slate-400">{i.taxRateBps / 100}%</td>
                <td className="px-3 py-1.5">
                  <Toggle on={i.available} onChange={(v) => flag(i, { available: v })} />
                </td>
                <td className="px-3 py-1.5">
                  <Toggle on={!i.stockOut} onChange={(v) => flag(i, { stockOut: !v })} />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEdit({ ...i })}>Edit</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Edit item' : 'New item'} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="col-span-2">Name<Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label>Category<select className="h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-2" value={edit.categoryId} onChange={(e) => setEdit({ ...edit, categoryId: e.target.value })}>{menu.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label>Short code<Input value={edit.shortCode ?? ''} onChange={(e) => setEdit({ ...edit, shortCode: e.target.value })} /></label>
            <label>Price (₹)<Input type="number" value={(edit.price ?? 0) / 100} onChange={(e) => setEdit({ ...edit, price: Math.round(Number(e.target.value) * 100) })} /></label>
            <label>Packaging (₹)<Input type="number" value={(edit.packagingCharge ?? 0) / 100} onChange={(e) => setEdit({ ...edit, packagingCharge: Math.round(Number(e.target.value) * 100) })} /></label>
            <label>Food type<select className="h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-2" value={edit.foodType} onChange={(e) => setEdit({ ...edit, foodType: e.target.value as any })}><option value="VEG">Veg</option><option value="NON_VEG">Non-veg</option><option value="EGG">Egg</option></select></label>
            <label>GST slab<select className="h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-2" value={edit.taxSlabId ?? ''} onChange={(e) => setEdit({ ...edit, taxSlabId: e.target.value || null })}><option value="">None</option>{menu.taxSlabs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <div className="col-span-2">
              <div className="mb-1 flex items-center justify-between"><span>Variations</span><Button size="sm" onClick={() => setEdit({ ...edit, variations: [...(edit.variations ?? []), { id: '', name: '', price: edit.price ?? 0, isDefault: !(edit.variations ?? []).length }] })}>+ Add</Button></div>
              {(edit.variations ?? []).map((v, i) => (
                <div key={i} className="mb-1 flex gap-2">
                  <Input value={v.name} placeholder="Half" onChange={(e) => setEdit({ ...edit, variations: edit.variations!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <Input type="number" value={v.price / 100} onChange={(e) => setEdit({ ...edit, variations: edit.variations!.map((x, j) => (j === i ? { ...x, price: Math.round(Number(e.target.value) * 100) } : x)) })} className="w-28" />
                  <Button size="sm" variant="ghost" onClick={() => setEdit({ ...edit, variations: edit.variations!.filter((_, j) => j !== i) })}>✕</Button>
                </div>
              ))}
            </div>
            <div className="col-span-2">
              <div className="mb-1">Add-on groups</div>
              <div className="flex flex-wrap gap-1.5">
                {menu.addonGroups.map((g) => {
                  const on = edit.addonGroupIds?.includes(g.id);
                  return (
                    <button key={g.id} onClick={() => setEdit({ ...edit, addonGroupIds: on ? edit.addonGroupIds!.filter((x) => x !== g.id) : [...(edit.addonGroupIds ?? []), g.id] })} className={cn('rounded-lg border px-2 py-1 text-xs', on ? 'border-brand-500 text-brand-400' : 'border-slate-700')}>
                      {g.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Modal>
      )}
      {csv !== null && (
        <Modal open onClose={() => setCsv(null)} title="Import menu CSV" footer={<><Button variant="ghost" onClick={() => setCsv(null)}>Cancel</Button><Button variant="primary" onClick={importCsv}>Import</Button></>}>
          <p className="mb-2 text-xs text-slate-400">Columns: category, name, short_code, food_type, price_rupees, tax_rate_pct, packaging_rupees, available, variations (Half:250|Full:420). Export first to get a template.</p>
          <textarea value={csv} onChange={(e) => setCsv(e.target.value)} className="h-64 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-xs" />
        </Modal>
      )}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className={cn('h-6 w-11 rounded-full p-0.5 transition', on ? 'bg-emerald-600' : 'bg-slate-700')}>
      <span className={cn('block h-5 w-5 rounded-full bg-white transition', on ? 'translate-x-5' : '')} />
    </button>
  );
}
export { Badge };
