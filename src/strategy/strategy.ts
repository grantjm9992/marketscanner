import type { OrderBook } from '../domain/market.js';
import type { Fill } from '../domain/order.js';
import type { Signal } from './signal.js';
import type { StrategyContext } from './context.js';

export interface Strategy {
  readonly name: string;
  onBookUpdate(book: OrderBook, ctx: StrategyContext): readonly Signal[];
  onFill(fill: Fill, ctx: StrategyContext): void;
  onStart(ctx: StrategyContext): Promise<void>;
  onStop(ctx: StrategyContext): Promise<void>;
}
