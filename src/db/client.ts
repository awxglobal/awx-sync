import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const queryClient = postgres(process.env.DATABASE_URL, { prepare: false });

export const db = drizzle(queryClient, { schema });
export { schema };
