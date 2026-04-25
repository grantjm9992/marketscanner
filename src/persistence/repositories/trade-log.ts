import type { Db } from '../db.js';
import type { Order, Fill, OrderRequest, OrderId } from '../../domain/order.js';

export type TradeLogMode = 'live' | 'paper' | 'backtest';
export type TradeLogEvent = 'ORDER_PLACED' | 'FILL' | 'CANCEL' | 'REJECT';

export interface TradeLogRow {
  readonly id: number;
  readonly timestamp: string;
  readonly mode: TradeLogMode;
  readonly eventType: TradeLogEvent;
  readonly orderId: string | null;
  readonly marketId: string;
  readonly tokenId: string | null;
  readonly side: string | null;
  readonly orderType: string | null;
  readonly size: number | null;
  readonly price: number | null;
  readonly feeUsd: number | null;
  readonly payloadJson: string;
}

export class TradeLogRepository {
  private readonly insertStmt;

  constructor(
    private readonly db: Db,
    private readonly mode: TradeLogMode,
  ) {
    this.insertStmt = db.prepare(`
      INSERT INTO trade_log (
        timestamp, mode, event_type, order_id, market_id, token_id,
        side, order_type, size, price, fee_usd, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  recordOrderPlaced(req: OrderRequest, id: OrderId, at: Date): void {
    this.insertStmt.run(
      at.toISOString(),
      this.mode,
      'ORDER_PLACED',
      id,
      req.marketId,
      req.tokenId,
      req.side,
      req.type,
      req.size,
      req.limitPrice ?? null,
      null,
      JSON.stringify({ ...req, id }),
    );
  }

  recordFill(fill: Fill): void {
    this.insertStmt.run(
      fill.timestamp.toISOString(),
      this.mode,
      'FILL',
      fill.orderId,
      fill.marketId,
      fill.tokenId,
      fill.side,
      null,
      fill.size,
      fill.price,
      fill.feeUsd,
      JSON.stringify(fill),
    );
  }

  recordCancel(order: Order, at: Date): void {
    this.insertStmt.run(
      at.toISOString(),
      this.mode,
      'CANCEL',
      order.id,
      order.marketId,
      order.tokenId,
      order.side,
      order.type,
      order.size,
      order.limitPrice ?? null,
      null,
      JSON.stringify(order),
    );
  }

  recordReject(req: OrderRequest, reason: string, at: Date): void {
    this.insertStmt.run(
      at.toISOString(),
      this.mode,
      'REJECT',
      null,
      req.marketId,
      req.tokenId,
      req.side,
      req.type,
      req.size,
      req.limitPrice ?? null,
      null,
      JSON.stringify({ ...req, reason }),
    );
  }

  recentForMarket(marketId: string, limit = 100): readonly TradeLogRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM trade_log WHERE market_id = ? ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(marketId, limit) as Array<{
      id: number;
      timestamp: string;
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
      payload_json: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
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
      payloadJson: r.payload_json,
    }));
  }
}
