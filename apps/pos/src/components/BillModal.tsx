import { computeBill, type BillResult, type DiscountSpec, type PaymentMode } from '@rms/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { actions, localReceipt, OpRejected } from '../lib/actions';
import { cache } from '../lib/db';
import { cn, inr } from '../lib/format';
import { billInputFor } from '../lib/localOps';
import { useSync } from '../lib/sync';
import type { Order } from '../lib/types';
import { useAuth } from '../store/auth';
import { toast } from '../store/toast';
import { OverridePin } from './OverridePin';
import { ReceiptModal } from './ReceiptModal';
import { Badge, Button, Input, Modal, NumPad } from './ui';

const MODES: { mode: PaymentMode; label: string }[] = [
  { mode: 'CASH', label: 'Cash' },
  { mode: 'UPI', label: 'UPI' },
  { mode: 'CARD', label: 'Card' },
  { mode: 'WALLET', label: 'Wallet' },
  { mode: 'CREDIT', label: 'Credit' },
];

/**
 * Bill & settle in one screen: discount → generate bill (prints) → take one or more payments → done.
 * `mode="settle"` jumps straight to payment (F10).
 */
export function BillModal({ order, mode, onClose }: { order: Order; mode: 'bill' | 'settle'; onClose: () => void }) {
  const nav = useNavigate();
  const outlet = useLiveQuery(() => cache.outlet());
  const online = useSync((s) => s.online);
  const can = useAuth((s) => s.can);
  const bill = order.bills.find((b) => b.status === 'UNPAID') ?? order.bills.find((b) => b.status === 'PAID');
  const preview: BillResult | null = useMemo(() => (outlet ? computeBill(billInputFor(order, outlet)) : null), [order, outlet]);
  const totals = bill?.status === 'UNPAID' || bill?.status === 'PAID' ? bill.computed : preview;

  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<null | (() => void)>(null);

  // discount UI
  const [dType, setDType] = useState<'PERCENT' | 'FLAT'>(order.discount?.type ?? 'PERCENT');
  const [dValue, setDValue] = useState(order.discount ? (order.discount.type === 'PERCENT' ? String(order.discount.value / 100) : String(order.discount.value / 100)) : '');
  const [dReason, setDReason] = useState(order.discount?.reason ?? '');

  // payments UI
  const paid = order.payments.filter((p) => bill && p.billId === bill.id && !p.voided).reduce((a, p) => a + p.amount, 0);
  const due = Math.max(0, (bill?.grandTotal ?? totals?.grandTotal ?? 0) - paid);
  const [payMode, setPayMode] = useState<PaymentMode>('CASH');
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [pending, setPending] = useState<{ mode: PaymentMode; amount: number; tendered?: number; reference?: string }[]>([]);
  const pendingSum = pending.reduce((a, p) => a + p.amount, 0);
  const remaining = Math.max(0, due - pendingSum);
  useEffect(() => setAmount(remaining ? (remaining / 100).toFixed(2).replace(/\.00$/, '') : ''), [remaining]);

  const guard = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e: any) {
        if (e instanceof OpRejected && e.code === 'OVERRIDE_REQUIRED') setPinFor(() => () => guard(fn));
        else if (e?.code === 'OVERRIDE_REQUIRED' || e?.status === 403) setPinFor(() => () => guard(fn));
        else toast(e?.message ?? 'Failed', 'err');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const applyDiscount = () =>
    guard(async () => {
      const v = Number(dValue);
      if (!dValue || Number.isNaN(v) || v <= 0) {
        await actions.setDiscount(order.id, null);
        if (bill?.status === 'UNPAID') await actions.createBill(order.id);
        return;
      }
      const spec: DiscountSpec = { type: dType, value: dType === 'PERCENT' ? Math.round(v * 100) : Math.round(v * 100), reason: dReason || undefined };
      await actions.setDiscount(order.id, spec);
      if (bill?.status === 'UNPAID') await actions.createBill(order.id); // recompute the existing bill
      toast('Discount applied', 'ok');
    });

  const generate = () =>
    guard(async () => {
      const { order: o, bill: b } = await actions.createBill(order.id);
      const r = await localReceipt(o, b);
      setReceipt(r.text);
      if (online) api('POST', `/bills/${b.id}/print`, {}).catch(() => undefined);
    });

  const addPending = () => {
    const paise = Math.round(Number(amount) * 100);
    if (!paise || paise <= 0) return;
    const p = { mode: payMode, amount: payMode === 'CASH' ? Math.min(paise, remaining) : paise, tendered: payMode === 'CASH' ? paise : undefined, reference: ref || undefined };
    setPending([...pending, p]);
    setRef('');
  };

  const settle = () =>
    guard(async () => {
      let b = bill;
      let o = order;
      if (!b || b.status !== 'UNPAID') {
        const r = await actions.createBill(order.id);
        b = r.bill;
        o = r.order;
      }
      const list = pending.length ? pending : remaining > 0 ? [{ mode: payMode, amount: remaining, tendered: payMode === 'CASH' ? Math.round(Number(amount) * 100) || remaining : undefined, reference: ref || undefined }] : [];
      if (!list.length) return;
      const updated = await actions.addPayments(o.id, b.id, list);
      setPending([]);
      const nb = updated.bills.find((x) => x.id === b!.id)!;
      if (nb.status === 'PAID') {
        const r = await localReceipt(updated, nb);
        setReceipt(r.text);
        if (online) api('POST', `/bills/${nb.id}/print`, {}).catch(() => undefined);
        toast(`Settled ${nb.billNumber}`, 'ok');
      } else toast(`Part payment saved · due ${inr(nb.grandTotal - nb.paidTotal)}`, 'ok');
    });

  const settled = bill?.status === 'PAID' || order.status === 'SETTLED';
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (pinFor || receipt) return;
      if (e.key === 'F10') { e.preventDefault(); if (!settled && !busy) settle(); }
      if (e.key === 'F9') { e.preventDefault(); if (!settled && !busy) generate(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  const closeAll = () => {
    setReceipt(null);
    if (settled) nav('/');
    else onClose();
  };

  if (!totals) return null;
  return (
    <>
      <Modal open onClose={onClose} title={<span>{mode === 'settle' ? 'Settle' : 'Bill'} · {order.orderNumber}{order.tableName ? ` · ${order.tableName}` : ''}</span>} width="max-w-5xl">
        <div className="grid gap-6 md:grid-cols-2">
          {/* left: breakdown */}
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              Summary
              {bill && (
                <Badge tone={bill.status === 'PAID' ? 'green' : 'blue'}>
                  {bill.billNumber}
                  {bill.provisionalNumber && bill.billNumber === bill.provisionalNumber ? ' (provisional)' : ''}
                </Badge>
              )}
            </div>
            <div className="rounded-lg border border-slate-800 text-sm">
              {totals.lines.map((l) => (
                <div key={l.id} className="flex justify-between border-b border-slate-800/60 px-3 py-1.5">
                  <span>
                    {l.qty} × {l.name}
                    {l.itemDiscount > 0 && <span className="ml-1 text-xs text-emerald-400">-{inr(l.itemDiscount)}</span>}
                  </span>
                  <span>{inr(l.gross)}</span>
                </div>
              ))}
              <Row label="Subtotal" value={totals.subtotal} />
              {totals.discountTotal > 0 && <Row label="Discount" value={-totals.discountTotal} tone="text-emerald-400" />}
              {totals.serviceCharge > 0 && <Row label={`Service charge`} value={totals.serviceCharge} />}
              {totals.deliveryCharge > 0 && <Row label="Delivery charge" value={totals.deliveryCharge} />}
              {totals.taxSummary.map((t) => (
                <div key={t.rateBps} className="contents">
                  <Row label={`CGST @${t.rateBps / 200}%`} value={t.cgst} muted />
                  <Row label={`SGST @${t.rateBps / 200}%`} value={t.sgst} muted />
                </div>
              ))}
              {totals.roundOff !== 0 && <Row label="Round off" value={totals.roundOff} muted />}
              <div className="flex justify-between px-3 py-2 text-lg font-bold">
                <span>Total</span>
                <span>{inr(totals.grandTotal)}</span>
              </div>
              {paid > 0 && <Row label="Paid" value={-paid} tone="text-emerald-400" />}
            </div>

            {!settled && (
              <div className="mt-4 rounded-lg border border-slate-800 p-3">
                <div className="mb-2 text-xs font-semibold uppercase text-slate-400">Bill discount</div>
                <div className="flex gap-2">
                  <div className="flex rounded-lg border border-slate-700">
                    {(['PERCENT', 'FLAT'] as const).map((t) => (
                      <button key={t} onClick={() => setDType(t)} className={cn('px-3 text-sm', dType === t ? 'bg-slate-700 text-white' : 'text-slate-400')}>
                        {t === 'PERCENT' ? '%' : '₹'}
                      </button>
                    ))}
                  </div>
                  <Input value={dValue} onChange={(e) => setDValue(e.target.value)} placeholder={dType === 'PERCENT' ? '10' : '50'} className="w-24" inputMode="decimal" />
                  <Input value={dReason} onChange={(e) => setDReason(e.target.value)} placeholder="Reason / coupon code" />
                  <Button onClick={applyDiscount} disabled={busy || !can('pos.bill.discount')}>
                    Apply
                  </Button>
                </div>
                {outlet && !can('pos.bill.discount.unlimited') && <div className="mt-1 text-[11px] text-slate-500">Above {outlet.settings.cashierMaxDiscountBps / 100}% needs a manager PIN.</div>}
              </div>
            )}
          </div>

          {/* right: payment */}
          <div>
            {settled ? (
              <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-4 text-center">
                <div className="text-sm text-emerald-300">Paid</div>
                <div className="text-3xl font-bold">{inr(bill!.grandTotal)}</div>
                <div className="mt-2 text-xs text-slate-400">{order.payments.filter((p) => !p.voided).map((p) => `${p.mode} ${inr(p.amount)}`).join(' · ')}</div>
                <div className="mt-4 flex justify-center gap-2">
                  <Button onClick={() => localReceipt(order, bill!, true).then((r) => setReceipt(r.text))}>Reprint</Button>
                  {can('pos.payment.refund') && (
                    <Button
                      variant="danger"
                      onClick={() => {
                        const reason = prompt('Reason for voiding this paid bill (refund)?');
                        if (reason) guard(() => actions.voidBill(bill!.id, reason).then(() => toast('Bill voided', 'ok')));
                      }}
                    >
                      Void bill
                    </Button>
                  )}
                  <Button variant="primary" onClick={() => nav('/')}>
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between text-sm font-semibold">
                  <span>Payment</span>
                  <span className="text-slate-400">
                    Due <span className="text-lg text-white">{inr(remaining)}</span>
                  </span>
                </div>
                <div className="mb-3 grid grid-cols-5 gap-1.5">
                  {MODES.map((m) => (
                    <button key={m.mode} onClick={() => setPayMode(m.mode)} className={cn('rounded-lg border py-2 text-sm', payMode === m.mode ? 'border-brand-500 bg-brand-500/10 text-brand-400' : 'border-slate-700 hover:border-slate-500')}>
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-4">
                  <div>
                    <div className="mb-2 flex items-center rounded-lg bg-slate-950 px-3 text-2xl font-semibold">
                      <span className="mr-1 text-slate-500">₹</span>
                      <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} className="h-12 w-full bg-transparent outline-none" inputMode="decimal" autoFocus={mode === 'settle'} onKeyDown={(e) => e.key === 'Enter' && settle()} />
                    </div>
                    {payMode !== 'CASH' && <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Txn reference (optional)" className="mb-2" />}
                    {payMode === 'CASH' && (
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {quickCash(remaining).map((q) => (
                          <button key={q} onClick={() => setAmount(String(q / 100))} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs hover:border-slate-500">
                            ₹{q / 100}
                          </button>
                        ))}
                      </div>
                    )}
                    {pending.length > 0 && (
                      <div className="mb-2 rounded-lg border border-slate-800 text-xs">
                        {pending.map((p, i) => (
                          <div key={i} className="flex justify-between px-2 py-1">
                            <span>
                              {p.mode} {p.reference ? `(${p.reference})` : ''}
                            </span>
                            <span className="flex gap-2">
                              {inr(p.amount)}
                              <button className="text-red-400" onClick={() => setPending(pending.filter((_, j) => j !== i))}>
                                ✕
                              </button>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {payMode === 'CASH' && Number(amount) * 100 > remaining && <div className="mb-2 text-sm text-emerald-400">Change: {inr(Math.round(Number(amount) * 100) - remaining)}</div>}
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={addPending} disabled={busy || !amount}>
                        + Split
                      </Button>
                      <Button variant="success" size="lg" className="flex-1" onClick={settle} disabled={busy || (!pending.length && !amount)} kbd="F10">
                        {pendingSum >= due && pending.length ? 'Settle' : Number(amount) * 100 >= remaining || pendingSum + Math.round(Number(amount) * 100) >= due ? 'Settle & Print' : 'Part pay'}
                      </Button>
                    </div>
                  </div>
                  <div className="w-52 shrink-0">
                    <NumPad value={amount} onChange={setAmount} />
                  </div>
                </div>
                <div className="mt-4 flex gap-2 border-t border-slate-800 pt-3">
                  <Button onClick={generate} disabled={busy} kbd="F9">
                    {bill ? 'Reprint bill' : 'Print bill'}
                  </Button>
                  {bill && can('pos.payment.refund') && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        const reason = prompt('Reason for voiding this bill?');
                        if (reason) guard(() => actions.voidBill(bill.id, reason).then(() => toast('Bill voided — order re-opened', 'ok')));
                      }}
                    >
                      Void bill
                    </Button>
                  )}
                  {!online && <span className="self-center text-xs text-amber-400">Offline: provisional bill number, synced later</span>}
                </div>
              </>
            )}
          </div>
        </div>
      </Modal>
      <ReceiptModal text={receipt} title={settled ? 'Receipt' : 'Bill'} onClose={closeAll} autoPrint />
      <OverridePin
        open={!!pinFor}
        onClose={() => setPinFor(null)}
        reason="This action exceeds your limit."
        onGranted={() => {
          const fn = pinFor;
          setPinFor(null);
          fn?.();
        }}
      />
    </>
  );
}

function Row({ label, value, muted, tone }: { label: string; value: number; muted?: boolean; tone?: string }) {
  return (
    <div className={cn('flex justify-between px-3 py-1', muted ? 'text-xs text-slate-400' : 'text-sm', tone)}>
      <span>{label}</span>
      <span>
        {value < 0 ? '-' : ''}
        {inr(Math.abs(value))}
      </span>
    </div>
  );
}

function quickCash(due: number) {
  const r = Math.ceil(due / 100);
  const opts = new Set<number>([r, Math.ceil(r / 50) * 50, Math.ceil(r / 100) * 100, Math.ceil(r / 500) * 500, Math.ceil(r / 2000) * 2000]);
  return [...opts].filter((x) => x > 0).sort((a, b) => a - b).slice(0, 5).map((x) => x * 100);
}
