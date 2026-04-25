import type { OrderBook } from '../domain/market.js';
import type { Fill } from '../domain/order.js';
import type { WalletTrade } from '../marketdata/wallet-trade-feed.js';
import type { Signal } from './signal.js';
import type { StrategyContext } from './context.js';

export interface Strategy {
  readonly name: string;
  onBookUpdate(book: OrderBook, ctx: StrategyContext): readonly Signal[];
  onFill(fill: Fill, ctx: StrategyContext): void;
  onStart(ctx: StrategyContext): Promise<void>;
  onStop(ctx: StrategyContext): Promise<void>;
  /**
   * Optional hook for strategies driven by wallet activity (e.g.
   * SmartMoneyFollower). Engine only calls this if the strategy
   * defines it AND a wallet feed is configured. Returns signals to be
   * dispatched the same way as those from onBookUpdate.
   */
  onWalletTrade?(trade: WalletTrade, ctx: StrategyContext): readonly Signal[];
}
