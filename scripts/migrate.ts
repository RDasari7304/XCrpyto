/**
 * Applies db/schema.sql. Replaces `psql "$DATABASE_URL" -f db/schema.sql`,
 * which only works in a POSIX shell — Windows cmd does not expand $VAR, and
 * this also drops the dependency on psql being on PATH.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, '..', 'db', 'schema.sql'), 'utf8');

try {
  await db.query(sql);
  console.log('Schema applied.');
} catch (err) {
  console.error('\nMigration failed:', err instanceof Error ? err.message : err);
  console.error('\nCheck DATABASE_URL in .env. On Windows the Postgres installer');
  console.error('sets a password during setup, so the default postgres:postgres');
  console.error('almost certainly needs changing.');
  process.exitCode = 1;
} finally {
  await db.end();
}
