import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const migrationFile = join(__dirname, '../../drizzle/0001_sync_tables.sql');
const migration = readFileSync(migrationFile, 'utf-8');

console.log('Running migration: 0001_sync_tables.sql');
await sql.unsafe(migration);
await sql.end();

console.log('✓ Migration applied — 5 sync tables created.');
