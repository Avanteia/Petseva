import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { Db, Tx } from '../db/client';
import { auditLogs } from '../db/schema';
import { Actor } from './auth';
import { DB } from './db.module';

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async log(
    tx: Tx | Db,
    actor: Actor | null,
    action: string,
    entity: string,
    entityId: string | null,
    details: Record<string, unknown> = {},
    outletId?: string,
  ) {
    await tx.insert(auditLogs).values({
      outletId: outletId ?? actor!.outletId,
      userId: actor?.id ?? null,
      userName: actor ? (actor.override ? `${actor.name} (override by ${actor.override.byName})` : actor.name) : 'system',
      action,
      entity,
      entityId,
      details,
    });
  }

  list(outletId: string, opts: { from?: Date; to?: Date; action?: string; limit?: number }) {
    const conds = [eq(auditLogs.outletId, outletId)];
    if (opts.from) conds.push(gte(auditLogs.createdAt, opts.from));
    if (opts.to) conds.push(lte(auditLogs.createdAt, opts.to));
    if (opts.action) conds.push(eq(auditLogs.action, opts.action));
    return this.db
      .select()
      .from(auditLogs)
      .where(and(...conds))
      .orderBy(desc(auditLogs.createdAt))
      .limit(opts.limit ?? 200);
  }
}
