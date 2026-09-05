import { Body, Controller, Delete, Get, Inject, Injectable, Module, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Actor, CurrentUser, RequirePerms } from '../common/auth';
import { DB } from '../common/db.module';
import { EventsService } from '../common/events.service';
import { Db, Tx } from '../db/client';
import { areas, orderItems, orders, tables } from '../db/schema';

@Injectable()
export class FloorService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly events: EventsService,
  ) {}

  /** Areas → tables with live status + running order summary (amount, item count, age). */
  async floor(outletId: string) {
    const [ars, tbls] = await Promise.all([
      this.db.select().from(areas).where(and(eq(areas.outletId, outletId), eq(areas.active, true))).orderBy(asc(areas.sortOrder)),
      this.db.select().from(tables).where(and(eq(tables.outletId, outletId), eq(tables.active, true))).orderBy(asc(tables.sortOrder)),
    ]);
    const orderIds = tbls.map((t) => t.currentOrderId).filter((x): x is string => !!x);
    const runningOrders = orderIds.length
      ? await this.db.query.orders.findMany({ where: inArray(orders.id, orderIds), with: { items: true } })
      : [];
    const byId = new Map(runningOrders.map((o) => [o.id, o]));
    return ars.map((a) => ({
      ...a,
      tables: tbls
        .filter((t) => t.areaId === a.id)
        .map((t) => {
          const o = t.currentOrderId ? byId.get(t.currentOrderId) : undefined;
          const live = o?.items.filter((i) => i.status !== 'VOIDED') ?? [];
          return {
            ...t,
            order: o
              ? {
                  id: o.id,
                  orderNumber: o.orderNumber,
                  status: o.status,
                  covers: o.covers,
                  createdAt: o.createdAt,
                  itemCount: live.reduce((n, i) => n + i.qty, 0),
                  pendingKot: live.some((i) => i.status === 'PENDING'),
                  approxTotal: live.reduce((n, i) => n + (i.unitPrice + i.addons.reduce((a, x) => a + x.price, 0)) * i.qty, 0),
                }
              : null,
          };
        }),
    }));
  }

  async setTableStatus(tx: Tx | Db, outletId: string, tableId: string, status: string, currentOrderId: string | null) {
    await tx.update(tables).set({ status, currentOrderId }).where(and(eq(tables.id, tableId), eq(tables.outletId, outletId)));
    this.events.publish({ type: 'table.updated', outletId, tableId, status, currentOrderId });
  }

  async upsertArea(actor: Actor, body: any) {
    const data = { outletId: actor.outletId, name: body.name, sortOrder: body.sortOrder ?? 0, active: body.active ?? true };
    const [row] = body.id
      ? await this.db.update(areas).set(data).where(and(eq(areas.id, body.id), eq(areas.outletId, actor.outletId))).returning()
      : await this.db.insert(areas).values(data).returning();
    this.events.publish({ type: 'floor.updated', outletId: actor.outletId });
    return row;
  }

  async upsertTable(actor: Actor, body: any) {
    const data = {
      outletId: actor.outletId,
      areaId: body.areaId,
      name: body.name,
      capacity: body.capacity ?? 4,
      posX: body.posX ?? 0,
      posY: body.posY ?? 0,
      shape: body.shape ?? 'square',
      sortOrder: body.sortOrder ?? 0,
      active: body.active ?? true,
    };
    const [row] = body.id
      ? await this.db.update(tables).set(data).where(and(eq(tables.id, body.id), eq(tables.outletId, actor.outletId))).returning()
      : await this.db.insert(tables).values(data).returning();
    if (!row) throw new NotFoundException('Table not found');
    this.events.publish({ type: 'floor.updated', outletId: actor.outletId });
    return row;
  }

  async reserve(actor: Actor, tableId: string, reserved: boolean) {
    const t = await this.db.query.tables.findFirst({ where: and(eq(tables.id, tableId), eq(tables.outletId, actor.outletId)) });
    if (!t) throw new NotFoundException('Table not found');
    if (t.currentOrderId) return t;
    await this.setTableStatus(this.db, actor.outletId, tableId, reserved ? 'RESERVED' : 'FREE', null);
    return { ...t, status: reserved ? 'RESERVED' : 'FREE' };
  }

  async deleteTable(actor: Actor, id: string) {
    await this.db.update(tables).set({ active: false }).where(and(eq(tables.id, id), eq(tables.outletId, actor.outletId)));
    this.events.publish({ type: 'floor.updated', outletId: actor.outletId });
    return { ok: true };
  }
}

@ApiTags('floor')
@ApiBearerAuth()
@Controller('floor')
export class FloorController {
  constructor(private readonly svc: FloorService) {}

  @Get() @ApiOperation({ summary: 'Areas + tables with live status' }) floor(@CurrentUser() u: Actor) {
    return this.svc.floor(u.outletId);
  }
  @Post('areas') @RequirePerms('tables.write') area(@CurrentUser() u: Actor, @Body() b: any) {
    return this.svc.upsertArea(u, b);
  }
  @Post('tables') @RequirePerms('tables.write') table(@CurrentUser() u: Actor, @Body() b: any) {
    return this.svc.upsertTable(u, b);
  }
  @Delete('tables/:id') @RequirePerms('tables.write') del(@CurrentUser() u: Actor, @Param('id') id: string) {
    return this.svc.deleteTable(u, id);
  }
  @Post('tables/:id/reserve') reserve(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { reserved: boolean }) {
    return this.svc.reserve(u, id, b.reserved !== false);
  }
}

@Module({ controllers: [FloorController], providers: [FloorService], exports: [FloorService] })
export class FloorModule {}
// keep import used for typing in other modules
void orderItems;
