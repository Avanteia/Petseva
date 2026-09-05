#!/usr/bin/env node
/**
 * Runs a command with a database available.
 *   DB_EMBEDDED=true  → boots an embedded PostgreSQL (no Docker needed) in ./.pgdata, then runs the command.
 *   otherwise         → assumes DATABASE_URL points at a running Postgres (e.g. docker-compose) and just runs the command.
 * Usage: node scripts/with-db.js <cmd> [args...]     |     node scripts/with-db.js --hold   (keep DB up until Ctrl+C)
 */
const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const hold = args[0] === '--hold';
const embedded = (process.env.DB_EMBEDDED ?? 'true') !== 'false';

function portInUse(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

async function startEmbedded() {
  const url = new URL(process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/rms');
  const mod = require('embedded-postgres');
  const EmbeddedPostgres = mod.default || mod;
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(__dirname, '..', '.pgdata'),
    user: url.username || 'postgres',
    password: url.password || 'postgres',
    port: Number(url.port || 5433),
    persistent: true,
    // Postgres refuses to run as root (Linux containers/CI): let the lib create a 'postgres' user.
    createPostgresUser: typeof process.getuid === 'function' && process.getuid() === 0,
    onLog: () => {},
    onError: (m) => {
      const msg = String(m && m.message ? m.message : m);
      // noise from the library's own maintenance connection being closed on shutdown
      if (/administrator command|terminated unexpectedly/i.test(msg)) return;
      process.stderr.write(msg + '\n');
    },
  });
  const dbName = url.pathname.replace('/', '') || 'rms';
  const fs = require('fs');
  if (!fs.existsSync(path.join(__dirname, '..', '.pgdata', 'PG_VERSION'))) {
    console.log('[db] initialising embedded PostgreSQL cluster (first run)…');
    await pg.initialise();
  }
  if (await portInUse(Number(url.port || 5433))) {
    console.log('[db] something is already listening on the DB port, assuming PostgreSQL is up and reusing it');
    return null;
  }
  try {
    await pg.start();
  } catch (e) {
    throw new Error('could not start PostgreSQL: ' + (e && e.message ? e.message : String(e)));
  }
  try {
    await pg.createDatabase(dbName);
  } catch (e) {
    /* exists */
  }
  console.log(`[db] embedded PostgreSQL up on port ${url.port || 5433}`);
  return pg;
}

(async () => {
  let pg = null;
  if (embedded) {
    try {
      pg = await startEmbedded();
    } catch (e) {
      console.error('[db] failed to start embedded PostgreSQL:', e && e.message ? e.message : e);
      console.error('[db] set DB_EMBEDDED=false and point DATABASE_URL at your own Postgres if you prefer.');
      process.exit(1);
    }
  }
  const stop = async () => {
    if (pg) {
      try {
        await pg.stop();
      } catch {}
    }
  };
  if (hold) {
    console.log('[db] holding. Press Ctrl+C to stop.');
    process.on('SIGINT', async () => {
      await stop();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await stop();
      process.exit(0);
    });
    setInterval(() => {}, 1 << 30);
    return;
  }
  const [cmd, ...rest] = args;
  const child = spawn(cmd, rest, { stdio: 'inherit', shell: process.platform === 'win32', env: process.env });
  const forward = (sig) => () => child.kill(sig);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('exit', async (code) => {
    await stop();
    process.exit(code ?? 0);
  });
})();
