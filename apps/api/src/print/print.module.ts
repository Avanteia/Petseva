import { Body, Controller, Global, Module, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EscPos } from '@rms/shared';
import { Actor, CurrentUser, RequirePerms } from '../common/auth';
import { PrintService } from './print.service';

@ApiTags('print')
@ApiBearerAuth()
@Controller('print')
export class PrintController {
  constructor(private readonly svc: PrintService) {}

  @Post('test')
  @RequirePerms('settings.write')
  @ApiOperation({ summary: 'Send a test ticket to a station printer' })
  async test(@CurrentUser() u: Actor, @Body() b: { station?: string }) {
    const p = new EscPos(42).align('center').bold(true).line('RMS PRINTER TEST').bold(false).line(new Date().toLocaleString('en-IN')).rule().line(`Station: ${b.station ?? 'BILL'}`).feed(3).cut();
    return this.svc.send(u.outletId, b.station ?? 'BILL', p.build());
  }

  @Post('raw')
  @RequirePerms('pos.bill.generate')
  @ApiOperation({ summary: 'Print raw ESC/POS (base64) to a station — used by the POS for offline-generated tickets once back online' })
  raw(@CurrentUser() u: Actor, @Body() b: { station: string; escpos: string }) {
    return this.svc.send(u.outletId, b.station, Uint8Array.from(Buffer.from(b.escpos, 'base64')));
  }
}

@Global()
@Module({ controllers: [PrintController], providers: [PrintService], exports: [PrintService] })
export class PrintModule {}
