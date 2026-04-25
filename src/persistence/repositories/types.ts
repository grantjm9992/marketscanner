import type { OrderBook } from '../../domain/market.js';
import type { Fill, Order, OrderId, OrderRequest } from '../../domain/order.js';
import type { Position } from '../../domain/portfolio.js';
import type { Usd } from '../../domain/money.js';

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

/**
 * Audit log of every place / fill / cancel / reject. Hot-path writes are
 * fire-and-forget (callers don't await).
 */
export interface TradeLogStore {
  recordOrderPlaced(req: OrderRequest, id: OrderId, at: Date): Promise<void>;
  recordFill(fill: Fill): Promise<void>;
  recordCancel(order: Order, at: Date): Promise<void>;
  recordReject(req: OrderRequest, reason: string, at: Date): Promise<void>;
  recentForMarket(marketId: string, limit?: number): Promise<readonly TradeLogRow[]>;
}

/**
 * Append-only book snapshots for backtest replay.
 */
export interface MarketSnapshotStore {
  record(book: OrderBook): Promise<void>;
  range(from: Date, to: Date): Promise<readonly OrderBook[]>;
}

export interface PositionStore {
  upsert(p: Position, at: Date): Promise<void>;
  get(marketId: string, tokenId: string): Promise<Position | null>;
  all(): Promise<readonly Position[]>;
  remove(marketId: string, tokenId: string): Promise<void>;
}

export interface DailyPnlSummary {
  readonly realizedPnlUsd: Usd;
  readonly feesPaidUsd: Usd;
  readonly tradeCount: number;
}

export interface DailyPnlStore {
  recordTrade(date: Date, realizedPnl: Usd, fees: Usd): Promise<void>;
  get(date: Date): Promise<DailyPnlSummary | null>;
}

/**
 * Bundle of all stores. The factory in `stores.ts` returns one of these
 * configured for either SQLite or Postgres.
 */
export interface Stores {
  readonly tradeLog: TradeLogStore;
  readonly marketSnapshot: MarketSnapshotStore;
  readonly position: PositionStore;
  readonly dailyPnl: DailyPnlStore;
  close(): Promise<void>;
}
