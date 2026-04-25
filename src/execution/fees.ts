import { usd } from '../domain/money.js';
import type { Price, Size, Usd } from '../domain/money.js';
import type { Side } from '../domain/order.js';

/**
 * Single source of truth for fees. Even when Polymarket charges 0%, route
 * fee math through here so the day fees change is a one-line edit.
 */
export interface FeeSchedule {
  /** Returns the fee in USD for a notional fill of `size` at `price`. */
  feeFor(opts: { side: Side; price: Price; size: Size }): Usd;
}

/**
 * Polymarket as of 2026-01: maker = taker = 0%. We still emit Usd values
 * through the abstraction so callers stay correct.
 */
export class PolymarketFeeSchedule implements FeeSchedule {
  feeFor(_opts: { side: Side; price: Price; size: Size }): Usd {
    return usd(0);
  }
}

/**
 * Flat-rate schedule for what-if simulations.
 * `rate` is a fraction of notional (price * size). 0.001 = 10 bps.
 */
export class FlatFeeSchedule implements FeeSchedule {
  constructor(private readonly rate: number) {
    if (!Number.isFinite(rate) || rate < 0) {
      throw new Error(`Invalid fee rate: ${rate}`);
    }
  }

  feeFor(opts: { side: Side; price: Price; size: Size }): Usd {
    return usd(opts.price * opts.size * this.rate);
  }
}
