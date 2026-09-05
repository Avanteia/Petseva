import { computeBill, VOID_REASONS } from '@rms/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeftRight, ChefHat, MoreHorizontal, Receipt, Search, Trash2, Wallet } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BillModal } from '../components/BillModal';
import { ItemModal, type DraftLine } from '../components/ItemModal';
import { OverridePin } from '../components/OverridePin';
import { ReceiptModal } from '../components/ReceiptModal';
import { Badge, Button, Input, Modal } from '../components/ui';
import { actions, OpRejected } from '../lib/actions';
import { api } from '../lib/api';
import { cache, db } from '../lib/db';
import { cn, FOOD_DOT, inr, inrShort, uuid } from '../lib/format';
import { billInputFor } from '../lib/localOps';
import { useSync } from '../lib/sync';
import type { Area, MenuItem, Order, OrderItem } from '../lib/types';
import { useAuth } from '../store/auth';
import { toast } from '../store/toast';

export default function OrderPage() {
  const { id: rawId } = useParams();
  const id = rawId === 'new' ? undefined : rawId;
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const type = (sp.get('type') ?? 'DINE_IN') as Order['type'];
  const tableId = sp.get('table');

  const menu = useLiveQuery(() => cache.menu(), []);
  const outlet = useLiveQuery(() => cache.outlet(), []);
  const floor = useLiveQuery(() => cache.floor(), []) as Area[] | undefined;
  const order = useLiveQuery(() => (id ? db.orders.get(id) : undefined), [id]);
  const can = useAuth((s) => s.can);
  const online = useSync((s) => s.online);

  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [q, setQ] = useState('');
  const [catId, setCatId] = useState<string>('');
  const [modalItem, setModalItem] = useState<MenuItem | null>(null);
  const [editLine, setEditLine] = useState<DraftLine | undefined>();
  const [billMode, setBillMode] = useState<'bill' | 'settle' | null>(null);
  const [voidTarget, setVoidTarget] = useState<OrderItem | null>(null);
  const [more, setMore] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<null | (() => void)>(null);
  const [busy, setBusy] = useState(false);
  const [covers, setCovers] = useState(2);
  const [phone, setPhone] = useState('');
  const [custName, setCustName] = useState('');
  const [address, setAddress] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const table = useMemo(() => floor?.flatMap((a) => a.tables).find((t) => t.id === (order?.tableId ?? tableId)), [floor, order, tableId]);

  useEffect(() => {
    if (order) {
      setCovers(order.covers);
      setPhone(order.customerPhone ?? '');
      setCustName(order.customerName ?? '');
      setAddress(order.deliveryAddress ?? '');
    }
  }, [order?.id]);

  // menu filtering (time-based categories hidden unless searching)
  const nowOk = (c: Area | any) => {
    if (!c.availability?.length) return true;
    const d = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const dow = d.getDay() === 0 ? 7 : d.getDay();
    return c.availability.some((w: any) => w.days.includes(dow) && w.from <= hm && hm <= w.to);
  };
  const categories = useMemo(() => (menu?.categories ?? []).filter((c) => c.items.length && (q || nowOk(c))), [menu, q]);
  const items = useMemo(() => {
    if (!menu) return [];
    const all = categories.flatMap((c) => c.items);
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      return all.filter((i) => i.name.toLowerCase().includes(s) || i.shortCode?.toLowerCase() === s || i.shortCode?.toLowerCase().startsWith(s)).sort((a, b) => (a.shortCode?.toLowerCase() === s ? -1 : b.shortCode?.toLowerCase() === s ? 1 : 0));
    }
    const c = categories.find((c) => c.id === catId) ?? categories[0];
    return c?.items ?? [];
  }, [menu, categories, catId, q]);

  // ---- draft helpers
  const addLine = (l: Omit<DraftLine, 'key'>) => {
    setDraft((d) => {
      const same = d.find((x) => x.itemId === l.itemId && x.variationId === l.variationId && x.note === l.note && JSON.stringify(x.addons.map((a) => a.id)) === JSON.stringify(l.addons.map((a) => a.id)));
      if (same) return d.map((x) => (x === same ? { ...x, qty: x.qty + l.qty } : x));
      return [...d, { ...l, key: uuid() }];
    });
  };
  const tapItem = (i: MenuItem) => {
    if (!i.available || i.stockOut) return toast(`${i.name} is not available`, 'err');
    if (i.variations.length || i.addonGroupIds.length) setModalItem(i);
    else addLine({ itemId: i.id, name: i.name, variationId: null, variationName: null, unitPrice: i.price, addons: [], qty: 1, note: '', station: i.station, taxRateBps: i.taxRateBps, packagingCharge: i.packagingCharge });
    setQ('');
  };
  const bumpDraft = (key: string, d: number) => setDraft((ds) => ds.map((x) => (x.key === key ? { ...x, qty: x.qty + d } : x)).filter((x) => x.qty > 0));

  // ---- commit draft → order (create or append)
  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      if ((e instanceof OpRejected && e.code === 'OVERRIDE_REQUIRED') || e?.code === 'OVERRIDE_REQUIRED') setPinFor(() => () => guard(fn));
      else if (e?.code === 'TABLE_RUNNING' && e?.body?.orderId) nav(`/order/${e.body.orderId}`);
      else toast(e?.message ?? 'Failed', 'err');
    } finally {
      setBusy(false);
    }
  }, []);

  const draftInputs = () => draft.map((l) => ({ itemId: l.itemId, variationId: l.variationId, addonIds: l.addons.map((a) => a.id), qty: l.qty, note: l.note || undefined }));

  const commit = async (): Promise<Order> => {
    if (order) {
      if (!draft.length) return order;
      const o = await actions.addItems(order.id, draftInputs());
      setDraft([]);
      return o;
    }
    if (!draft.length) throw new Error('Add at least one item');
    if (type === 'DINE_IN' && !tableId) throw new Error('Pick a table first');
    const o = await actions.createOrder({ type, tableId, tableName: table?.name, covers, customerPhone: phone || undefined, customerName: custName || undefined, deliveryAddress: address || undefined, items: draftInputs() });
    setDraft([]);
    nav(`/order/${o.id}`, { replace: true });
    return o;
  };

  const save = () => guard(async () => { await commit(); toast('Saved', 'ok'); });
  const sendKot = () =>
    guard(async () => {
      const o = await commit();
      const { kots } = await actions.sendKot(o.id);
      toast(kots.length ? `KOT sent (${kots.map((k) => k.station).join(', ')})` : 'Nothing new to send', 'ok');
      if (!online && kots.length) {
        const jobs = await db.printQueue.orderBy('at').reverse().limit(kots.length).toArray();
        setReceipt(jobs.map((j) => j.text).join('\n\n'));
      }
    });
  const openBill = (mode: 'bill' | 'settle') =>
    guard(async () => {
      const o = await commit();
      if (!o.items.some((i) => i.status !== 'VOIDED')) throw new Error('No items to bill');
      setBillMode(mode);
    });

  const changeSentQty = (it: OrderItem, d: number) =>
    guard(async () => {
      if (!order) return;
      if (it.status === 'PENDING') {
        if (it.qty + d <= 0) await actions.updateItem(order.id, it.id, { qty: 0 });
        else await actions.updateItem(order.id, it.id, { qty: it.qty + d });
      } else if (d > 0) await actions.updateItem(order.id, it.id, { qty: it.qty + d });
      else setVoidTarget(it);
    });

  const doVoid = (reason: string, qty: number) =>
    guard(async () => {
      if (!order || !voidTarget) return;
      await actions.voidItem(order.id, voidTarget.id, reason, qty);
      setVoidTarget(null);
      toast('Item voided', 'ok');
    });

  const saveHeader = () => guard(async () => { if (order) await actions.updateOrder(order.id, { covers, customerPhone: phone || undefined, customerName: custName || undefined, deliveryAddress: address || undefined }); });

  const cancelOrder = () => {
    const reason = prompt('Reason for cancelling this order?');
    if (!reason || !order) return;
    guard(async () => {
      await actions.cancelOrder(order.id, reason);
      toast('Order cancelled', 'ok');
      nav('/');
    });
  };

  // ---- keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (billMode || modalItem || voidTarget || pinFor) return;
      if (e.key === 'F2' || (e.key === '/' && document.activeElement !== searchRef.current)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === 'F8') { e.preventDefault(); sendKot(); }
      else if (e.key === 'F9') { e.preventDefault(); openBill('bill'); }
      else if (e.key === 'F10') { e.preventDefault(); openBill('settle'); }
      else if (e.key === 'Escape') { if (document.activeElement === searchRef.current && q) setQ(''); else nav('/'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // ---- totals
  const preview = useMemo(() => {
    if (!outlet) return null;
    const base: Order = order ?? ({ id: 'draft', type, items: [], discount: null, serviceChargeBps: null, deliveryCharge: 0, bills: [], payments: [], kots: [] } as unknown as Order);
    const draftItems: OrderItem[] = draft.map((l, i) => ({ id: l.key, orderId: 'draft', seq: 1000 + i, itemId: l.itemId, name: l.name, variationId: l.variationId, variationName: l.variationName, unitPrice: l.unitPrice, addons: l.addons, qty: l.qty, note: l.note, status: 'PENDING', taxRateBps: l.taxRateBps, taxInclusive: outlet.settings.taxInclusive, packagingCharge: l.packagingCharge, station: l.station, discount: null, kotId: null }));
    const merged = { ...base, items: [...base.items, ...draftItems] };
    if (!merged.items.some((i) => i.status !== 'VOIDED')) return null;
    return computeBill(billInputFor(merged, outlet));
  }, [order, draft, outlet, type]);

  if (!menu || !outlet) return <div className="p-6 text-slate-400">Menu not loaded yet.</div>;
  if (id && order === undefined) return <div className="p-6 text-slate-400">Loading…</div>;
  if (id && order === null) return <div className="p-6 text-slate-400">Order not found on this device.</div>;

  const live = order?.items.filter((i) => i.status !== 'VOIDED') ?? [];
  const voidedItems = order?.items.filter((i) => i.status === 'VOIDED') ?? [];
  const locked = order?.status === 'SETTLED' || order?.status === 'CANCELLED';
  const title = order ? `${order.orderNumber}${order.tableName ? ` · ${order.tableName}` : ''}` : type === 'DINE_IN' ? `New · ${table?.name ?? '?'}` : `New ${type === 'TAKEAWAY' ? 'takeaway' : 'delivery'}`;

  return (
    <div className="flex h-full">
      {/* ------------------------------------------------ menu */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-slate-800 p-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-3 text-slate-500" />
            <Input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search item or short code…  (F2 or /)"
              className="pl-9"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && items[0]) tapItem(items[0]);
              }}
            />
          </div>
        </div>
        {!q && (
          <div className="scroll-thin flex gap-1.5 overflow-x-auto border-b border-slate-800 px-2 py-1.5">
            {categories.map((c) => (
              <button key={c.id} onClick={() => setCatId(c.id)} className={cn('shrink-0 rounded-md px-3 py-1.5 text-sm', (categories.find((x) => x.id === catId) ?? categories[0])?.id === c.id ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-800')}>
                {c.name}
              </button>
            ))}
          </div>
        )}
        <div className="scroll-thin grid flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto p-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          {items.map((i, idx) => (
            <button
              key={i.id}
              onClick={() => tapItem(i)}
              disabled={locked}
              className={cn('relative flex h-20 flex-col justify-between rounded-lg border border-slate-800 bg-slate-900 p-2 text-left hover:border-slate-500 active:scale-[0.98] disabled:opacity-40', (!i.available || i.stockOut) && 'opacity-40', q && idx === 0 && 'border-brand-500')}
            >
              <div className="flex items-start gap-1.5">
                <span className={cn('mt-1 h-2.5 w-2.5 shrink-0 rounded-sm', FOOD_DOT[i.foodType])} />
                <span className="line-clamp-2 text-sm font-medium leading-tight">{i.name}</span>
              </div>
              <div className="flex items-end justify-between text-xs">
                <span className="text-slate-500">{i.shortCode}</span>
                <span className="font-semibold text-slate-200">{i.variations.length ? `${inrShort(Math.min(...i.variations.map((v) => v.price)))}+` : inrShort(i.price)}</span>
              </div>
              {i.stockOut && <span className="absolute right-1 top-1 rounded bg-red-900 px-1 text-[10px] text-red-200">OUT</span>}
            </button>
          ))}
          {items.length === 0 && <div className="col-span-full p-6 text-center text-sm text-slate-500">No items</div>}
        </div>
      </div>

      {/* ------------------------------------------------ cart */}
      <div className="flex w-[380px] shrink-0 flex-col border-l border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{title}</div>
            <div className="text-xs text-slate-400">
              {(order?.type ?? type).replace('_', '-')}
              {order && (
                <>
                  {' · '}
                  <Badge tone={order.status === 'BILLED' ? 'blue' : order.status === 'SETTLED' ? 'green' : order.status === 'CANCELLED' ? 'red' : 'amber'}>{order.status}</Badge>
                  {order._local && <Badge tone="amber" className="ml-1">unsynced</Badge>}
                </>
              )}
            </div>
          </div>
          <button onClick={() => setMore(true)} className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white">
            <MoreHorizontal size={18} />
          </button>
        </div>

        {/* header fields */}
        <div className="flex gap-1.5 border-b border-slate-800 px-3 py-2">
          {(order?.type ?? type) === 'DINE_IN' && (
            <div className="w-16 shrink-0">
              <Input type="number" value={covers} onChange={(e) => setCovers(Number(e.target.value) || 1)} onBlur={saveHeader} title="Covers" min={1} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <Input value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 12))} onBlur={saveHeader} placeholder="Phone" inputMode="tel" />
          </div>
          <div className="min-w-0 flex-1">
            <Input value={custName} onChange={(e) => setCustName(e.target.value)} onBlur={saveHeader} placeholder="Name" />
          </div>
        </div>
        {(order?.type ?? type) === 'DELIVERY' && (
          <div className="border-b border-slate-800 px-3 py-2">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} onBlur={saveHeader} placeholder="Delivery address" />
          </div>
        )}

        {/* lines */}
        <div className="scroll-thin flex-1 overflow-y-auto">
          {live.map((it) => (
            <Line key={it.id} name={it.variationName ? `${it.name} (${it.variationName})` : it.name} addons={it.addons.map((a) => a.name)} note={it.note} qty={it.qty} amount={(it.unitPrice + it.addons.reduce((a, x) => a + x.price, 0)) * it.qty} status={it.status} disabled={locked || order?.status === 'BILLED'} onMinus={() => changeSentQty(it, -1)} onPlus={() => changeSentQty(it, +1)} />
          ))}
          {draft.map((l) => (
            <Line key={l.key} name={l.variationName ? `${l.name} (${l.variationName})` : l.name} addons={l.addons.map((a) => a.name)} note={l.note} qty={l.qty} amount={(l.unitPrice + l.addons.reduce((a, x) => a + x.price, 0)) * l.qty} status="DRAFT" onMinus={() => bumpDraft(l.key, -1)} onPlus={() => bumpDraft(l.key, +1)} onEdit={() => { setEditLine(l); setModalItem(menu.categories.flatMap((c) => c.items).find((i) => i.id === l.itemId) ?? null); }} />
          ))}
          {voidedItems.length > 0 && (
            <div className="px-3 py-1 text-[11px] text-slate-500">
              Voided: {voidedItems.map((v) => `${v.qty}× ${v.name}${v.voidReason ? ` (${v.voidReason})` : ''}`).join(', ')}
            </div>
          )}
          {live.length + draft.length === 0 && <div className="p-6 text-center text-sm text-slate-500">Tap items to add. Enter adds the first search match.</div>}
        </div>

        {/* totals + actions */}
        <div className="border-t border-slate-800 p-3">
          {preview && (
            <div className="mb-2 space-y-0.5 text-xs text-slate-400">
              <div className="flex justify-between"><span>Subtotal</span><span>{inr(preview.subtotal)}</span></div>
              {preview.discountTotal > 0 && <div className="flex justify-between text-emerald-400"><span>Discount</span><span>-{inr(preview.discountTotal)}</span></div>}
              <div className="flex justify-between"><span>GST</span><span>{inr(preview.taxTotal)}</span></div>
              {preview.serviceCharge > 0 && <div className="flex justify-between"><span>Service charge</span><span>{inr(preview.serviceCharge)}</span></div>}
              <div className="flex justify-between text-base font-bold text-white"><span>Total</span><span>{inr(preview.grandTotal)}</span></div>
            </div>
          )}
          {!locked ? (
            <div className="grid grid-cols-3 gap-2">
              <Button variant="secondary" size="lg" onClick={sendKot} disabled={busy || (!draft.length && !live.some((i) => i.status === 'PENDING'))} kbd="F8">
                <ChefHat size={16} /> KOT
              </Button>
              <Button variant="primary" size="lg" onClick={() => openBill('bill')} disabled={busy || !preview} kbd="F9">
                <Receipt size={16} /> Bill
              </Button>
              <Button variant="success" size="lg" onClick={() => openBill('settle')} disabled={busy || !preview} kbd="F10">
                <Wallet size={16} /> Pay
              </Button>
              {draft.length > 0 && order && (
                <Button variant="ghost" size="sm" className="col-span-3" onClick={save} disabled={busy}>
                  Save without KOT
                </Button>
              )}
            </div>
          ) : (
            <Button className="w-full" onClick={() => setBillMode('bill')}>
              View bill
            </Button>
          )}
        </div>
      </div>

      {/* ------------------------------------------------ modals */}
      {modalItem && (
        <ItemModal
          item={modalItem}
          menu={menu}
          initial={editLine}
          onClose={() => { setModalItem(null); setEditLine(undefined); }}
          onAdd={(l) => {
            if (editLine) setDraft((d) => d.map((x) => (x.key === editLine.key ? { ...x, ...l } : x)));
            else addLine(l);
          }}
        />
      )}
      {billMode && order && <BillModal order={order} mode={billMode} onClose={() => setBillMode(null)} />}
      {voidTarget && <VoidModal item={voidTarget} onClose={() => setVoidTarget(null)} onConfirm={doVoid} />}
      <ReceiptModal text={receipt} title="KOT (offline copy)" onClose={() => setReceipt(null)} autoPrint />
      <OverridePin open={!!pinFor} onClose={() => setPinFor(null)} reason="A manager PIN is needed for this action." onGranted={() => { const fn = pinFor; setPinFor(null); fn?.(); }} />
      {more && order && (
        <MoreModal
          order={order}
          floor={floor ?? []}
          onClose={() => setMore(false)}
          onCancel={cancelOrder}
          onTransfer={(t) => guard(async () => { await actions.transfer(order.id, t); toast('Table transferred', 'ok'); setMore(false); })}
          onMerge={(into) => guard(async () => { await actions.merge(order.id, into); toast('Merged', 'ok'); setMore(false); nav(`/order/${into}`); })}
          onSplit={(parts) => guard(async () => { const o = await actions.split(order.id, parts); toast(`Split into ${o.orderNumber}`, 'ok'); setMore(false); nav(`/order/${o.id}`); })}
          onReprintKot={(kotId) => guard(async () => { const r = await api('POST', `/kots/${kotId}/reprint`); setReceipt(r.text); })}
          canTransfer={can('pos.table.transfer')}
          canMerge={can('pos.table.merge')}
        />
      )}
    </div>
  );
}

