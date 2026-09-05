// Creates apps/api/.env from .env.example on first run (cross-platform).
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'apps', 'api');
const env = path.join(dir, '.env');
if (!fs.existsSync(env)) {
  fs.copyFileSync(path.join(dir, '.env.example'), env);
  console.log('[setup] created apps/api/.env from .env.example');
} else {
  console.log('[setup] apps/api/.env already exists');
}
