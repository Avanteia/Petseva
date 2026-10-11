import { Module } from '@nestjs/common';
import { PurchasingController } from './purchasing.controller';
import { PurchasingService } from './purchasing.service';

@Module({ controllers: [PurchasingController], providers: [PurchasingService], exports: [PurchasingService] })
export class PurchasingModule {}
