import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser, RequirePerms } from '../common/auth';
import { InventoryService } from './inventory.service';

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Get('raw-materials') @RequirePerms('inventory.read')
  list(@CurrentUser() u: Actor) {
    return this.svc.listRawMaterials(u.outletId);
  }

  @Post('raw-materials') @RequirePerms('inventory.write')
  upsert(@CurrentUser() u: Actor, @Body() body: any) {
    return this.svc.upsertRawMaterial(u, body);
  }

  @Get('recipes/:menuItemId') @RequirePerms('inventory.read')
  recipe(@CurrentUser() u: Actor, @Param('menuItemId') id: string) {
    return this.svc.recipe(u.outletId, id);
  }

  @Post('recipes/:menuItemId') @RequirePerms('inventory.write')
  setRecipe(@CurrentUser() u: Actor, @Param('menuItemId') id: string, @Body() body: { lines: { rawMaterialId: string; qtyPerUnit: number }[] }) {
    return this.svc.setRecipe(u, id, body.lines ?? []);
  }

  @Get('stock-movements') @RequirePerms('inventory.read')
  movements(@CurrentUser() u: Actor, @Query('rawMaterialId') rawMaterialId?: string, @Query('limit') limit?: string) {
    return this.svc.listMovements(u.outletId, { rawMaterialId, limit: limit ? Number(limit) : undefined });
  }

  @Post('stock-movements') @RequirePerms('inventory.write')
  record(@CurrentUser() u: Actor, @Body() body: any) {
    return this.svc.recordMovement(u, body);
  }
}
