import { Body, Controller, Get, Inject, Injectable, Logger, Module, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { eq, inArray } from 'drizzle-orm';
import { Actor, CurrentUser } from '../common/auth';
import { DB } from '../common/db.module';
import { Db } from '../db/client';
import { syncOps } from '../db/schema';
import { BillingService } from '../billing/billing.service';
import { FloorModule, FloorService } from '../floor/floor.module';
import { MenuModule, MenuService } from '../menu/menu.module';
import { OrdersModule } from '../orders/orders.module';
import { OrdersService } from '../orders/orders.service';
import { OutletsModule, OutletsService } from '../outlets/outlets.module';

export interface SyncOp {
  id: string;
  type: string;
  payload: any;
  at?: string;
}

/**
 * Offline sync: the POS queues operations locally (IndexedDB) and replays them here in order.
 * Every op carries a client-minted UUID; results are recorded in sync_ops so a retry after a
 * network drop mid-request never double-applies (exactly-once from the client's perspective).
 */
@Injectable()
export class SyncService {
  private readonly log = new Logger('Sync');
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orders: OrdersService,
    private readonly billing: BillingService,
    private readonly menu: MenuService,
    private readonly floor: FloorService,
    private readonly outlets: OutletsService,
  ) {}

  async push(actor: Actor, deviceId: string, ops: SyncOp[]) {
    const ids = ops.map((o) => o.id);
    const seen = ids.length ? await this.db.select().from(syncOps).where(inArray(syncOps.id, ids)) : [];
    const results: { id: string; status: 'APPLIED' | 'REJECTED' | 'DUPLICATE'; response?: unknown; error?: string }[] = [];
    for (const op of ops) {
      const prev = seen.find((s) => s.id === op.id);
      if (prev) {
        results.push({ id: op.id, status: 'DUPLICATE', response: prev.response ?? undefined, error: prev.error ?? undefined });
        continue;
      }
      try {
        const response = await this.apply(actor, { ...op, payload: { ...op.payload, deviceId } });
        const slim = summarize(response);
        await this.db.insert(syncOps).values({ id: op.id, outletId: actor.outletId, deviceId, type: op.type, status: 'APPLIED', response: slim });
        results.push({ id: op.id, status: 'APPLIED', response: slim });
      } catch (e: any) {
        const error = typeof e?.response === 'object' ? JSON.stringify(e.response) : String(e?.message ?? e);
        this.log.warn(`op ${op.type} ${op.id} rejected: ${error}`);
        await this.db.insert(syncOps).values({ id: op.id, outletId: actor.outletId, deviceId, type: op.type, status: 'REJECTED', error });
        results.push({ id: op.id, status: 'REJECTED', error });
      }
    }
    return { results };
  }

  private apply(actor: Actor, op: SyncOp): Promise<unknown> {
    const p = op.payload;
    switch (op.type) {
      case 'ORDER_CREATE':
        return this.orders.create(actor, p);
      case 'ORDER_ADD_ITEMS':
        return this.orders.addItems(actor, p.orderId, p.items, undefined, !!p.sendKot);
      case 'ORDER_UPDATE_ITEM':
        return this.orders.updateItem(actor, p.orderId, p.orderItemId, p.patch);
      case 'ORDER_VOID_ITEM':
        return this.orders.voidItem(actor, p.orderId, p.orderItemId, p.reason, p.qty);
      case 'KOT_SEND':
        return this.orders.sendKot(actor, p.orderId);
      case 'ORDER_DISCOUNT':
        return this.orders.setDiscount(actor, p.orderId, p.discount ?? null);
      case 'ORDER_UPDATE':
        return this.orders.update(actor, p.orderId, p.patch);
      case 'ORDER_CANCEL':
        return this.orders.cancel(actor, p.orderId, p.reason);
      case 'BILL_CREATE':
        return this.billing.createBill(actor, p.orderId, { id: p.billId, provisionalNumber: p.provisionalNumber });
      case 'PAYMENT_ADD':
        return this.billing.addPayments(actor, p.billId, p.payments);
      default:
        throw new Error(`Unknown sync op type ${op.type}`);
    }
  }

  /** Everything the POS needs to work offline. */
  async bootstrap(actor: Actor) {
    const [outlet, menu, floor, openOrders, printers] = await Promise.all([
      this.outlets.get(actor.outletId),
      this.menu.full(actor.outletId),
      this.floor.floor(actor.outletId),
      this.orders.list(actor.outletId, { status: 'OPEN,BILLED' }),
      this.outlets.listPrinters(actor.outletId),
    ]);
    return { outlet, menu, floor, openOrders, printers, serverTime: new Date().toISOString() };
  }

  async status(deviceId: string) {
    const rows = await this.db.select().from(syncOps).where(eq(syncOps.deviceId, deviceId));
    return { applied: rows.filter((r) => r.status === 'APPLIED').length, rejected: rows.filter((r) => r.status === 'REJECTED').map((r) => ({ id: r.id, type: r.type, error: r.error })) };
  }
}

/** Keep sync_ops small: store ids/numbers, not the whole order graph. */
function summarize(r: any): Record<string, unknown> {
  if (!r || typeof r !== 'object') return { value: r };
  const out: Record<string, unknown> = {};
  const o = r.order ?? r;
  if (o?.id) out.orderId = o.id;
  if (o?.orderNumber) out.orderNumber = o.orderNumber;
  if (o?.version) out.version = o.version;
  if (o?.status) out.orderStatus = o.status;
  if (r.bill) out.bill = { id: r.bill.id, billNumber: r.bill.billNumber, status: r.bill.status, grandTotal: r.bill.grandTotal, paidTotal: r.bill.paidTotal };
  if (r.kots) out.kots = r.kots.map((k: any) => ({ id: k.id, kotNumber: k.kotNumber, station: k.station }));
  if (r.change !== undefined) out.change = r.change;
  return out;
}

@ApiTags('sync')
@ApiBearerAuth()
@Controller('sync')
export class SyncController {
  constructor(private readonly svc: SyncService) {}

  @Post('push') @ApiOperation({ summary: 'Replay queued offline operations (idempotent by op id)' })
  push(@CurrentUser() u: Actor, @Body() b: { deviceId: string; ops: SyncOp[] }) {
    return this.svc.push(u, b.deviceId, b.ops ?? []);
  }
  @Get('bootstrap') @ApiOperation({ summary: 'Full snapshot for offline cache: outlet, menu, floor, open orders' })
  bootstrap(@CurrentUser() u: Actor) {
    return this.svc.bootstrap(u);
  }
  @Get('status') status(@CurrentUser() _u: Actor, @Body() _b: any) {
    return { ok: true };
  }
}

@Module({ imports: [OrdersModule, MenuModule, FloorModule, OutletsModule], controllers: [SyncController], providers: [SyncService] })
export class SyncModule {}
