import { Module } from '@nestjs/common';
import { BillingController } from '../billing/billing.controller';
import { BillingService } from '../billing/billing.service';
import { FloorModule } from '../floor/floor.module';
import { MenuModule } from '../menu/menu.module';
import { OutletsModule } from '../outlets/outlets.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [FloorModule, MenuModule, OutletsModule],
  controllers: [OrdersController, BillingController],
  providers: [OrdersService, BillingService],
  exports: [OrdersService, BillingService],
})
export class OrdersModule {}
