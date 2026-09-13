import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser, RequirePerms } from '../common/auth';
import { InsightsService } from './insights.service';

@ApiTags('insights')
@ApiBearerAuth()
@Controller('insights')
export class InsightsController {
  constructor(private readonly svc: InsightsService) {}

  @Get('daily') @RequirePerms('insights.read') @ApiOperation({ summary: 'Natural-language daily summary + anomalies (defaults to today)' })
  daily(@CurrentUser() u: Actor, @Query('date') date?: string) {
    return this.svc.dailySummary(u.outletId, date);
  }

  @Get('weekly') @RequirePerms('insights.read') @ApiOperation({ summary: 'Trailing 7-day rollup summary + anomalies' })
  weekly(@CurrentUser() u: Actor, @Query('end') end?: string) {
    return this.svc.weeklySummary(u.outletId, end);
  }

  @Get('anomalies') @RequirePerms('insights.read') @ApiOperation({ summary: 'Raw anomaly findings (discounts/voids/sales dips/item trends), no narration' })
  anomalies(@CurrentUser() u: Actor, @Query('days') days?: string) {
    return this.svc.anomalies(u.outletId, days ? Number(days) : undefined);
  }

  @Get('staff-outliers') @RequirePerms('insights.read') @ApiOperation({ summary: 'Per-staff void-rate outliers' })
  staffOutliers(@CurrentUser() u: Actor, @Query('days') days?: string) {
    return this.svc.staffOutliers(u.outletId, days ? Number(days) : undefined);
  }
}
