import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser, RequirePerms } from '../common/auth';
import { PricingService } from './pricing.service';

@ApiTags('pricing')
@ApiBearerAuth()
@Controller('pricing')
export class PricingController {
  constructor(private readonly svc: PricingService) {}

  @Get('menu-engineering') @RequirePerms('pricing.read')
  menuEngineering(@CurrentUser() u: Actor) {
    return this.svc.menuEngineering(u.outletId);
  }

  @Get('combo-suggestions') @RequirePerms('pricing.read')
  combos(@CurrentUser() u: Actor) {
    return this.svc.comboSuggestions(u.outletId);
  }

  @Get('suggestions') @RequirePerms('pricing.read')
  suggestions(@CurrentUser() u: Actor) {
    return this.svc.suggestions(u.outletId);
  }
}
