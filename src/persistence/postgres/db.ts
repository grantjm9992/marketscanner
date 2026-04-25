import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
export type PgPool = pg.Pool;

const MIGRATIONS = ['001_initial.sql'];

export interface OpenPgOptions {
  /** A standard Postgres connection string (postgres://user:pass@host:port/db?sslmode=require). */
  readonly connectionString: string;
  /** Max pool size. Default 5 — generous for a single-process bot. */
  readonly poolSize?: number;
  /**
   * Whether to enable SSL. Most managed Postgres providers (incl. Railway)
   * require SSL but use self-signed certs; set true to opt in with
   * `rejectUnauthorized: false`.
   */
  readonly ssl?: boolean;
}

export async function openPgPool(opts: OpenPgOptions): Promise<PgPool> {
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.poolSize ?? 5,
    ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
  });
  await runMigrations(pool);
  return pool;
}

async function runMigrations(pool: PgPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query<{ name: string }>(`SELECT name FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.name));

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, 'migrations');

  for (const name of MIGRATIONS) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
