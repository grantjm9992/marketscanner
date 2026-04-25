import type { Db } from '../db.js';
import { usd } from '../../domain/money.js';
import type { Usd } from '../../domain/money.js';
import type { DailyPnlStore, DailyPnlSummary } from './types.js';

export class SqliteDailyPnlStore implements DailyPnlStore {
  private readonly upsertStmt;
  private readonly getStmt;

  constructor(private readonly db: Db) {
    this.upsertStmt = db.prepare(`
      INSERT INTO daily_pnl (date, realized_pnl_usd, fees_paid_usd, trade_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(date) DO UPDATE SET
        realized_pnl_usd = realized_pnl_usd + excluded.realized_pnl_usd,
        fees_paid_usd = fees_paid_usd + excluded.fees_paid_usd,
        trade_count = trade_count + 1
    `);
    this.getStmt = db.prepare(`SELECT * FROM daily_pnl WHERE date = ?`);
  }

  async recordTrade(date: Date, realizedPnl: Usd, fees: Usd): Promise<void> {
    this.upsertStmt.run(toDateKey(date), realizedPnl, fees);
  }

  async get(date: Date): Promise<DailyPnlSummary | null> {
    const row = this.getStmt.get(toDateKey(date)) as
      | { realized_pnl_usd: number; fees_paid_usd: number; trade_count: number }
      | undefined;
    if (!row) return null;
    return {
      realizedPnlUsd: usd(row.realized_pnl_usd),
      feesPaidUsd: usd(row.fees_paid_usd),
      tradeCount: row.trade_count,
    };
  }
}

export function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export { SqliteDailyPnlStore as DailyPnlRepository };
