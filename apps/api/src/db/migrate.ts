import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { createDb, createPool } from './client';

async function main() {
  const pool = createPool();
  const db = createDb(pool);
  const migrationsFolder = path.join(__dirname, '..', '..', 'drizzle');
  console.log('[migrate] applying migrations from', migrationsFolder);
  await migrate(db, { migrationsFolder });
  console.log('[migrate] done');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
