import { Body, Controller, Get, Inject, Injectable, Module, NotFoundException, Patch, Post, Delete, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, eq } from 'drizzle-orm';
import { DEFAULT_OUTLET_SETTINGS, OutletSettings } from '@rms/shared';
import { Actor, CurrentUser, RequirePerms } from '../common/auth';
import { AuditService } from '../common/audit.service';
import { DB } from '../common/db.module';
import { Db } from '../db/client';
import { outlets, printers, users } from '../db/schema';

@Injectable()
export class OutletsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async get(outletId: string) {
    const o = await this.db.query.outlets.findFirst({ where: eq(outlets.id, outletId) });
    if (!o) throw new NotFoundException('Outlet not found');
    return { ...o, settings: { ...DEFAULT_OUTLET_SETTINGS, ...(o.settings as Partial<OutletSettings>) } as OutletSettings };
  }

  async settings(outletId: string): Promise<OutletSettings> {
    return (await this.get(outletId)).settings;
  }

  async updateSettings(actor: Actor, patch: Partial<OutletSettings> & { name?: string; addressLines?: string[]; phone?: string; gstin?: string; fssai?: string }) {
    const { name, addressLines, phone, gstin, fssai, ...settingsPatch } = patch;
    const current = await this.get(actor.outletId);
    const settings = { ...current.settings, ...settingsPatch };
    await this.db
      .update(outlets)
      .set({ settings, ...(name && { name }), ...(addressLines && { addressLines }), ...(phone !== undefined && { phone }), ...(gstin !== undefined && { gstin }), ...(fssai !== undefined && { fssai }) })
      .where(eq(outlets.id, actor.outletId));
    await this.audit.log(this.db, actor, 'SETTINGS_UPDATE', 'outlet', actor.outletId, { patch });
    return this.get(actor.outletId);
  }

  listPrinters(outletId: string) {
    return this.db.select().from(printers).where(eq(printers.outletId, outletId));
  }

  async upsertPrinter(actor: Actor, body: any) {
    const data = { outletId: actor.outletId, name: body.name, station: body.station, kind: body.kind ?? 'NETWORK', host: body.host ?? null, port: body.port ?? 9100, width: body.width ?? 42, active: body.active ?? true };
    if (body.id) {
      const [row] = await this.db.update(printers).set(data).where(and(eq(printers.id, body.id), eq(printers.outletId, actor.outletId))).returning();
      return row;
    }
    const [row] = await this.db.insert(printers).values(data).returning();
    return row;
  }

  async deletePrinter(actor: Actor, id: string) {
    await this.db.delete(printers).where(and(eq(printers.id, id), eq(printers.outletId, actor.outletId)));
    return { ok: true };
  }

  listUsers(outletId: string) {
    return this.db
      .select({ id: users.id, name: users.name, username: users.username, role: users.role, active: users.active, hasPin: users.pinHash })
      .from(users)
      .where(eq(users.outletId, outletId));
  }
}

@ApiTags('outlets')
@ApiBearerAuth()
@Controller('outlets')
export class OutletsController {
  constructor(private readonly svc: OutletsService) {}

  @Get('me') me(@CurrentUser() u: Actor) {
    return this.svc.get(u.outletId);
  }
  @Patch('me/settings') @RequirePerms('settings.write') update(@CurrentUser() u: Actor, @Body() body: any) {
    return this.svc.updateSettings(u, body);
  }
  @Get('me/printers') printers(@CurrentUser() u: Actor) {
    return this.svc.listPrinters(u.outletId);
  }
  @Post('me/printers') @RequirePerms('settings.write') upsertPrinter(@CurrentUser() u: Actor, @Body() body: any) {
    return this.svc.upsertPrinter(u, body);
  }
  @Delete('me/printers/:id') @RequirePerms('settings.write') deletePrinter(@CurrentUser() u: Actor, @Param('id') id: string) {
    return this.svc.deletePrinter(u, id);
  }
  @Get('me/users') @RequirePerms('users.manage') users(@CurrentUser() u: Actor) {
    return this.svc.listUsers(u.outletId);
  }
}

@Module({ controllers: [OutletsController], providers: [OutletsService], exports: [OutletsService] })
export class OutletsModule {}
