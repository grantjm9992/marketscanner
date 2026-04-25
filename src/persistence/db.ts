import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

export type Db = Database.Database;

const MIGRATIONS = ['001_initial.sql'];

/**
 * Open the SQLite database at `path`, run any pending migrations, and
 * return the handle. Caller owns lifecycle: call `db.close()` on shutdown.
 */
export function openDatabase(path: string): Db {
  ensureParentDir(path);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function ensureParentDir(path: string): void {
  if (path === ':memory:') return;
  const dir = dirname(path);
  if (dir && dir !== '.') {
    mkdirSync(dir, { recursive: true });
  }
}

function runMigrations(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((r) => (r as { name: string }).name),
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, 'migrations');
  const insert = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  );

  const tx = db.transaction((name: string, sql: string) => {
    db.exec(sql);
    insert.run(name, new Date().toISOString());
  });

  for (const name of MIGRATIONS) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    tx(name, sql);
  }
}
