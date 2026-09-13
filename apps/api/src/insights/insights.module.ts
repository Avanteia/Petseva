import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ReportsModule } from '../reports/reports.module';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

@Module({
  imports: [ReportsModule, AiModule],
  controllers: [InsightsController],
  providers: [InsightsService],
})
export class InsightsModule {}
