import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Db, Tx } from '../db/client';
import { counters } from '../db/schema';
import { DB } from './db.module';

/** Atomic per-outlet sequence numbers using INSERT … ON CONFLICT … RETURNING (safe under concurrency). */
@Injectable()
export class NumberingService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async next(tx: Tx | Db, outletId: string, key: string): Promise<number> {
    const rows = await tx
      .insert(counters)
      .values({ outletId, key, value: 1 })
      .onConflictDoUpdate({ target: [counters.outletId, counters.key], set: { value: sql`${counters.value} + 1` } })
      .returning({ value: counters.value });
    return rows[0].value;
  }

  static dayKey(date = new Date(), tz = 'Asia/Kolkata'): string {
    // YYYYMMDD in outlet timezone
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    return parts.replace(/-/g, '');
  }

  async orderNumber(tx: Tx | Db, outletId: string, tz?: string): Promise<string> {
    const day = NumberingService.dayKey(new Date(), tz);
    const n = await this.next(tx, outletId, `order:${day}`);
    return `${day.slice(2)}-${n}`; // e.g. 260904-12
  }

  async kotNumber(tx: Tx | Db, outletId: string, tz?: string): Promise<string> {
    const day = NumberingService.dayKey(new Date(), tz);
    const n = await this.next(tx, outletId, `kot:${day}`);
    return String(n);
  }

  async billNumber(tx: Tx | Db, outletId: string, prefix = 'INV'): Promise<string> {
    const n = await this.next(tx, outletId, 'bill');
    return `${prefix}-${String(n).padStart(6, '0')}`;
  }
}
