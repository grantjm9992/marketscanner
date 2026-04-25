import type { Market } from '../domain/market.js';
import type { Order } from '../domain/order.js';
import type { Portfolio } from '../domain/portfolio.js';
import type { Clock } from '../engine/clock.js';
import type { Logger } from '../logging/logger.js';

export interface StrategyContext {
  readonly market: Market;
  readonly portfolio: Portfolio;
  readonly openOrders: readonly Order[];
  readonly clock: Clock;
  readonly logger: Logger;
}
