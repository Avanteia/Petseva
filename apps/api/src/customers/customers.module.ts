import { Body, Controller, Get, Inject, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { Actor, CurrentUser } from '../common/auth';
import { DB } from '../common/db.module';
import { Db } from '../db/client';
import { customers, orders } from '../db/schema';

@Injectable()
export class CustomersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  search(outletId: string, q: string) {
    const term = `%${q}%`;
    return this.db
      .select()
      .from(customers)
      .where(and(eq(customers.outletId, outletId), or(ilike(customers.phone, term), ilike(customers.name, term))))
      .orderBy(desc(customers.lastVisitAt))
      .limit(20);
  }

  async byPhone(outletId: string, phone: string) {
    const p = phone.replace(/\D/g, '');
    const c = await this.db.query.customers.findFirst({ where: and(eq(customers.outletId, outletId), eq(customers.phone, p)) });
    if (!c) return null;
    const history = await this.db.select().from(orders).where(and(eq(orders.customerId, c.id), eq(orders.status, 'SETTLED'))).orderBy(desc(orders.createdAt)).limit(20);
    return { ...c, history };
  }

  async upsert(outletId: string, body: { phone: string; name?: string; email?: string; address?: string }) {
    const p = body.phone.replace(/\D/g, '');
    const [c] = await this.db
      .insert(customers)
      .values({ outletId, phone: p, name: body.name ?? null, email: body.email ?? null, address: body.address ?? null })
      .onConflictDoUpdate({
        target: [customers.outletId, customers.phone],
        set: { name: body.name ?? sql`${customers.name}`, email: body.email ?? sql`${customers.email}`, address: body.address ?? sql`${customers.address}` },
      })
      .returning();
    return c;
  }
}

@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly svc: CustomersService) {}
  @Get() search(@CurrentUser() u: Actor, @Query('q') q = '') {
    return this.svc.search(u.outletId, q);
  }
  @Get('by-phone/:phone') byPhone(@CurrentUser() u: Actor, @Param('phone') phone: string) {
    return this.svc.byPhone(u.outletId, phone);
  }
  @Post() upsert(@CurrentUser() u: Actor, @Body() b: any) {
    return this.svc.upsert(u.outletId, b);
  }
}

@Module({ controllers: [CustomersController], providers: [CustomersService] })
export class CustomersModule {}
