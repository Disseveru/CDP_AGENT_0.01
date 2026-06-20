import pg from "pg";

import { CONFIG } from "./config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!CONFIG.databaseUrl) {
    throw new Error("DATABASE_URL is required for Postgres storage");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: CONFIG.databaseUrl,
      max: 10,
      ssl: CONFIG.databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
