import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const migrationClient = postgres(process.env.DATABASE_URL, {
  max: 1,
  prepare: false,
});

await migrate(drizzle(migrationClient), { migrationsFolder: './drizzle' });
await migrationClient.end();

console.log('Migrations applied.');
