import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { baselineDeviations, DatedPoint, meanStdDev, zScoreOutliers } from '@rms/shared';
import { AI_PROVIDER, AiProvider, InsightAnomaly } from '../ai/ai-provider.interface';
import { DB } from '../common/db.module';
import { Db } from '../db/client';
import { orderItems, orders, outlets, users } from '../db/schema';
import { ReportsService } from '../reports/reports.module';

const TZ_OFFSET = '+05:30'; // Asia/Kolkata has no DST — matches ReportsController's own dayRange()

/** One row per day: how many orders that day, and how many carried a bill-level discount (or were voided). */
export interface RateRow {
  date: string;
  total: number;
  flagged: number;
  rate: number;
}

/**
 * Pure anomaly-assembly logic, extracted (same reasoning as `billInputFor` in billing.service.ts)
 * so it's unit-testable with plain fixture arrays — no DB/TestingModule needed.
 */
export function detectRateSpikes(rows: RateRow[], kind: 'DISCOUNT_SPIKE' | 'VOID_SPIKE', threshold = 1.3): InsightAnomaly[] {
  const rates = rows.map((r) => r.rate);
  const { mean } = meanStdDev(rates);
  const label = kind === 'DISCOUNT_SPIKE' ? 'Discount' : 'Void/cancel';
  return zScoreOutliers(rates, threshold)
    .filter((o) => o.zScore > 0)
    .map((o) => ({
      kind,
      date: rows[o.index].date,
      label: `${label} spike on ${rows[o.index].date}`,
      metric: kind === 'DISCOUNT_SPIKE' ? 'discountRatePct' : 'voidRatePct',
      value: rows[o.index].rate,
      baseline: mean,
      zScore: o.zScore,
    }));
}

export function detectSalesDips(series: DatedPoint[]): InsightAnomaly[] {
  return baselineDeviations(series)
    .filter((d) => d.baseline > 0 && d.zScore <= -1.5)
    .map((d) => ({ kind: 'SALES_DIP' as const, date: d.date, label: `Sales dip on ${d.date}`, metric: 'sales', value: d.value, baseline: d.baseline, zScore: d.zScore }));
}

