import type { Db } from '../db.js';
import { price, size } from '../../domain/money.js';
import type { OrderBook, PriceLevel } from '../../domain/market.js';

export class MarketSnapshotRepository {
  private readonly insertStmt;
  private readonly rangeStmt;

  constructor(private readonly db: Db) {
    this.insertStmt = db.prepare(`
      INSERT INTO market_snapshot (timestamp, market_id, token_id, bids_json, asks_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.rangeStmt = db.prepare(`
      SELECT timestamp, market_id, token_id, bids_json, asks_json
      FROM market_snapshot
      WHERE timestamp >= ? AND timestamp < ?
      ORDER BY timestamp ASC
    `);
  }

  record(book: OrderBook): void {
    this.insertStmt.run(
      book.timestamp.toISOString(),
      book.marketId,
      book.tokenId,
      JSON.stringify(book.bids),
      JSON.stringify(book.asks),
    );
  }

  /**
   * Replay snapshots in chronological order over `[from, to)`.
   * Used by HistoricalFeed.
   */
  range(from: Date, to: Date): readonly OrderBook[] {
    const rows = this.rangeStmt.all(from.toISOString(), to.toISOString()) as Array<{
      timestamp: string;
      market_id: string;
      token_id: string;
      bids_json: string;
      asks_json: string;
    }>;

    return rows.map((r) => ({
      marketId: r.market_id,
      tokenId: r.token_id,
      timestamp: new Date(r.timestamp),
      bids: parseLevels(r.bids_json),
      asks: parseLevels(r.asks_json),
    }));
  }
}

function parseLevels(json: string): readonly PriceLevel[] {
  const arr = JSON.parse(json) as Array<{ price: number; size: number }>;
  return arr.map((l) => ({ price: price(l.price), size: size(l.size) }));
}
