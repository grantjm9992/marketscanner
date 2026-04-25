import type { PgPool } from '../db.js';
import { price, size } from '../../../domain/money.js';
import type { OrderBook, PriceLevel } from '../../../domain/market.js';
import type { MarketSnapshotStore } from '../../repositories/types.js';

export class PgMarketSnapshotStore implements MarketSnapshotStore {
  constructor(private readonly pool: PgPool) {}

  async record(book: OrderBook): Promise<void> {
    await this.pool.query(
      `INSERT INTO market_snapshot (timestamp, market_id, token_id, bids_json, asks_json)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [
        book.timestamp.toISOString(),
        book.marketId,
        book.tokenId,
        JSON.stringify(book.bids),
        JSON.stringify(book.asks),
      ],
    );
  }

  async range(from: Date, to: Date): Promise<readonly OrderBook[]> {
    const { rows } = await this.pool.query<{
      timestamp: Date;
      market_id: string;
      token_id: string;
      bids_json: unknown;
      asks_json: unknown;
    }>(
      `SELECT timestamp, market_id, token_id, bids_json, asks_json
       FROM market_snapshot
       WHERE timestamp >= $1 AND timestamp < $2
       ORDER BY timestamp ASC`,
      [from.toISOString(), to.toISOString()],
    );

    return rows.map((r) => ({
      marketId: r.market_id,
      tokenId: r.token_id,
      timestamp: r.timestamp,
      bids: parseLevels(r.bids_json),
      asks: parseLevels(r.asks_json),
    }));
  }
}

function parseLevels(json: unknown): readonly PriceLevel[] {
  // pg returns jsonb as a parsed JS value already, but accept string too
  // for resilience.
  const arr =
    typeof json === 'string'
      ? (JSON.parse(json) as Array<{ price: number; size: number }>)
      : (json as Array<{ price: number; size: number }>);
  return arr.map((l) => ({ price: price(l.price), size: size(l.size) }));
}
