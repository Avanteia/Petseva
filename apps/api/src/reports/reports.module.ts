import { Controller, Get, Inject, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { DatedPoint } from '@rms/shared';
import { Actor, CurrentUser, RequirePerms } from '../common/auth';
import { AuditService } from '../common/audit.service';
import { DB } from '../common/db.module';
import { Db } from '../db/client';
import { bills, orderItems, orders, payments } from '../db/schema';

/** Phase-1 slice of reporting: live "today" numbers for the POS header + audit log. Full reports arrive in Phase 2. */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async summary(outletId: string, from: Date, to: Date) {
    const where = and(eq(bills.outletId, outletId), eq(bills.status, 'PAID'), gte(bills.paidAt, from), lte(bills.paidAt, to));
    const [tot] = await this.db
      .select({ sales: sql<number>`coalesce(sum(${bills.grandTotal}),0)`, count: sql<number>`count(*)`, tax: sql<number>`coalesce(sum(${bills.taxTotal}),0)`, discount: sql<number>`coalesce(sum(${bills.discountTotal}),0)` })
      .from(bills)
      .where(where);
    const byMode = await this.db
      .select({ mode: payments.mode, amount: sql<number>`sum(${payments.amount})` })
      .from(payments)
      .innerJoin(bills, eq(payments.billId, bills.id))
      .where(and(where, eq(payments.voided, false)))
      .groupBy(payments.mode);
    const byType = await this.db
      .select({ type: orders.type, amount: sql<number>`sum(${bills.grandTotal})`, count: sql<number>`count(*)` })
      .from(bills)
      .innerJoin(orders, eq(bills.orderId, orders.id))
      .where(where)
      .groupBy(orders.type);
    const topItems = await this.db
      .select({ name: orderItems.name, qty: sql<number>`sum(${orderItems.qty})`, amount: sql<number>`sum(${orderItems.qty} * ${orderItems.unitPrice})` })
      .from(orderItems)
      .innerJoin(bills, eq(orderItems.orderId, bills.orderId))
      .where(and(where, sql`${orderItems.status} <> 'VOIDED'`))
      .groupBy(orderItems.name)
      .orderBy(sql`sum(${orderItems.qty}) desc`)
      .limit(10);
    const [cancelled] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(orders)
      .where(and(eq(orders.outletId, outletId), eq(orders.status, 'CANCELLED'), gte(orders.cancelledAt, from), lte(orders.cancelledAt, to)));
    const sales = Number(tot.sales);
    const count = Number(tot.count);
    return {
      from,
      to,
      sales,
      billCount: count,
      avgOrderValue: count ? Math.round(sales / count) : 0,
      tax: Number(tot.tax),
      discount: Number(tot.discount),
      byMode: byMode.map((m) => ({ mode: m.mode, amount: Number(m.amount) })),
      byType: byType.map((t) => ({ type: t.type, amount: Number(t.amount), count: Number(t.count) })),
      topItems: topItems.map((t) => ({ name: t.name, qty: Number(t.qty), amount: Number(t.amount) })),
      cancelledOrders: Number(cancelled.count),
    };
  }

  /** Daily total sales (paid bills), one point per calendar day with at least one bill — used by AI insights for weekday-baseline comparisons and trend detection. */
  async dailySalesSeries(outletId: string, from: Date, to: Date): Promise<DatedPoint[]> {
    const dayExpr = sql<string>`to_char(${bills.paidAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`;
    const rows = await this.db
      .select({ date: dayExpr, value: sql<number>`coalesce(sum(${bills.grandTotal}),0)` })
      .from(bills)
      .where(and(eq(bills.outletId, outletId), eq(bills.status, 'PAID'), gte(bills.paidAt, from), lte(bills.paidAt, to)))
      .groupBy(dayExpr)
      .orderBy(dayExpr);
    return rows.map((r) => ({ date: r.date, value: Number(r.value) }));
  }
}

function dayRange(q: any, tz = 'Asia/Kolkata') {
  // default: today in outlet TZ
  const now = new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  const from = q.from ? new Date(q.from) : new Date(`${ymd}T00:00:00+05:30`);
  const to = q.to ? new Date(q.to) : new Date(`${ymd}T23:59:59.999+05:30`);
  return { from, to };
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller()
export class ReportsController {
  constructor(
    private readonly svc: ReportsService,
    private readonly audit: AuditService,
  ) {}

  @Get('reports/summary') @ApiOperation({ summary: 'Sales summary (defaults to today)' })
  summary(@CurrentUser() u: Actor, @Query() q: any) {
    const { from, to } = dayRange(q);
    return this.svc.summary(u.outletId, from, to);
  }
  @Get('audit') @RequirePerms('audit.read')
  auditLog(@CurrentUser() u: Actor, @Query() q: any) {
    return this.audit.list(u.outletId, { from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined, action: q.action, limit: q.limit ? Number(q.limit) : undefined });
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService], exports: [ReportsService] })
export class ReportsModule {}
