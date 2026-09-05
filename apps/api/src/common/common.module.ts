import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditService } from './audit.service';
import { EventsService } from './events.service';
import { NumberingService } from './numbering.service';

@Global()
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN ?? '12h') as any },
    }),
  ],
  providers: [AuditService, EventsService, NumberingService],
  exports: [AuditService, EventsService, NumberingService, JwtModule],
})
export class CommonModule {}
