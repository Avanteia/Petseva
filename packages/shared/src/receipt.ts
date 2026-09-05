import { BillResult } from './billing';
import { EscPos } from './escpos';
import { formatINR, Paise } from './money';
import { OrderType, PaymentMode } from './types';

export interface ReceiptData {
  outlet: {
    name: string;
    addressLines: string[];
    phone?: string;
    gstin?: string;
    fssai?: string;
    header?: string;
    footer?: string;
  };
  billNumber: string;
  provisional?: boolean;
  orderNumber: string;
  orderType: OrderType;
  tableName?: string;
  customerName?: string;
  customerPhone?: string;
  cashier: string;
  createdAt: Date | string;
  bill: BillResult;
  lineMeta: { id: string; variation?: string; addons?: string[] }[];
  payments: { mode: PaymentMode; amount: Paise; reference?: string }[];
  change?: Paise;
  duplicate?: boolean;
}

export interface KotData {
  outletName: string;
  kotNumber: string;
  orderNumber: string;
  orderType: OrderType;
  tableName?: string;
  station?: string;
  createdAt: Date | string;
  waiter?: string;
  items: { name: string; variation?: string; qty: number; addons?: string[]; note?: string; cancelled?: boolean }[];
  reprint?: boolean;
  isEdit?: boolean;
}

const rs = (p: Paise) => formatINR(p, { symbol: false });
const fmtDate = (d: Date | string) => {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const ORDER_TYPE_LABEL: Record<OrderType, string> = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };

/** Wraps text into lines of max `w` chars. */
function wrap(s: string, w: number): string[] {
  const words = s.split(' ');
  const out: string[] = [];
  let cur = '';
  for (const word of words) {
    if ((cur + ' ' + word).trim().length > w) {
      if (cur) out.push(cur);
      cur = word;
    } else cur = (cur + ' ' + word).trim();
  }
  if (cur) out.push(cur);
  return out;
}

export function buildReceipt(data: ReceiptData, width = 42): EscPos {
  const p = new EscPos(width);
  const o = data.outlet;
  p.align('center').bold(true).size(2, 2).line(o.name).size(1, 1).bold(false);
  o.addressLines.forEach((l) => p.line(l));
  if (o.phone) p.line(`Ph: ${o.phone}`);
  if (o.gstin) p.line(`GSTIN: ${o.gstin}`);
  if (o.fssai) p.line(`FSSAI: ${o.fssai}`);
  if (o.header) p.line(o.header);
  p.rule('=');
  p.bold(true).line(data.duplicate ? 'DUPLICATE BILL' : data.provisional ? 'PROVISIONAL BILL' : 'TAX INVOICE').bold(false);
  p.align('left');
  p.row(`Bill: ${data.billNumber}`, fmtDate(data.createdAt));
  p.row(`Order: ${data.orderNumber}`, ORDER_TYPE_LABEL[data.orderType] + (data.tableName ? ` / ${data.tableName}` : ''));
  if (data.customerName || data.customerPhone) p.line(`Cust: ${[data.customerName, data.customerPhone].filter(Boolean).join(' ')}`);
  p.line(`Cashier: ${data.cashier}`);
  p.rule();
  const qtyW = 4, amtW = 10, nameW = width - qtyW - amtW;
  p.cols(['Item', 'Qty', 'Amount'], [nameW, qtyW, amtW]);
  p.rule();
  for (const l of data.bill.lines) {
    const meta = data.lineMeta.find((m) => m.id === l.id);
    const name = meta?.variation ? `${l.name} (${meta.variation})` : l.name;
    const [first, ...rest] = wrap(name, nameW);
    p.cols([first, String(l.qty), rs(l.gross)], [nameW, qtyW, amtW]);
    rest.forEach((r) => p.line('  ' + r));
    meta?.addons?.forEach((a) => p.line(`  + ${a}`));
    if (l.itemDiscount) p.row('  discount', '-' + rs(l.itemDiscount));
  }
  p.rule();
  const b = data.bill;
  p.row('Subtotal', rs(b.subtotal));
  if (b.discountTotal) p.row('Discount', '-' + rs(b.discountTotal));
  if (b.serviceCharge) p.row('Service charge', rs(b.serviceCharge));
  if (b.deliveryCharge) p.row('Delivery charge', rs(b.deliveryCharge));
  for (const t of b.taxSummary) {
    if (t.tax === 0) continue;
    p.row(`CGST @${t.rateBps / 200}%`, rs(t.cgst));
    p.row(`SGST @${t.rateBps / 200}%`, rs(t.sgst));
  }
  if (b.roundOff) p.row('Round off', (b.roundOff > 0 ? '+' : '-') + rs(Math.abs(b.roundOff)));
  p.bold(true).size(1, 2).row('TOTAL', 'Rs.' + rs(b.grandTotal)).size(1, 1).bold(false);
  if (data.payments.length) {
    p.rule();
    for (const pay of data.payments) p.row(pay.mode + (pay.reference ? ` (${pay.reference})` : ''), rs(pay.amount));
    if (data.change) p.row('Change', rs(data.change));
  }
  p.rule('=');
  p.align('center');
  if (o.footer) wrap(o.footer, width).forEach((l) => p.line(l));
  p.feed(3).cut();
  return p;
}

export function buildKot(data: KotData, width = 42): EscPos {
  const p = new EscPos(width);
  p.align('center').bold(true).size(2, 2);
  p.line(data.reprint ? 'KOT (REPRINT)' : data.isEdit ? 'KOT (EDIT)' : 'KOT');
  p.size(1, 1).bold(false);
  if (data.station) p.line(`[${data.station}]`);
  p.align('left');
  p.row(`#${data.kotNumber}`, fmtDate(data.createdAt));
  p.row(`Order: ${data.orderNumber}`, ORDER_TYPE_LABEL[data.orderType] + (data.tableName ? ` / ${data.tableName}` : ''));
  if (data.waiter) p.line(`By: ${data.waiter}`);
  p.rule();
  p.size(1, 2);
  for (const it of data.items) {
    const name = it.variation ? `${it.name} (${it.variation})` : it.name;
    const label = it.cancelled ? `XX ${name}` : name;
    p.cols([label, `x${it.qty}`], [width - 5, 5]);
    it.addons?.forEach((a) => p.line(`   + ${a}`));
    if (it.note) p.line(`   ** ${it.note}`);
  }
  p.size(1, 1).rule().feed(3).cut();
  return p;
}

/** Plain-text rendering (for on-screen preview, email, logs). Strips ESC/POS control bytes. */
export function escposToText(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x1b || b === 0x1d) {
      // skip command + its param bytes (all commands we emit are 2–3 bytes, cut/drawer are 4–5)
      const cmd = bytes[i + 1];
      const len = b === 0x1b ? (cmd === 0x70 ? 5 : cmd === 0x40 ? 2 : 3) : cmd === 0x56 ? 4 : 3;
      i += len - 1;
      continue;
    }
    out += b === 0x0a ? '\n' : String.fromCharCode(b);
  }
  return out;
}
