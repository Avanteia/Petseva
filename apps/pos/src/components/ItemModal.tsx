import { useEffect, useState } from 'react';
import { cn, inr } from '../lib/format';
import type { Menu, MenuItem } from '../lib/types';
import { Button, Input, Modal } from './ui';

export interface DraftLine {
  key: string;
  itemId: string;
  name: string;
  variationId: string | null;
  variationName: string | null;
  unitPrice: number;
  addons: { id: string; name: string; price: number }[];
  qty: number;
  note: string;
  station: string;
  taxRateBps: number;
  packagingCharge: number;
}

/** Variation / add-on / note picker. Also used to edit note+qty of a draft line. */
export function ItemModal({ item, menu, initial, onClose, onAdd }: { item: MenuItem | null; menu: Menu; initial?: DraftLine; onClose: () => void; onAdd: (line: Omit<DraftLine, 'key'>) => void }) {
  const [variationId, setVar] = useState<string | null>(null);
  const [addonIds, setAddons] = useState<string[]>([]);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!item) return;
    setVar(initial?.variationId ?? item.variations.find((v) => v.isDefault)?.id ?? item.variations[0]?.id ?? null);
    setAddons(initial?.addons.map((a) => a.id) ?? []);
    setQty(initial?.qty ?? 1);
    setNote(initial?.note ?? '');
  }, [item, initial]);
  if (!item) return null;
  const groups = menu.addonGroups.filter((g) => item.addonGroupIds.includes(g.id));
  const v = item.variations.find((x) => x.id === variationId);
  const addons = groups.flatMap((g) => g.addons).filter((a) => addonIds.includes(a.id));
  const unit = (v?.price ?? item.price) + addons.reduce((s, a) => s + a.price, 0);
  const toggle = (gid: string, aid: string, max: number) => {
    const g = groups.find((x) => x.id === gid)!;
    const inGroup = addonIds.filter((id) => g.addons.some((a) => a.id === id));
    if (addonIds.includes(aid)) return setAddons(addonIds.filter((x) => x !== aid));
    if (max === 1) return setAddons([...addonIds.filter((id) => !inGroup.includes(id)), aid]);
    if (inGroup.length >= max) return;
    setAddons([...addonIds, aid]);
  };
  const submit = () => {
    onAdd({
      itemId: item.id,
      name: item.name,
      variationId: v?.id ?? null,
      variationName: v?.name ?? null,
      unitPrice: v?.price ?? item.price,
      addons: addons.map((a) => ({ id: a.id, name: a.name, price: a.price })),
      qty,
      note,
      station: item.station,
      taxRateBps: item.taxRateBps,
      packagingCharge: item.packagingCharge,
    });
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={item.name}
      footer={
        <>
          <div className="mr-auto flex items-center gap-2">
            <Button size="sm" onClick={() => setQty(Math.max(1, qty - 1))}>
              −
            </Button>
            <span className="w-8 text-center font-semibold">{qty}</span>
            <Button size="sm" onClick={() => setQty(qty + 1)}>
              +
            </Button>
          </div>
          <Button variant="primary" onClick={submit} autoFocus>
            {initial ? 'Update' : 'Add'} · {inr(unit * qty)}
          </Button>
        </>
      }
    >
      {item.variations.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-xs font-semibold uppercase text-slate-400">Variation</div>
          <div className="flex flex-wrap gap-2">
            {item.variations.map((x) => (
              <button key={x.id} onClick={() => setVar(x.id)} className={cn('rounded-lg border px-3 py-2 text-sm', variationId === x.id ? 'border-brand-500 bg-brand-500/10 text-brand-400' : 'border-slate-700 hover:border-slate-500')}>
                {x.name} <span className="ml-1 text-xs opacity-70">{inr(x.price)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.id} className="mb-4">
          <div className="mb-2 text-xs font-semibold uppercase text-slate-400">
            {g.name} <span className="font-normal normal-case opacity-60">(max {g.maxSelect})</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {g.addons.map((a) => (
              <button key={a.id} onClick={() => toggle(g.id, a.id, g.maxSelect)} className={cn('rounded-lg border px-3 py-2 text-sm', addonIds.includes(a.id) ? 'border-brand-500 bg-brand-500/10 text-brand-400' : 'border-slate-700 hover:border-slate-500')}>
                {a.name} {a.price > 0 && <span className="ml-1 text-xs opacity-70">+{inr(a.price)}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div>
        <div className="mb-2 text-xs font-semibold uppercase text-slate-400">Note for kitchen</div>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder='e.g. "no onion", "extra crispy"' onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <div className="mt-2 flex flex-wrap gap-1">
          {['No onion', 'No garlic', 'Less spicy', 'Extra spicy', 'Jain', 'Less oil'].map((q) => (
            <button key={q} onClick={() => setNote(note ? `${note}, ${q}` : q)} className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:border-slate-500">
              {q}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
