import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser, RequirePerms } from '../common/auth';
import { BillingService, PaymentInput } from './billing.service';

@ApiTags('billing')
@ApiBearerAuth()
@Controller()
export class BillingController {
  constructor(private readonly svc: BillingService) {}

  @Get('orders/:id/bill/preview') @ApiOperation({ summary: 'Compute totals for an order without billing' })
  preview(@CurrentUser() u: Actor, @Param('id') id: string) {
    return this.svc.preview(u.outletId, id);
  }

  @Post('orders/:id/bill') @RequirePerms('pos.bill.generate') @ApiOperation({ summary: 'Generate the bill (auto-sends pending KOT). Idempotent per order.' })
  create(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { id?: string; provisionalNumber?: string; print?: boolean }) {
    return this.svc.createBill(u, id, b ?? {});
  }

  @Get('bills') list(@CurrentUser() u: Actor, @Query() q: any) {
    return this.svc.list(u.outletId, { from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined, status: q.status, limit: q.limit ? Number(q.limit) : undefined });
  }
  @Get('bills/:id') get(@CurrentUser() u: Actor, @Param('id') id: string) {
    return this.svc.get(u.outletId, id);
  }
  @Get('bills/:id/receipt') @ApiOperation({ summary: 'Receipt as text preview + base64 ESC/POS' })
  receipt(@CurrentUser() u: Actor, @Param('id') id: string) {
    return this.svc.receipt(u.outletId, id);
  }
  @Post('bills/:id/payments') @RequirePerms('pos.payment.settle') @ApiOperation({ summary: 'Add payment(s) — multiple modes / part payments. Settles when fully paid.' })
  pay(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { payments: PaymentInput[] }) {
    return this.svc.addPayments(u, id, b.payments ?? []);
  }
  @Post('bills/:id/print') @RequirePerms('pos.bill.generate') print(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { reprint?: boolean }) {
    return this.svc.printBill(u, id, !!b?.reprint);
  }
  @Post('bills/:id/void') void(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { reason: string }) {
    return this.svc.voidBill(u, id, b.reason);
  }
  @Post('bills/:id/send') send(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { via: 'EMAIL' | 'SMS' | 'WHATSAPP'; to: string }) {
    return this.svc.sendBill(u, id, b.via, b.to);
  }
}
