import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser, RequirePerms } from '../common/auth';
import { CreateOrderInput, NewItemInput, OrdersService } from './orders.service';

@ApiTags('orders')
@ApiBearerAuth()
@Controller()
export class OrdersController {
  constructor(private readonly svc: OrdersService) {}

  @Get('orders') list(@CurrentUser() u: Actor, @Query() q: any) {
    return this.svc.list(u.outletId, { status: q.status, type: q.type, from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined, limit: q.limit ? Number(q.limit) : undefined });
  }
  @Get('orders/:id') get(@CurrentUser() u: Actor, @Param('id') id: string) {
    return this.svc.get(u.outletId, id);
  }
  @Post('orders') @RequirePerms('pos.order.create') @ApiOperation({ summary: 'Create order with items (idempotent by client id). sendKot=true also fires KOTs.' })
  create(@CurrentUser() u: Actor, @Body() b: CreateOrderInput) {
    return this.svc.create(u, b);
  }
  @Post('orders/:id/items') @RequirePerms('pos.order.edit')
  addItems(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { items: NewItemInput[]; expectedVersion?: number; sendKot?: boolean }) {
    return this.svc.addItems(u, id, b.items, b.expectedVersion, !!b.sendKot);
  }
  @Patch('orders/:id/items/:itemId') @RequirePerms('pos.order.edit')
  updateItem(@CurrentUser() u: Actor, @Param('id') id: string, @Param('itemId') itemId: string, @Body() b: any) {
    return this.svc.updateItem(u, id, itemId, { qty: b.qty, note: b.note, discount: b.discount }, b.expectedVersion);
  }
  @Post('orders/:id/items/:itemId/void') @RequirePerms('pos.order.edit') @ApiOperation({ summary: 'Void an item (reason required; sent items need pos.order.void_item or manager override)' })
  voidItem(@CurrentUser() u: Actor, @Param('id') id: string, @Param('itemId') itemId: string, @Body() b: { reason: string; qty?: number; expectedVersion?: number }) {
    return this.svc.voidItem(u, id, itemId, b.reason, b.qty, b.expectedVersion);
  }
  @Post('orders/:id/kot') @RequirePerms('pos.kot.send') @ApiOperation({ summary: 'Send pending items to kitchen → one KOT per station, printed/route to KDS' })
  kot(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { expectedVersion?: number }) {
    return this.svc.sendKot(u, id, b?.expectedVersion);
  }
  @Post('orders/:id/discount') @RequirePerms('pos.bill.discount')
  discount(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { discount: any; expectedVersion?: number }) {
    return this.svc.setDiscount(u, id, b.discount ?? null, b.expectedVersion);
  }
  @Patch('orders/:id') @RequirePerms('pos.order.edit')
  update(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: any) {
    const { expectedVersion, ...patch } = b;
    return this.svc.update(u, id, patch, expectedVersion);
  }
  @Post('orders/:id/cancel') @RequirePerms('pos.order.edit')
  cancel(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { reason: string; expectedVersion?: number }) {
    return this.svc.cancel(u, id, b.reason, b.expectedVersion);
  }
  @Post('orders/:id/transfer') @RequirePerms('pos.table.transfer')
  transfer(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { tableId: string; expectedVersion?: number }) {
    return this.svc.transfer(u, id, b.tableId, b.expectedVersion);
  }
  @Post('orders/:id/merge-into/:targetId') @RequirePerms('pos.table.merge')
  merge(@CurrentUser() u: Actor, @Param('id') id: string, @Param('targetId') targetId: string) {
    return this.svc.merge(u, id, targetId);
  }
  @Post('orders/:id/split') @RequirePerms('pos.order.edit') @ApiOperation({ summary: 'Move selected items into a new order for separate billing' })
  split(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { parts: { orderItemId: string; qty: number }[]; expectedVersion?: number }) {
    return this.svc.split(u, id, b.parts, b.expectedVersion);
  }

  // KOTs
  @Get('kots') kots(@CurrentUser() u: Actor, @Query() q: any) {
    return this.svc.listKots(u.outletId, { status: q.status, station: q.station, limit: q.limit ? Number(q.limit) : undefined });
  }
  @Post('kots/:id/status') kotStatus(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { status: string }) {
    return this.svc.setKotStatus(u, id, b.status);
  }
  @Post('kots/:id/reprint') @RequirePerms('pos.kot.reprint') reprint(@CurrentUser() u: Actor, @Param('id') id: string) {
    return this.svc.reprintKot(u, id);
  }
}
