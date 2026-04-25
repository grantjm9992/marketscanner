import type { OrderBook } from '../domain/market.js';

export interface MarketDataFeed {
  subscribe(marketIds: readonly string[]): Promise<void>;
  unsubscribe(marketIds: readonly string[]): Promise<void>;
  onBookUpdate(handler: (book: OrderBook) => void): void;
  onError(handler: (err: Error) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
