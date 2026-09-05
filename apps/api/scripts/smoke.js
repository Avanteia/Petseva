#!/usr/bin/env node
/**
 * End-to-end smoke test against a running API (npm run dev:api).
 * Exercises: login → menu → floor → order → KOT → bill → payment → print → offline sync replay → concurrency.
 * Usage: node scripts/smoke.js [http://localhost:4000]
 */
const BASE = (process.argv[2] || process.env.API_URL || 'http://localhost:4000').replace(/\/$/, '') + '/api';
const { randomUUID } = require('crypto');

let token = '';
let overrideToken = '';
async function api(method, path, body, extra = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...(extra.override && { 'x-override-token': overrideToken }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok && !extra.allowFail) throw new Error(`${method} ${path} → ${res.status} ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  return { status: res.status, body: json };
}
const assert = (cond, msg) => {
  if (!cond) throw new Error('ASSERT: ' + msg);
  console.log('  ✓', msg);
};
const rs = (p) => '₹' + (p / 100).toFixed(2);

(async () => {
  console.log('▶ health');
  assert((await api('GET', '/health')).body.ok, 'API healthy');

  console.log('▶ login as cashier');
  const login = await api('POST', '/auth/login', { username: 'cashier', password: 'cashier123' });
  token = login.body.token;
  assert(login.body.user.role === 'CASHIER', 'cashier logged in');

  console.log('▶ menu + floor');
  const menu = (await api('GET', '/menu')).body;
  assert(menu.categories.length >= 5, `menu has ${menu.categories.length} categories`);
  const find = (name) => menu.categories.flatMap((c) => c.items).find((i) => i.name === name);
  const paneer = find('Paneer Tikka');
  const naan = find('Butter Naan');
  const chai = find('Masala Chai');
  const water = find('Mineral Water 1L');
  assert(paneer && naan && chai && water, 'demo items present');
  const floor = (await api('GET', '/floor')).body;
  const table = floor[0].tables.find((t) => t.status === 'FREE');
  assert(table, `free table ${table.name} in ${floor[0].name}`);

  console.log('▶ create dine-in order with variation + addon + note');
  const full = paneer.variations.find((v) => v.name === 'Full');
  const extras = menu.addonGroups.find((g) => g.name === 'Extras');
  const cheese = extras.addons.find((a) => a.name === 'Extra Cheese');
  const orderId = randomUUID();
  const created = (
    await api('POST', '/orders', {
      id: orderId,
      type: 'DINE_IN',
      tableId: table.id,
      covers: 2,
      customerPhone: '9876500001',
      items: [
        { itemId: paneer.id, variationId: full.id, addonIds: [cheese.id], qty: 1, note: 'less spicy' },
        { itemId: naan.id, qty: 4 },
        { itemId: chai.id, qty: 2 },
      ],
    })
  ).body;
  assert(created.id === orderId && created.status === 'OPEN', `order ${created.orderNumber} created (client id honoured)`);
  assert(created.items.length === 3 && created.items[0].unitPrice === full.price, 'items snapshotted with variation price');
  assert(created.customerName === 'Priya Naik', 'customer auto-linked by phone');
  const replay = (await api('POST', '/orders', { id: orderId, type: 'DINE_IN', tableId: table.id, items: [{ itemId: chai.id, qty: 1 }] })).body;
  assert(replay.items.length === 3, 'replaying ORDER_CREATE with same id is idempotent');
  const t2 = (await api('GET', '/floor')).body.flatMap((a) => a.tables).find((t) => t.id === table.id);
  assert(t2.status === 'RUNNING' && t2.order.itemCount === 7, 'table shows RUNNING with 7 items');

  console.log('▶ concurrency: stale version is rejected');
  const stale = await api('POST', `/orders/${orderId}/items`, { items: [{ itemId: chai.id, qty: 1 }], expectedVersion: 999 }, { allowFail: true });
  assert(stale.status === 409, 'stale expectedVersion → 409');
  const ok = await api('POST', `/orders/${orderId}/items`, { items: [{ itemId: water.id, qty: 1 }], expectedVersion: created.version });
  assert(ok.body.items.length === 4, 'correct expectedVersion → item added');

  console.log('▶ send KOT');
  const kotRes = (await api('POST', `/orders/${orderId}/kot`, {})).body;
  assert(kotRes.kots.length === 3, `3 KOTs (stations: ${kotRes.kots.map((k) => k.station).join(', ')})`);
  assert(kotRes.order.items.every((i) => i.status === 'SENT'), 'all items SENT');
  assert(kotRes.prints[0].text.includes('KOT'), 'KOT print preview generated (dry-run)');

  console.log('▶ void a sent item needs manager override');
  const chaiLine = kotRes.order.items.find((i) => i.name === 'Masala Chai');
  const denied = await api('POST', `/orders/${orderId}/items/${chaiLine.id}/void`, { reason: 'Customer changed mind', qty: 1 }, { allowFail: true });
  assert(denied.status === 403 && JSON.stringify(denied.body).includes('OVERRIDE_REQUIRED'), 'cashier blocked from voiding sent item');
  const ov = await api('POST', '/auth/override', { pin: '1111' });
  overrideToken = ov.body.overrideToken;
  const voided = (await api('POST', `/orders/${orderId}/items/${chaiLine.id}/void`, { reason: 'Customer changed mind', qty: 1 }, { override: true })).body;
  assert(voided.items.find((i) => i.status === 'VOIDED' && i.qty === 1) && voided.items.find((i) => i.name === 'Masala Chai' && i.status === 'SENT' && i.qty === 1), 'partial void split the line; cancel KOT created');
  assert(voided.kots.some((k) => k.kind === 'CANCEL'), 'cancel KOT recorded');

  console.log('▶ discounts: cashier limit + manager override');
  const big = await api('POST', `/orders/${orderId}/discount`, { discount: { type: 'PERCENT', value: 2500, reason: 'Friend' } }, { allowFail: true });
  assert(big.status === 403, '25% discount blocked for cashier (limit 10%)');
  const small = (await api('POST', `/orders/${orderId}/discount`, { discount: { type: 'PERCENT', value: 1000, reason: 'Regular customer' } })).body;
  assert(small.discount.value === 1000, '10% discount applied');

  console.log('▶ bill preview + generate');
  const preview = (await api('GET', `/orders/${orderId}/bill/preview`)).body;
  const expectedSubtotal = full.price + cheese.price + naan.price * 4 + chai.price * 1 + water.price;
  assert(preview.subtotal === expectedSubtotal, `subtotal ${rs(preview.subtotal)} matches (voided chai excluded)`);
  assert(preview.billDiscountTotal === Math.round(expectedSubtotal * 0.1), `bill discount ${rs(preview.billDiscountTotal)}`);
  assert(preview.taxSummary.length === 2, 'two GST slabs (5% + 18%) in summary');
  assert(preview.grandTotal % 100 === 0, `grand total ${rs(preview.grandTotal)} rounded to rupee (round-off ${preview.roundOff})`);
  const billed = (await api('POST', `/orders/${orderId}/bill`, { print: true })).body;
  assert(billed.bill.billNumber.startsWith('INV-') && billed.order.status === 'BILLED', `bill ${billed.bill.billNumber} generated, order BILLED`);
  assert(billed.print && billed.print.text.includes('TAX INVOICE') && billed.print.text.includes('CGST'), 'receipt printed (dry-run) with GST split');
  const again = (await api('POST', `/orders/${orderId}/bill`, {})).body;
  assert(again.bill.id === billed.bill.id, 're-billing reuses the same bill (idempotent)');
  const t3 = (await api('GET', '/floor')).body.flatMap((a) => a.tables).find((t) => t.id === table.id);
  assert(t3.status === 'BILLED', 'table shows BILLED');

  console.log('▶ split payment: part UPI, rest cash with change');
  const grand = billed.bill.grandTotal;
  const part = await api('POST', `/bills/${billed.bill.id}/payments`, { payments: [{ id: randomUUID(), mode: 'UPI', amount: 20000, reference: 'UPI-TXN-1' }] });
  assert(part.body.due === grand - 20000 && part.body.bill.status === 'UNPAID', `part payment recorded, due ${rs(part.body.due)}`);
  const payId = randomUUID();
  const final = await api('POST', `/bills/${billed.bill.id}/payments`, { payments: [{ id: payId, mode: 'CASH', amount: grand - 20000, tendered: grand - 20000 + 5000 }] });
  assert(final.body.bill.status === 'PAID' && final.body.due === 0, 'bill PAID');
  const dup = await api('POST', `/bills/${billed.bill.id}/payments`, { payments: [{ id: payId, mode: 'CASH', amount: grand - 20000 }] });
  assert(dup.body.bill.status === 'PAID', 'replaying same payment id is idempotent');
  const order = (await api('GET', `/orders/${orderId}`)).body;
  assert(order.status === 'SETTLED', 'order SETTLED');
  const t4 = (await api('GET', '/floor')).body.flatMap((a) => a.tables).find((t) => t.id === table.id);
  assert(t4.status === 'FREE' && !t4.currentOrderId, 'table FREE again');
  const receipt = (await api('GET', `/bills/${billed.bill.id}/receipt`)).body;
  assert(receipt.text.includes('UPI') && receipt.text.includes('CASH') && receipt.text.includes('Change'), 'receipt lists both payments + change');
  const cust = (await api('GET', '/customers/by-phone/9876500001')).body;
  assert(cust.visits === 4 && cust.history.length >= 1, 'customer visit count + history updated');

  console.log('▶ offline sync replay (takeaway punched while offline)');
  const offOrder = randomUUID();
  const offBill = randomUUID();
  const offPay = randomUUID();
  const ops = [
    { id: randomUUID(), type: 'ORDER_CREATE', payload: { id: offOrder, type: 'TAKEAWAY', items: [{ itemId: chai.id, qty: 2 }, { itemId: naan.id, qty: 2 }], createdAt: new Date(Date.now() - 600000).toISOString() } },
    { id: randomUUID(), type: 'BILL_CREATE', payload: { orderId: offOrder, billId: offBill, provisionalNumber: 'OFF-DEV1-17' } },
    { id: randomUUID(), type: 'PAYMENT_ADD', payload: { billId: offBill, payments: [{ id: offPay, mode: 'CASH', amount: 0 }] } },
  ];
  // compute the amount the POS would have charged: use preview after creating (simulate by asking server) – here we set amount after BILL_CREATE result
  const r1 = (await api('POST', '/sync/push', { deviceId: 'DEV1', ops: ops.slice(0, 2) })).body;
  assert(r1.results.every((r) => r.status === 'APPLIED'), 'ORDER_CREATE + BILL_CREATE applied');
  const offBillRow = (await api('GET', `/bills/${offBill}`)).body;
  assert(offBillRow.provisionalNumber === 'OFF-DEV1-17' && offBillRow.subtotal === chai.price * 2 + naan.price * 2 + (chai.packagingCharge + naan.packagingCharge) * 2, 'offline bill keeps provisional number; packaging charged for takeaway');
  ops[2].payload.payments[0].amount = offBillRow.grandTotal;
  const r2 = (await api('POST', '/sync/push', { deviceId: 'DEV1', ops: [ops[2], ops[0]] })).body;
  assert(r2.results[0].status === 'APPLIED' && r2.results[1].status === 'DUPLICATE', 'payment applied; re-sent op flagged DUPLICATE');
  assert((await api('GET', `/orders/${offOrder}`)).body.status === 'SETTLED', 'offline order settled after replay');

  console.log('▶ transfer + merge + cancel');
  const free = (await api('GET', '/floor')).body.flatMap((a) => a.tables).filter((t) => t.status === 'FREE');
  const o1 = (await api('POST', '/orders', { type: 'DINE_IN', tableId: free[0].id, items: [{ itemId: chai.id, qty: 1 }] })).body;
  const o2 = (await api('POST', '/orders', { type: 'DINE_IN', tableId: free[1].id, items: [{ itemId: naan.id, qty: 1 }] })).body;
  const moved = (await api('POST', `/orders/${o1.id}/transfer`, { tableId: free[2].id })).body;
  assert(moved.tableId === free[2].id, `transferred ${o1.orderNumber} → ${free[2].name}`);
  const merged = (await api('POST', `/orders/${o1.id}/merge-into/${o2.id}`)).body;
  assert(merged.items.length === 2, 'merged: target has both items');
  const cancelled = (await api('POST', `/orders/${o2.id}/cancel`, { reason: 'Customer left' })).body;
  assert(cancelled.status === 'CANCELLED', 'order cancelled (unsent items → no override needed)');
  const fl = (await api('GET', '/floor')).body.flatMap((a) => a.tables);
  assert([free[0], free[1], free[2]].every((t) => fl.find((x) => x.id === t.id).status === 'FREE'), 'all three tables freed');

  console.log('▶ reports + audit');
  const sum = (await api('GET', '/reports/summary')).body;
  assert(sum.billCount >= 2 && sum.sales >= grand, `today: ${sum.billCount} bills, ${rs(sum.sales)} sales`);
  token = (await api('POST', '/auth/login', { username: 'manager', password: 'manager123' })).body.token;
  const audit = (await api('GET', '/audit')).body;
  assert(audit.some((a) => a.action === 'ITEM_VOID') && audit.some((a) => a.action === 'DISCOUNT') && audit.some((a) => a.action === 'ORDER_CANCEL'), 'audit log has void/discount/cancel entries');

  console.log('\n✅ smoke test passed');
})().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
