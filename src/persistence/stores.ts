import { openDatabase } from './db.js';
import { openPgPool } from './postgres/db.js';
import { SqliteTradeLogStore } from './repositories/trade-log.js';
import { SqliteMarketSnapshotStore } from './repositories/market-snapshot.js';
import { SqlitePositionStore } from './repositories/position-repository.js';
import { SqliteDailyPnlStore } from './repositories/daily-pnl.js';
import { PgTradeLogStore } from './postgres/repositories/trade-log.js';
import { PgMarketSnapshotStore } from './postgres/repositories/market-snapshot.js';
import { PgPositionStore } from './postgres/repositories/position-repository.js';
import { PgDailyPnlStore } from './postgres/repositories/daily-pnl.js';
import type { Stores, TradeLogMode } from './repositories/types.js';

export type DatabaseKind = 'sqlite' | 'postgres';

export interface OpenStoresOptions {
  readonly kind: DatabaseKind;
  readonly mode: TradeLogMode;
  /** Required when kind === 'sqlite'. Path to .db file or ':memory:'. */
  readonly sqlitePath?: string;
  /** Required when kind === 'postgres'. Standard postgres:// connection string. */
  readonly pgConnectionString?: string;
  /** Whether to enable SSL on the PG connection (Railway/most managed PG = true). */
  readonly pgSsl?: boolean;
}

/**
 * Open a Stores bundle with the requested backend, run migrations, and
 * return store implementations + a close() function.
 */
export async function openStores(opts: OpenStoresOptions): Promise<Stores> {
  if (opts.kind === 'postgres') {
    if (!opts.pgConnectionString) {
      throw new Error('openStores: pgConnectionString is required when kind=postgres');
    }
    const pool = await openPgPool({
      connectionString: opts.pgConnectionString,
      ssl: opts.pgSsl ?? true,
    });
    return {
      tradeLog: new PgTradeLogStore(pool, opts.mode),
      marketSnapshot: new PgMarketSnapshotStore(pool),
      position: new PgPositionStore(pool),
      dailyPnl: new PgDailyPnlStore(pool),
      close: async () => {
        await pool.end();
      },
    };
  }

  if (!opts.sqlitePath) {
    throw new Error('openStores: sqlitePath is required when kind=sqlite');
  }
  const db = openDatabase(opts.sqlitePath);
  return {
    tradeLog: new SqliteTradeLogStore(db, opts.mode),
    marketSnapshot: new SqliteMarketSnapshotStore(db),
    position: new SqlitePositionStore(db),
    dailyPnl: new SqliteDailyPnlStore(db),
    close: async () => {
      db.close();
    },
  };
}

export type { Stores } from './repositories/types.js';
