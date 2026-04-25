import type { PgPool } from '../db.js';
import type { Order, Fill, OrderRequest, OrderId } from '../../../domain/order.js';
import type {
  TradeLogStore,
  TradeLogMode,
  TradeLogEvent,
  TradeLogRow,
} from '../../repositories/types.js';

export class PgTradeLogStore implements TradeLogStore {
  constructor(
    private readonly pool: PgPool,
    private readonly mode: TradeLogMode,
  ) {}

  async recordOrderPlaced(req: OrderRequest, id: OrderId, at: Date): Promise<void> {
    await this.insert(at, 'ORDER_PLACED', id, req.marketId, req.tokenId, req.side, req.type,
      req.size, req.limitPrice ?? null, null, JSON.stringify({ ...req, id }));
  }

  async recordFill(fill: Fill): Promise<void> {
    await this.insert(fill.timestamp, 'FILL', fill.orderId, fill.marketId, fill.tokenId,
      fill.side, null, fill.size, fill.price, fill.feeUsd, JSON.stringify(fill));
  }

  async recordCancel(order: Order, at: Date): Promise<void> {
    await this.insert(at, 'CANCEL', order.id, order.marketId, order.tokenId, order.side,
      order.type, order.size, order.limitPrice ?? null, null, JSON.stringify(order));
  }

  async recordReject(req: OrderRequest, reason: string, at: Date): Promise<void> {
    await this.insert(at, 'REJECT', null, req.marketId, req.tokenId, req.side, req.type,
      req.size, req.limitPrice ?? null, null, JSON.stringify({ ...req, reason }));
  }

  async recentForMarket(marketId: string, limit = 100): Promise<readonly TradeLogRow[]> {
    const { rows } = await this.pool.query<{
      id: number;
      timestamp: Date;
      mode: TradeLogMode;
      event_type: TradeLogEvent;
      order_id: string | null;
      market_id: string;
      token_id: string | null;
      side: string | null;
      order_type: string | null;
      size: number | null;
      price: number | null;
      fee_usd: number | null;
      payload_json: unknown;
    }>(
      `SELECT * FROM trade_log WHERE market_id = $1 ORDER BY timestamp DESC LIMIT $2`,
      [marketId, limit],
    );

    return rows.map((r) => ({
      id: Number(r.id),
      timestamp: r.timestamp.toISOString(),
      mode: r.mode,
      eventType: r.event_type,
      orderId: r.order_id,
      marketId: r.market_id,
      tokenId: r.token_id,
      side: r.side,
      orderType: r.order_type,
      size: r.size,
      price: r.price,
      feeUsd: r.fee_usd,
      payloadJson: typeof r.payload_json === 'string' ? r.payload_json : JSON.stringify(r.payload_json),
    }));
  }

  private async insert(
    timestamp: Date,
    eventType: TradeLogEvent,
    orderId: string | null,
    marketId: string,
    tokenId: string | null,
    side: string | null,
    orderType: string | null,
    size: number | null,
    price: number | null,
    feeUsd: number | null,
    payloadJson: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO trade_log (
        timestamp, mode, event_type, order_id, market_id, token_id,
        side, order_type, size, price, fee_usd, payload_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [
        timestamp.toISOString(),
        this.mode,
        eventType,
        orderId,
        marketId,
        tokenId,
        side,
        orderType,
        size,
        price,
        feeUsd,
        payloadJson,
      ],
    );
  }
}
