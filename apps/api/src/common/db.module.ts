import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { createDb, createPool, Db } from '../db/client';

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

@Global()
@Module({
  providers: [
    { provide: PG_POOL, useFactory: () => createPool() },
    { provide: DB, useFactory: (pool: Pool) => createDb(pool), inject: [PG_POOL] },
    {
      provide: 'DB_SHUTDOWN',
      useFactory: (pool: Pool): OnApplicationShutdown => ({ onApplicationShutdown: () => pool.end() }),
      inject: [PG_POOL],
    },
  ],
  exports: [DB, PG_POOL],
})
export class DbModule {}

export type { Db };
