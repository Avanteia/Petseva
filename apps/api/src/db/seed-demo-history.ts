import 'dotenv/config';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { computeBill, DiscountSpec, OutletSettings, PaymentMode, VOID_REASONS } from '@rms/shared';
import { createDb, createPool, Db } from './client';
import { NumberingService } from '../common/numbering.service';
import * as s from './schema';

/**
 * Back-fills ~75 days of realistic order/bill/payment/audit history for the DEMO outlet, so the
 * AI insights/anomaly, forecasting and pricing features have something real to compute over
 * (the plain `db:seed` only creates the outlet/menu/floor/users — zero transactional history).
 *
 * Every bill is produced by the *real* billing engine (`computeBill` from @rms/shared) — never
 * hand-rolled totals — so `bills.computed`/`grandTotal`/tax splits are exactly what production
 * code would have written. Order/bill/KOT numbering here is entirely local to this script (a
 * "HIST-" bill prefix + per-historical-day counters) so it never touches — or collides with —
 * the live `counters` table that NumberingService uses for real traffic.
 *
 * Deliberately injected anomalies (documented here so a demo can point straight at them; dates
 * are printed by the script too):
 *   - 3 days with a high discount rate (~40% of orders discounted instead of the ~8% baseline)
 *   - 2 days with a 5x void/cancel spike, both attributed to a single staff member
 *   - 1 sales-dip day at ~30% of normal order volume
 *   - a 14-day rising trend in one hero item's sales, ramping into the most recent day
 *
 * Idempotent: skips if this outlet already has a "seed:history" marker in `counters`.
 */
const DAYS = 75;
const HIGH_DISCOUNT_DAYS_AGO = [10, 30, 50];
const VOID_SPIKE_DAYS_AGO = [15, 45];
const SALES_DIP_DAY_AGO = 20;
const TREND_WINDOW_DAYS = 14;
const TREND_ITEM_CODE = 'BC'; // Butter Chicken — clear, demoable 14-day rising trend

// Deterministic PRNG (mulberry32) so re-runs (after a db:reset) produce the same demo data.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0x5eed1970);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const randInt = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));

