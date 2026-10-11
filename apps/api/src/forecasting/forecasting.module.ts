import { Module } from '@nestjs/common';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { ForecastingController } from './forecasting.controller';
import { ForecastingService } from './forecasting.service';

@Module({ imports: [PurchasingModule], controllers: [ForecastingController], providers: [ForecastingService] })
export class ForecastingModule {}
