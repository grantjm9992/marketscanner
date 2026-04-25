import type { Db } from '../db.js';
import { price, size, usd } from '../../domain/money.js';
import type { Position } from '../../domain/portfolio.js';

export class PositionRepository {
  private readonly upsertStmt;
  private readonly getAllStmt;
  private readonly getOneStmt;
  private readonly deleteStmt;

  constructor(private readonly db: Db) {
    this.upsertStmt = db.prepare(`
      INSERT INTO position (market_id, token_id, size, avg_entry_price, realized_pnl_usd, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(market_id, token_id) DO UPDATE SET
        size = excluded.size,
        avg_entry_price = excluded.avg_entry_price,
        realized_pnl_usd = excluded.realized_pnl_usd,
        updated_at = excluded.updated_at
    `);
    this.getAllStmt = db.prepare(`SELECT * FROM position`);
    this.getOneStmt = db.prepare(
      `SELECT * FROM position WHERE market_id = ? AND token_id = ?`,
    );
    this.deleteStmt = db.prepare(
      `DELETE FROM position WHERE market_id = ? AND token_id = ?`,
    );
  }

  upsert(p: Position, at: Date): void {
    this.upsertStmt.run(
      p.marketId,
      p.tokenId,
      p.size,
      p.avgEntryPrice,
      p.realizedPnlUsd,
      at.toISOString(),
    );
  }

  get(marketId: string, tokenId: string): Position | null {
    const row = this.getOneStmt.get(marketId, tokenId) as
      | {
          market_id: string;
          token_id: string;
          size: number;
          avg_entry_price: number;
          realized_pnl_usd: number;
        }
      | undefined;
    if (!row) return null;
    return rowToPosition(row);
  }

  all(): readonly Position[] {
    const rows = this.getAllStmt.all() as Array<{
      market_id: string;
      token_id: string;
      size: number;
      avg_entry_price: number;
      realized_pnl_usd: number;
    }>;
    return rows.map(rowToPosition);
  }

  remove(marketId: string, tokenId: string): void {
    this.deleteStmt.run(marketId, tokenId);
  }
}

function rowToPosition(row: {
  market_id: string;
  token_id: string;
  size: number;
  avg_entry_price: number;
  realized_pnl_usd: number;
}): Position {
  return {
    marketId: row.market_id,
    tokenId: row.token_id,
    size: size(row.size),
    avgEntryPrice: price(row.avg_entry_price),
    realizedPnlUsd: usd(row.realized_pnl_usd),
  };
}