@Injectable()
export class InsightsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    private readonly reports: ReportsService,
  ) {}

  private todayYmd(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  }

  private dayRange(dateYmd?: string) {
    const ymd = dateYmd ?? this.todayYmd();
    return { from: new Date(`${ymd}T00:00:00${TZ_OFFSET}`), to: new Date(`${ymd}T23:59:59.999${TZ_OFFSET}`), ymd };
  }

  /** Trailing N-day window ending on `endYmd` (default: today). Simpler and just as useful as a calendar Mon-Sun week. */
  private recentWindow(days: number, endYmd?: string) {
    const end = endYmd ?? this.todayYmd();
    const to = new Date(`${end}T23:59:59.999${TZ_OFFSET}`);
    const from = new Date(`${end}T00:00:00${TZ_OFFSET}`);
    from.setUTCDate(from.getUTCDate() - (days - 1));
    return { from, to, endYmd: end };
  }

  private dayExpr(col: any) {
    return sql<string>`to_char(${col} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`;
  }

  async dailySalesSeries(outletId: string, from: Date, to: Date): Promise<DatedPoint[]> {
    const rows = await this.reports.dailySalesSeries(outletId, from, to);
    return rows;
  }

  private async discountRateSeries(outletId: string, from: Date, to: Date): Promise<RateRow[]> {
    const rows = await this.db
      .select({ date: this.dayExpr(orders.createdAt), total: sql<number>`count(*)`, flagged: sql<number>`count(*) filter (where ${orders.discount} is not null)` })
      .from(orders)
      .where(and(eq(orders.outletId, outletId), gte(orders.createdAt, from), lte(orders.createdAt, to)))
      .groupBy(this.dayExpr(orders.createdAt))
      .orderBy(this.dayExpr(orders.createdAt));
    return rows.map((r) => ({ date: r.date, total: Number(r.total), flagged: Number(r.flagged), rate: Number(r.total) ? (Number(r.flagged) / Number(r.total)) * 100 : 0 }));
  }

  private async voidRateSeries(outletId: string, from: Date, to: Date): Promise<RateRow[]> {
    const rows = await this.db
      .select({ date: this.dayExpr(orderItems.createdAt), total: sql<number>`count(*)`, flagged: sql<number>`count(*) filter (where ${orderItems.status} = 'VOIDED')` })
      .from(orderItems)
      .where(and(eq(orderItems.outletId, outletId), gte(orderItems.createdAt, from), lte(orderItems.createdAt, to)))
      .groupBy(this.dayExpr(orderItems.createdAt))
      .orderBy(this.dayExpr(orderItems.createdAt));
    return rows.map((r) => ({ date: r.date, total: Number(r.total), flagged: Number(r.flagged), rate: Number(r.total) ? (Number(r.flagged) / Number(r.total)) * 100 : 0 }));
  }

  private async salesAnomalies(outletId: string, from: Date, to: Date): Promise<InsightAnomaly[]> {
    return detectSalesDips(await this.dailySalesSeries(outletId, from, to));
  }

  /** Top items by volume over the window, comparing the last 14 days to the 14 before that. */
  private async itemTrends(outletId: string, from: Date, to: Date): Promise<InsightAnomaly[]> {
    const totalDays = Math.round((to.getTime() - from.getTime()) / 86_400_000);
    if (totalDays < 28) return [];
    const mid = new Date(to.getTime() - 14 * 86_400_000);
    const prior = new Date(mid.getTime() - 14 * 86_400_000);
    const top = await this.db
      .select({ name: orderItems.name, qty: sql<number>`sum(${orderItems.qty})` })
      .from(orderItems)
      .where(and(eq(orderItems.outletId, outletId), sql`${orderItems.status} <> 'VOIDED'`, gte(orderItems.createdAt, from), lte(orderItems.createdAt, to)))
      .groupBy(orderItems.name)
      .orderBy(sql`sum(${orderItems.qty}) desc`)
      .limit(6);

    const qtyBetween = async (name: string, f: Date, t: Date) => {
      const [row] = await this.db
        .select({ qty: sql<number>`coalesce(sum(${orderItems.qty}),0)` })
        .from(orderItems)
        .where(and(eq(orderItems.outletId, outletId), eq(orderItems.name, name), sql`${orderItems.status} <> 'VOIDED'`, gte(orderItems.createdAt, f), lte(orderItems.createdAt, t)));
      return Number(row?.qty ?? 0);
    };

    const out: InsightAnomaly[] = [];
    for (const item of top) {
      const recentAvg = (await qtyBetween(item.name, mid, to)) / 14;
      const priorAvg = (await qtyBetween(item.name, prior, mid)) / 14;
      if (priorAvg <= 0) continue;
      const change = (recentAvg - priorAvg) / priorAvg;
      if (Math.abs(change) > 0.3) {
        out.push({ kind: 'ITEM_TREND', label: `${item.name} sales trending ${change >= 0 ? 'up' : 'down'}`, metric: 'avgQtyPerDay', value: recentAvg, baseline: priorAvg, zScore: change, detail: { name: item.name } });
      }
    }
    return out;
  }

  /** Structured anomaly findings over a trailing window — no narration, for the dashboard's cards. */
  async anomalies(outletId: string, days = 75): Promise<InsightAnomaly[]> {
    const { from, to } = this.recentWindow(days);
    const [sales, discountRows, voidRows, trends] = await Promise.all([
      this.salesAnomalies(outletId, from, to),
      this.discountRateSeries(outletId, from, to),
      this.voidRateSeries(outletId, from, to),
      this.itemTrends(outletId, from, to),
    ]);
    const discountAnoms = detectRateSpikes(discountRows, 'DISCOUNT_SPIKE');
    const voidAnoms = detectRateSpikes(voidRows, 'VOID_SPIKE');
    return [...sales, ...discountAnoms, ...voidAnoms, ...trends].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  }

  async staffOutliers(outletId: string, days = 75) {
    const { from, to } = this.recentWindow(days);
    const [voidRows, orderRows, staff] = await Promise.all([
      this.db
        .select({ userId: orderItems.voidedBy, count: sql<number>`count(*)` })
        .from(orderItems)
        .where(and(eq(orderItems.outletId, outletId), eq(orderItems.status, 'VOIDED'), gte(orderItems.createdAt, from), lte(orderItems.createdAt, to)))
        .groupBy(orderItems.voidedBy),
      this.db
        .select({ userId: orders.createdBy, count: sql<number>`count(*)` })
        .from(orders)
        .where(and(eq(orders.outletId, outletId), gte(orders.createdAt, from), lte(orders.createdAt, to)))
        .groupBy(orders.createdBy),
      this.db.select({ id: users.id, name: users.name }).from(users).where(eq(users.outletId, outletId)),
    ]);
    const nameOf = new Map(staff.map((s) => [s.id, s.name]));
    const orderCountOf = new Map(orderRows.filter((r) => r.userId).map((r) => [r.userId as string, Number(r.count)]));
    const rows = voidRows
      .filter((r) => r.userId)
      .map((r) => {
        const userId = r.userId as string;
        const orderCount = orderCountOf.get(userId) ?? 0;
        const voidCount = Number(r.count);
        return { userId, name: nameOf.get(userId) ?? 'Unknown', voidCount, orderCount, voidRatePct: orderCount ? (voidCount / orderCount) * 100 : 0 };
      });
    const outlierIdx = new Set(zScoreOutliers(rows.map((r) => r.voidRatePct), 1.2).filter((o) => o.zScore > 0).map((o) => o.index));
    return rows.map((r, i) => ({ ...r, outlier: outlierIdx.has(i) })).sort((a, b) => b.voidRatePct - a.voidRatePct);
  }

  async dailySummary(outletId: string, dateYmd?: string) {
    const { from, to, ymd } = this.dayRange(dateYmd);
    const [summary, allAnomalies, outlet] = await Promise.all([
      this.reports.summary(outletId, from, to),
      this.anomalies(outletId, 75),
      this.db.select({ name: outlets.name }).from(outlets).where(eq(outlets.id, outletId)),
    ]);
    const todays = allAnomalies.filter((a) => a.date === ymd);
    const series = await this.dailySalesSeries(outletId, this.recentWindow(75, ymd).from, to);
    const dev = baselineDeviations(series).find((d) => d.date === ymd);
    const salesVsBaselinePct = dev && dev.baseline > 0 ? ((dev.value - dev.baseline) / dev.baseline) * 100 : null;
    const [narrative, explanations] = await Promise.all([
      this.ai.generateInsightSummary({ outletName: outlet[0]?.name ?? 'Outlet', periodLabel: `on ${ymd}`, sales: summary.sales, billCount: summary.billCount, avgOrderValue: summary.avgOrderValue, salesVsBaselinePct, anomalies: todays }),
      this.ai.explainAnomalies(todays),
    ]);
    return { ...summary, periodLabel: `on ${ymd}`, salesVsBaselinePct, anomalies: todays.map((a, i) => ({ ...a, explanation: explanations[i] })), narrative };
  }

  async weeklySummary(outletId: string, endYmd?: string) {
    const { from, to, endYmd: end } = this.recentWindow(7, endYmd);
    const startYmd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(from);
    const [summary, allAnomalies, outlet] = await Promise.all([
      this.reports.summary(outletId, from, to),
      this.anomalies(outletId, 75),
      this.db.select({ name: outlets.name }).from(outlets).where(eq(outlets.id, outletId)),
    ]);
    const inWeek = allAnomalies.filter((a) => a.date && a.date >= startYmd && a.date <= end);
    const [narrative, explanations] = await Promise.all([
      this.ai.generateInsightSummary({ outletName: outlet[0]?.name ?? 'Outlet', periodLabel: `${startYmd} to ${end}`, sales: summary.sales, billCount: summary.billCount, avgOrderValue: summary.avgOrderValue, salesVsBaselinePct: null, anomalies: inWeek }),
      this.ai.explainAnomalies(inWeek),
    ]);
    return { ...summary, periodLabel: `${startYmd} to ${end}`, anomalies: inWeek.map((a, i) => ({ ...a, explanation: explanations[i] })), narrative };
  }
}
