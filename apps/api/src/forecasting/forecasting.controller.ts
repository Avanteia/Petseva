import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser, RequirePerms } from '../common/auth';
import { ForecastingService } from './forecasting.service';

@ApiTags('forecasting')
@ApiBearerAuth()
@Controller('forecasting')
export class ForecastingController {
  constructor(private readonly svc: ForecastingService) {}

  @Get('items/:menuItemId') @RequirePerms('inventory.read')
  itemForecast(@CurrentUser() u: Actor, @Param('menuItemId') id: string, @Query('days') days?: string) {
    return this.svc.itemDemandForecast(u.outletId, id, days ? Number(days) : undefined);
  }

  @Get('raw-materials/:rawMaterialId') @RequirePerms('inventory.read')
  rawMaterialForecast(@CurrentUser() u: Actor, @Param('rawMaterialId') id: string, @Query('days') days?: string) {
    return this.svc.rawMaterialForecast(u.outletId, id, days ? Number(days) : undefined);
  }

  @Get('reorder-suggestions') @RequirePerms('inventory.read')
  reorderSuggestions(@CurrentUser() u: Actor, @Query('days') days?: string) {
    return this.svc.reorderSuggestions(u.outletId, days ? Number(days) : undefined);
  }

  @Post('reorder-suggestions/:rawMaterialId/create-po') @RequirePerms('purchase.write')
  createPo(@CurrentUser() u: Actor, @Param('rawMaterialId') id: string) {
    return this.svc.createPoFromSuggestion(u, id);
  }
}
