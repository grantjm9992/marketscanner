import type { PgPool } from '../db.js';
import { usd } from '../../../domain/money.js';
import type { Usd } from '../../../domain/money.js';
import type { DailyPnlStore, DailyPnlSummary } from '../../repositories/types.js';
import { toDateKey } from '../../repositories/daily-pnl.js';

export class PgDailyPnlStore implements DailyPnlStore {
  constructor(private readonly pool: PgPool) {}

  async recordTrade(date: Date, realizedPnl: Usd, fees: Usd): Promise<void> {
    await this.pool.query(
      `INSERT INTO daily_pnl (date, realized_pnl_usd, fees_paid_usd, trade_count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (date) DO UPDATE SET
         realized_pnl_usd = daily_pnl.realized_pnl_usd + EXCLUDED.realized_pnl_usd,
         fees_paid_usd    = daily_pnl.fees_paid_usd    + EXCLUDED.fees_paid_usd,
         trade_count      = daily_pnl.trade_count      + 1`,
      [toDateKey(date), realizedPnl, fees],
    );
  }

  async get(date: Date): Promise<DailyPnlSummary | null> {
    const { rows } = await this.pool.query<{
      realized_pnl_usd: number;
      fees_paid_usd: number;
      trade_count: number;
    }>(`SELECT realized_pnl_usd, fees_paid_usd, trade_count FROM daily_pnl WHERE date = $1`, [
      toDateKey(date),
    ]);
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      realizedPnlUsd: usd(Number(r.realized_pnl_usd)),
      feesPaidUsd: usd(Number(r.fees_paid_usd)),
      tradeCount: r.trade_count,
    };
  }
}
