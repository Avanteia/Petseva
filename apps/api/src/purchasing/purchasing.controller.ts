import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser, RequirePerms } from '../common/auth';
import { PurchasingService } from './purchasing.service';

@ApiTags('purchasing')
@ApiBearerAuth()
@Controller('purchasing')
export class PurchasingController {
  constructor(private readonly svc: PurchasingService) {}

  @Get('vendors') @RequirePerms('purchase.read')
  vendors(@CurrentUser() u: Actor) {
    return this.svc.listVendors(u.outletId);
  }

  @Post('vendors') @RequirePerms('purchase.write')
  upsertVendor(@CurrentUser() u: Actor, @Body() body: any) {
    return this.svc.upsertVendor(u, body);
  }

  @Get('purchase-orders') @RequirePerms('purchase.read')
  list(@CurrentUser() u: Actor, @Query('status') status?: string) {
    return this.svc.list(u.outletId, { status });
  }

  @Post('purchase-orders') @RequirePerms('purchase.write')
  create(@CurrentUser() u: Actor, @Body() body: any) {
    return this.svc.create(u, body);
  }

  @Post('purchase-orders/:id/receive') @RequirePerms('purchase.write')
  receive(@CurrentUser() u: Actor, @Param('id') id: string) {
    return this.svc.receive(u, id);
  }
}