/** Box-Muller sample from N(mean, sd). */
function gaussian(mean: number, sd: number): number {
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function pickWeighted<T>(pool: { item: T; weight: number }[]): T {
  const total = pool.reduce((a, p) => a + p.weight, 0);
  let r = rng() * total;
  for (const p of pool) {
    if (r < p.weight) return p.item;
    r -= p.weight;
  }
  return pool[pool.length - 1].item;
}

type MenuRow = { id: string; name: string; shortCode: string | null; price: number; packagingCharge: number; taxRateBps: number; category: string };

export async function seedHistory(db: Db) {
  const outlet = await db.query.outlets.findFirst({ where: eq(s.outlets.code, 'DEMO') });
  if (!outlet) {
    console.log('[seed-history] no DEMO outlet found — run `npm run db:seed` first.');
    return;
  }
  const outletId = outlet.id;

  const marker = await db.select().from(s.counters).where(and(eq(s.counters.outletId, outletId), eq(s.counters.key, 'seed:history')));
  if (marker.length) {
    console.log('[seed-history] demo history already generated — skipping (run db:reset to recreate).');
    return;
  }

  const settings = outlet.settings as unknown as OutletSettings;

  const staff = await db.select({ id: s.users.id, name: s.users.name, role: s.users.role }).from(s.users).where(eq(s.users.outletId, outletId));
  const ops = staff.filter((u) => u.role === 'CASHIER' || u.role === 'CAPTAIN' || u.role === 'MANAGER');
  if (!ops.length) throw new Error('no CASHIER/CAPTAIN/MANAGER users found for DEMO outlet');
  const spikeStaff = staff.find((u) => u.role === 'CASHIER') ?? ops[0];
  const staffName = new Map(staff.map((u) => [u.id, u.name]));

  const tableRows = await db.select({ id: s.tables.id, name: s.tables.name }).from(s.tables).where(eq(s.tables.outletId, outletId));

  const items = await db
    .select({
      id: s.menuItems.id,
      name: s.menuItems.name,
      shortCode: s.menuItems.shortCode,
      price: s.menuItems.price,
      packagingCharge: s.menuItems.packagingCharge,
      taxRateBps: s.taxSlabs.rateBps,
      category: s.menuCategories.name,
    })
    .from(s.menuItems)
    .innerJoin(s.taxSlabs, eq(s.menuItems.taxSlabId, s.taxSlabs.id))
    .innerJoin(s.menuCategories, eq(s.menuItems.categoryId, s.menuCategories.id))
    .where(and(eq(s.menuItems.outletId, outletId), eq(s.menuItems.active, true)));

  const breakfastItems = items.filter((i) => i.category === 'Breakfast');
  const mainItems = items.filter((i) => i.category !== 'Breakfast');
  // A handful of "hero" items dominate the sales mix (Pareto-ish), matching real restaurants.
  const heroCodes = ['BC', 'CB', 'PBM', 'CT', 'MC', 'BN'];
  const trendItem = items.find((i) => i.shortCode === TREND_ITEM_CODE) ?? mainItems[0];

  function weighted(pool: MenuRow[], daysAgo: number): { item: MenuRow; weight: number }[] {
    return pool.map((item) => {
      let weight = heroCodes.includes(item.shortCode ?? '') ? 5 : 1;
      if (item.id === trendItem.id && daysAgo <= TREND_WINDOW_DAYS) {
        weight *= 1 + ((TREND_WINDOW_DAYS - daysAgo) / TREND_WINDOW_DAYS) * 2.5; // ramps 1x -> 3.5x
      }
      return { item, weight };
    });
  }

  let histBillSeq = 0;
  const anomalyLog: string[] = [];

  for (let daysAgo = DAYS; daysAgo >= 1; daysAgo--) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - daysAgo);
    const isWeekend = day.getDay() === 0 || day.getDay() === 6;
    const isDip = daysAgo === SALES_DIP_DAY_AGO;
    const isHighDiscount = HIGH_DISCOUNT_DAYS_AGO.includes(daysAgo);
    const isVoidSpike = VOID_SPIKE_DAYS_AGO.includes(daysAgo);
    if (isDip) anomalyLog.push(`${day.toDateString()}  sales dip (~30% of normal volume)`);
    if (isHighDiscount) anomalyLog.push(`${day.toDateString()}  discount spike (~40% of orders discounted)`);
    if (isVoidSpike) anomalyLog.push(`${day.toDateString()}  void/cancel spike (5x), staff: ${spikeStaff.name}`);

    let orderCount = Math.round((35 + rng() * 20) * (isWeekend ? 1.4 : 1));
    if (isDip) orderCount = Math.round(orderCount * 0.3);
    const discountRate = isHighDiscount ? 0.4 : 0.08;
    const voidChance = 0.03 * (isVoidSpike ? 5 : 1);
    const weightPool = weighted(mainItems, daysAgo);
    const weightPoolWithBreakfast = weighted([...breakfastItems, ...mainItems], daysAgo);

    const dayOrders: (typeof s.orders.$inferInsert)[] = [];
    const dayItems: (typeof s.orderItems.$inferInsert)[] = [];
    const dayBills: (typeof s.bills.$inferInsert)[] = [];
    const dayPayments: (typeof s.payments.$inferInsert)[] = [];
    const dayAudit: (typeof s.auditLogs.$inferInsert)[] = [];

    for (let n = 1; n <= orderCount; n++) {
      const lunch = rng() < 0.6;
      let hour = lunch ? gaussian(13.25, 1.1) : gaussian(20, 1.2);
      hour = Math.min(23, Math.max(8, hour));
      const createdAt = new Date(day.getTime() + hour * 3600_000);
      const pool = hour < 11.5 ? weightPoolWithBreakfast : weightPool;

      const type = rng() < 0.65 ? 'DINE_IN' : rng() < 0.7 ? 'TAKEAWAY' : 'DELIVERY';
      const table = type === 'DINE_IN' ? pick(tableRows) : undefined;
      const createdBy = pick(ops).id;
      const orderId = randomUUID();
      // "H" marker keeps this permanently distinct from real app-generated order numbers
      // (`${dayKey}-${n}`, no letter) for the same calendar day — e.g. from smoke tests or
      // manual dev usage that may already have created real orders on some of these dates.
      const orderNumber = `${NumberingService.dayKey(day).slice(2)}-H${n}`;

      const numItems = pick([1, 1, 1, 2, 2, 2, 3, 3, 4, 5] as const);
      const lines: { id: string; name: string; qty: number; unitPrice: number; packagingCharge: number; taxRateBps: number; menuItemId: string; voided: boolean }[] = [];
      for (let li = 0; li < numItems; li++) {
        const mi = pickWeighted(pool);
        lines.push({
          id: randomUUID(),
          name: mi.name,
          qty: pick([1, 1, 1, 1, 1, 1, 2] as const),
          unitPrice: mi.price,
          packagingCharge: mi.packagingCharge,
          taxRateBps: mi.taxRateBps,
          menuItemId: mi.id,
          voided: rng() < voidChance,
        });
      }

      const cancelled = rng() < (isVoidSpike ? 0.1 : 0.02);
      const discounted = !cancelled && rng() < discountRate;
      const discount: DiscountSpec | undefined = discounted ? { type: 'PERCENT', value: pick([500, 1000, 1500] as const), reason: 'Discount' } : undefined;

      for (const l of lines) {
        dayItems.push({
          id: l.id,
          outletId,
          orderId,
          seq: lines.indexOf(l) + 1,
          itemId: l.menuItemId,
          name: l.name,
          unitPrice: l.unitPrice,
          qty: l.qty,
          status: l.voided ? 'VOIDED' : 'SERVED',
          taxRateBps: l.taxRateBps,
          taxInclusive: settings.taxInclusive,
          packagingCharge: l.packagingCharge,
          discount: null,
          voidReason: l.voided ? pick(VOID_REASONS) : null,
          voidedBy: l.voided ? (isVoidSpike ? spikeStaff.id : pick(ops).id) : null,
          voidedAt: l.voided ? new Date(createdAt.getTime() + 5 * 60_000) : null,
          createdAt,
        });
        if (l.voided) {
          dayAudit.push({
            outletId,
            userId: isVoidSpike ? spikeStaff.id : createdBy,
            userName: staffName.get(isVoidSpike ? spikeStaff.id : createdBy) ?? null,
            action: 'ITEM_VOID',
            entity: 'order_item',
            entityId: l.id,
            details: { orderId, name: l.name },
            createdAt: new Date(createdAt.getTime() + 5 * 60_000),
          });
        }
      }

      const deliveryCharge = type === 'DELIVERY' ? 3000 : 0;
      const order: typeof s.orders.$inferInsert = {
        id: orderId,
        outletId,
        orderNumber,
        type,
        status: cancelled ? 'CANCELLED' : 'SETTLED',
        tableId: table?.id ?? null,
        tableName: table?.name ?? null,
        covers: type === 'DINE_IN' ? randInt(1, 6) : 1,
        discount: discount ? { ...discount, byUserId: createdBy } : null,
        serviceChargeBps: null,
        deliveryCharge,
        createdBy,
        deviceId: 'seed-history',
        createdAt,
        updatedAt: createdAt,
        billedAt: cancelled ? null : createdAt,
        settledAt: cancelled ? null : new Date(createdAt.getTime() + 25 * 60_000),
        cancelledAt: cancelled ? new Date(createdAt.getTime() + 3 * 60_000) : null,
        cancelReason: cancelled ? pick(VOID_REASONS) : null,
      };
      dayOrders.push(order);

      if (discounted) {
        dayAudit.push({
          outletId,
          userId: createdBy,
          userName: staffName.get(createdBy) ?? null,
          action: 'DISCOUNT',
          entity: 'order',
          entityId: orderId,
          details: { percentBps: discount!.value, reason: discount!.reason },
          createdAt,
        });
      }
      if (cancelled) {
        dayAudit.push({
          outletId,
          userId: createdBy,
          userName: staffName.get(createdBy) ?? null,
          action: 'ORDER_CANCEL',
          entity: 'order',
          entityId: orderId,
          details: { reason: order.cancelReason },
          createdAt: order.cancelledAt!,
        });
        continue; // no bill for a cancelled order
      }

      const computed = computeBill({
        lines: lines.map((l) => ({
          id: l.id,
          name: l.name,
          qty: l.qty,
          unitPrice: l.unitPrice,
          packagingPerUnit: l.packagingCharge,
          taxRateBps: l.taxRateBps,
          taxInclusive: settings.taxInclusive,
          voided: l.voided,
        })),
        billDiscount: discount,
        serviceChargeBps: settings.serviceChargeBps,
        serviceChargeTaxable: settings.serviceChargeTaxable,
        serviceChargeTaxRateBps: settings.serviceChargeTaxRateBps,
        roundingMode: settings.roundingMode,
        applyPackaging: type !== 'DINE_IN',
        deliveryCharge,
      });

      histBillSeq++;
      const billId = randomUUID();
      const billNumber = `HIST-${String(histBillSeq).padStart(6, '0')}`;
      dayBills.push({
        id: billId,
        outletId,
        orderId,
        billNumber,
        status: 'PAID',
        computed: computed as unknown as Record<string, unknown>,
        subtotal: computed.subtotal,
        discountTotal: computed.discountTotal,
        serviceCharge: computed.serviceCharge,
        taxTotal: computed.taxTotal,
        cgstTotal: computed.cgstTotal,
        sgstTotal: computed.sgstTotal,
        roundOff: computed.roundOff,
        grandTotal: computed.grandTotal,
        paidTotal: computed.grandTotal,
        createdBy,
        createdAt: order.billedAt!,
        paidAt: order.settledAt!,
      });

      const mode: PaymentMode = rng() < 0.45 ? 'CASH' : rng() < 0.75 ? 'UPI' : 'CARD';
      dayPayments.push({
        id: randomUUID(),
        outletId,
        billId,
        orderId,
        mode,
        amount: computed.grandTotal,
        tendered: mode === 'CASH' ? computed.grandTotal : null,
        reference: mode === 'CASH' ? null : `${mode}-${randInt(100000, 999999)}`,
        createdBy,
        createdAt: order.settledAt!,
      });
    }

    if (dayOrders.length) await db.insert(s.orders).values(dayOrders);
    if (dayItems.length) await db.insert(s.orderItems).values(dayItems);
    if (dayBills.length) await db.insert(s.bills).values(dayBills);
    if (dayPayments.length) await db.insert(s.payments).values(dayPayments);
    if (dayAudit.length) await db.insert(s.auditLogs).values(dayAudit);
  }

  await db.insert(s.counters).values({ outletId, key: 'seed:history', value: 1 }).onConflictDoNothing();

  console.log(`[seed-history] generated ${DAYS} days of history, ${histBillSeq} paid bills for outlet ${outlet.code}.`);
  console.log(`[seed-history] trend item: ${trendItem.name} (rising over the last ${TREND_WINDOW_DAYS} days).`);
  console.log('[seed-history] injected anomalies:');
  for (const line of anomalyLog) console.log(`   - ${line}`);
}

if (require.main === module) {
  const pool = createPool();
  seedHistory(createDb(pool))
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
