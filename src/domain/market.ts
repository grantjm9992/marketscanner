import { price } from './money.js';
import type { Price, Size } from './money.js';

export interface Outcome {
  readonly tokenId: string;
  readonly label: string;
}

export interface MarketRewards {
  /** Total $/day across all reward streams on this market. */
  readonly dailyRateUsd: number;
  /** Max distance from mid (price units) that still qualifies for rewards. */
  readonly maxSpread: Price;
  /** Minimum quote size (shares) to qualify. */
  readonly minSize: Size;
}

export interface Market {
  readonly conditionId: string;
  readonly question: string;
  readonly outcomes: readonly Outcome[];
  readonly tickSize: Price;
  readonly minOrderSize: Size;
  readonly endDate: Date;
  readonly category: string;
  /** Populated when discovery surfaces rewards info; undefined otherwise. */
  readonly rewards?: MarketRewards;
}

export interface PriceLevel {
  readonly price: Price;
  readonly size: Size;
}

export interface OrderBook {
  readonly marketId: string;
  readonly tokenId: string;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  readonly timestamp: Date;
}

export function bestBid(book: OrderBook): PriceLevel | null {
  return book.bids[0] ?? null;
}

export function bestAsk(book: OrderBook): PriceLevel | null {
  return book.asks[0] ?? null;
}

export function midPrice(book: OrderBook): Price | null {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  if (bid === null || ask === null) return null;
  return price((bid.price + ask.price) / 2);
}

export function spread(book: OrderBook): Price | null {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  if (bid === null || ask === null) return null;
  const s = ask.price - bid.price;
  if (s < 0) return null;
  return price(s);
}
