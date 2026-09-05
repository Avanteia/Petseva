import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { AuthGuard, Public } from './common/auth';
import { CommonModule } from './common/common.module';
import { DbModule } from './common/db.module';
import { CustomersModule } from './customers/customers.module';
import { FloorModule } from './floor/floor.module';
import { MenuModule } from './menu/menu.module';
import { OrdersModule } from './orders/orders.module';
import { OutletsModule } from './outlets/outlets.module';
import { PrintModule } from './print/print.module';
import { RealtimeModule } from './realtime/realtime.gateway';
import { ReportsModule } from './reports/reports.module';
import { SyncModule } from './sync/sync.module';

@Controller()
class HealthController {
  @Public() @Get('health') health() {
    return { ok: true, time: new Date().toISOString() };
  }
}

@Module({
  imports: [DbModule, CommonModule, PrintModule, AuthModule, OutletsModule, MenuModule, FloorModule, OrdersModule, SyncModule, RealtimeModule, CustomersModule, ReportsModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
