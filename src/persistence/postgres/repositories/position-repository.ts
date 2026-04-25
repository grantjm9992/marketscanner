import type { PgPool } from '../db.js';
import { price, size, usd } from '../../../domain/money.js';
import type { Position } from '../../../domain/portfolio.js';
import type { PositionStore } from '../../repositories/types.js';

export class PgPositionStore implements PositionStore {
  constructor(private readonly pool: PgPool) {}

  async upsert(p: Position, at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO position (market_id, token_id, size, avg_entry_price, realized_pnl_usd, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (market_id, token_id) DO UPDATE SET
         size = EXCLUDED.size,
         avg_entry_price = EXCLUDED.avg_entry_price,
         realized_pnl_usd = EXCLUDED.realized_pnl_usd,
         updated_at = EXCLUDED.updated_at`,
      [p.marketId, p.tokenId, p.size, p.avgEntryPrice, p.realizedPnlUsd, at.toISOString()],
    );
  }

  async get(marketId: string, tokenId: string): Promise<Position | null> {
    const { rows } = await this.pool.query<RawRow>(
      `SELECT * FROM position WHERE market_id = $1 AND token_id = $2`,
      [marketId, tokenId],
    );
    if (rows.length === 0) return null;
    return rowToPosition(rows[0]!);
  }

  async all(): Promise<readonly Position[]> {
    const { rows } = await this.pool.query<RawRow>(`SELECT * FROM position`);
    return rows.map(rowToPosition);
  }

  async remove(marketId: string, tokenId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM position WHERE market_id = $1 AND token_id = $2`,
      [marketId, tokenId],
    );
  }
}

interface RawRow {
  market_id: string;
  token_id: string;
  size: number;
  avg_entry_price: number;
  realized_pnl_usd: number;
}

function rowToPosition(row: RawRow): Position {
  return {
    marketId: row.market_id,
    tokenId: row.token_id,
    size: size(Number(row.size)),
    avgEntryPrice: price(Number(row.avg_entry_price)),
    realizedPnlUsd: usd(Number(row.realized_pnl_usd)),
  };
}
