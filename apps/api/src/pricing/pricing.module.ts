import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';

@Module({ imports: [AiModule], controllers: [PricingController], providers: [PricingService] })
export class PricingModule {}