function Line({ name, addons, note, qty, amount, status, disabled, onMinus, onPlus, onEdit }: { name: string; addons: string[]; note: string | null; qty: number; amount: number; status: string; disabled?: boolean; onMinus: () => void; onPlus: () => void; onEdit?: () => void }) {
  return (
    <div className={cn('flex items-center gap-2 border-b border-slate-800/60 px-3 py-1.5', status === 'DRAFT' && 'bg-brand-500/5')}>
      <div className="min-w-0 flex-1" onClick={onEdit}>
        <div className="flex items-center gap-1.5 text-sm">
          <span className="truncate">{name}</span>
          {status === 'DRAFT' && <Badge tone="amber">new</Badge>}
          {status === 'PENDING' && <Badge tone="amber">saved</Badge>}
          {(status === 'READY' || status === 'SERVED') && <Badge tone="green">{status.toLowerCase()}</Badge>}
        </div>
        {(addons.length > 0 || note) && (
          <div className="truncate text-[11px] text-slate-400">
            {addons.map((a) => `+${a}`).join(' ')} {note && <span className="text-amber-300">“{note}”</span>}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button onClick={onMinus} disabled={disabled} className="h-7 w-7 rounded bg-slate-800 text-sm hover:bg-slate-700 disabled:opacity-30">
          {qty === 1 && status !== 'SENT' ? <Trash2 size={12} className="mx-auto" /> : '−'}
        </button>
        <span className="w-6 text-center text-sm font-semibold">{qty}</span>
        <button onClick={onPlus} disabled={disabled} className="h-7 w-7 rounded bg-slate-800 text-sm hover:bg-slate-700 disabled:opacity-30">
          +
        </button>
      </div>
      <div className="w-16 text-right text-sm">{inrShort(amount)}</div>
    </div>
  );
}

function VoidModal({ item, onClose, onConfirm }: { item: OrderItem; onClose: () => void; onConfirm: (reason: string, qty: number) => void }) {
  const [reason, setReason] = useState<string>(VOID_REASONS[0]);
  const [qty, setQty] = useState(1);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Void ${item.name}`}
      width="max-w-sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => onConfirm(reason, qty)}>Void {qty} of {item.qty}</Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-400">This item was already sent to the kitchen. A cancel KOT will be printed. Cashiers need a manager PIN.</p>
      <div className="mb-3 flex items-center gap-2 text-sm">
        Quantity
        <Button size="sm" onClick={() => setQty(Math.max(1, qty - 1))}>−</Button>
        <span className="w-6 text-center font-semibold">{qty}</span>
        <Button size="sm" onClick={() => setQty(Math.min(item.qty, qty + 1))}>+</Button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {VOID_REASONS.map((r) => (
          <button key={r} onClick={() => setReason(r)} className={cn('rounded-lg border px-2 py-2 text-left text-xs', reason === r ? 'border-brand-500 bg-brand-500/10 text-brand-400' : 'border-slate-700')}>
            {r}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function MoreModal({ order, floor, onClose, onCancel, onTransfer, onMerge, onSplit, onReprintKot, canTransfer, canMerge }: { order: Order; floor: Area[]; onClose: () => void; onCancel: () => void; onTransfer: (tableId: string) => void; onMerge: (intoOrderId: string) => void; onSplit: (parts: { orderItemId: string; qty: number }[]) => void; onReprintKot: (kotId: string) => void; canTransfer: boolean; canMerge: boolean }) {
  const [tab, setTab] = useState<'actions' | 'transfer' | 'merge' | 'split' | 'kots'>('actions');
  const [sel, setSel] = useState<Record<string, number>>({});
  const running = useLiveQuery(() => db.orders.where('status').equals('OPEN').toArray(), []) ?? [];
  const freeTables = floor.flatMap((a) => a.tables.map((t) => ({ ...t, area: a.name }))).filter((t) => t.status === 'FREE' && !running.some((o) => o.tableId === t.id));
  const live = order.items.filter((i) => i.status !== 'VOIDED');
  return (
    <Modal open onClose={onClose} title={`Order ${order.orderNumber}`} width="max-w-lg">
      <div className="mb-3 flex gap-1 border-b border-slate-800">
        {(['actions', 'transfer', 'merge', 'split', 'kots'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cn('px-3 py-1.5 text-sm capitalize', tab === t ? 'border-b-2 border-brand-500 text-white' : 'text-slate-400')}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'actions' && (
        <div className="space-y-2">
          <Button variant="danger" className="w-full" onClick={onCancel} disabled={order.status === 'SETTLED'}>
            Cancel order (reason required)
          </Button>
          <div className="text-xs text-slate-500">Created {new Date(order.createdAt).toLocaleString('en-IN')} · v{order.version}</div>
        </div>
      )}
      {tab === 'transfer' && (
        <div className="grid grid-cols-4 gap-2">
          {!canTransfer && <div className="col-span-4 text-sm text-red-300">No permission</div>}
          {freeTables.map((t) => (
            <Button key={t.id} variant="outline" onClick={() => onTransfer(t.id)} disabled={!canTransfer}>
              <ArrowLeftRight size={14} /> {t.name}
            </Button>
          ))}
        </div>
      )}
      {tab === 'merge' && (
        <div className="space-y-2">
          <div className="text-xs text-slate-400">Move this order's items into another running table:</div>
          {running.filter((o) => o.id !== order.id && o.type === 'DINE_IN').map((o) => (
            <Button key={o.id} variant="outline" className="w-full justify-between" onClick={() => onMerge(o.id)} disabled={!canMerge}>
              <span>{o.tableName} · {o.orderNumber}</span>
              <span className="text-xs text-slate-400">{o.items.filter((i) => i.status !== 'VOIDED').length} items</span>
            </Button>
          ))}
        </div>
      )}
      {tab === 'split' && (
        <div>
          <div className="mb-2 text-xs text-slate-400">Pick items (and quantities) to move to a separate bill:</div>
          {live.map((i) => (
            <div key={i.id} className="flex items-center justify-between border-b border-slate-800 py-1.5 text-sm">
              <span>{i.name} × {i.qty}</span>
              <div className="flex items-center gap-1">
                <Button size="sm" onClick={() => setSel({ ...sel, [i.id]: Math.max(0, (sel[i.id] ?? 0) - 1) })}>−</Button>
                <span className="w-6 text-center">{sel[i.id] ?? 0}</span>
                <Button size="sm" onClick={() => setSel({ ...sel, [i.id]: Math.min(i.qty, (sel[i.id] ?? 0) + 1) })}>+</Button>
              </div>
            </div>
          ))}
          <Button variant="primary" className="mt-3 w-full" disabled={!Object.values(sel).some((q) => q > 0)} onClick={() => onSplit(Object.entries(sel).filter(([, q]) => q > 0).map(([orderItemId, qty]) => ({ orderItemId, qty })))}>
            Split into new order
          </Button>
        </div>
      )}
      {tab === 'kots' && (
        <div className="space-y-1.5">
          {order.kots.length === 0 && <div className="text-sm text-slate-500">No KOTs yet</div>}
          {order.kots.map((k) => (
            <div key={k.id} className="flex items-center justify-between rounded-lg border border-slate-800 px-3 py-2 text-sm">
              <span>
                #{k.kotNumber} <Badge tone={k.kind === 'CANCEL' ? 'red' : k.kind === 'EDIT' ? 'amber' : 'slate'}>{k.kind}</Badge> {k.station} · {k.items.reduce((n, i) => n + i.qty, 0)} items
              </span>
              <Button size="sm" onClick={() => onReprintKot(k.id)}>Reprint</Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
