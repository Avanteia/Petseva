import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { createDb, createPool } from './client';
import { seed } from './seed';

async function main() {
  const pool = createPool();
  console.log('[reset] dropping schema public');
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;');
  const db = createDb(pool);
  await migrate(db, { migrationsFolder: path.join(__dirname, '..', '..', 'drizzle') });
  await seed(db);
  await pool.end();
  console.log('[reset] done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
