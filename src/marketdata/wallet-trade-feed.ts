import type { Price, Size } from '../domain/money.js';

export interface WalletTrade {
  /** Lowercased Polygon address of the trader. */
  readonly walletAddress: string;
  /** Polymarket conditionId. */
  readonly marketId: string;
  /** ERC-1155 tokenId of the outcome being traded. */
  readonly tokenId: string;
  readonly side: 'BUY' | 'SELL';
  readonly price: Price;
  readonly size: Size;
  readonly timestamp: Date;
  /**
   * Stable per-trade identifier (ideally the on-chain tx hash). Used for
   * dedup across overlapping polls.
   */
  readonly tradeId: string;
}

/**
 * Source of trades for a configured set of wallet addresses. Strategies
 * subscribe via `onTrade` and react to each new event.
 */
export interface WalletTradeFeed {
  /** Add wallet addresses to the watchlist. Idempotent. */
  watch(addresses: readonly string[]): Promise<void>;
  /** Remove wallets from the watchlist. */
  unwatch(addresses: readonly string[]): Promise<void>;
  onTrade(handler: (trade: WalletTrade) => void): void;
  onError(handler: (err: Error) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
