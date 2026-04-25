import { price, size } from '../../domain/money.js';
import { bestAsk, bestBid } from '../../domain/market.js';
import type { OrderBook } from '../../domain/market.js';
import type { Fill, OrderRequest } from '../../domain/order.js';
import type { WalletTrade } from '../../marketdata/wallet-trade-feed.js';
import type { Signal } from '../signal.js';
import type { Strategy } from '../strategy.js';
import type { StrategyContext } from '../context.js';

export type ExecutionMode =
  /** MARKET order. Fills now, eats slippage to chase the signal. */
  | 'taker_market'
  /** LIMIT at the current touch (best ask for BUY, best bid for SELL). */
  | 'taker_limit_at_touch';

export interface SmartMoneyFollowerParams {
  /**
   * Notional USD per copy trade. Independent of how big the source
   * trade was — we cap our exposure regardless.
   */
  readonly copyNotionalUsd: number;
  /**
   * Source trades smaller than this are ignored — too noisy to copy.
   */
  readonly minSourceNotionalUsd: number;
  /**
   * Don't act on a wallet trade older than this. The whole point is
   * speed; an aged signal is no signal.
   */
  readonly maxAgeMs: number;
  /**
   * If the current book has drifted more than this in cents from the
   * source trade's price, skip the copy — the move already happened.
   */
  readonly maxPriceDriftCents: number;
  readonly executionMode: ExecutionMode;
  /**
   * Per-wallet cooldown: don't copy the same wallet's trades on the
   * same market more than once within this window.
   */
  readonly perMarketCooldownMs: number;
}

export const DEFAULT_SMART_MONEY_PARAMS: SmartMoneyFollowerParams = {
  copyNotionalUsd: 10,
  minSourceNotionalUsd: 200,
  maxAgeMs: 30_000,
  maxPriceDriftCents: 0.03,
  executionMode: 'taker_limit_at_touch',
  perMarketCooldownMs: 5 * 60_000,
};

/**
 * Reacts to trades from a curated watchlist of wallets. Buffers each
 * incoming trade, then on the next book update for the same market
 * checks freshness, price drift, and cooldown gates before emitting a
 * same-side signal.
 *
 * Critical caveats:
 *
 *   - The wallet selection is the entire edge. Track realized PnL on
 *     closed positions only; rank-based picks (the rn1 trap) lose money.
 *
 *   - This is "conviction stacking", not latency arbitrage. By the time
 *     the Data API surfaces a trade you're 5-30s behind. Don't assume
 *     you're getting the same fill price the smart wallet got.
 *
 *   - PnL of this strategy must be tracked separately from any maker
 *     strategy (e.g. WSMM). They have opposite risk profiles.
 */
export class SmartMoneyFollower implements Strategy {
  readonly name = 'smart-money-follower';

  /** Trades waiting for the next book update on their market. */
  private readonly pending = new Map<string, WalletTrade[]>(); // marketId -> queue
  /** Per-(wallet × market) timestamp of last copy, for cooldown. */
  private readonly lastCopyAt = new Map<string, number>();
  private nextClientId = 1;

  constructor(private readonly params: SmartMoneyFollowerParams = DEFAULT_SMART_MONEY_PARAMS) {}

  async onStart(_ctx: StrategyContext): Promise<void> {
    /* nothing to do */
  }

  async onStop(_ctx: StrategyContext): Promise<void> {
    /* nothing to do */
  }

  onWalletTrade(trade: WalletTrade, ctx: StrategyContext): readonly Signal[] {
    // Source-size gate: small wallet trades are noise.
    const notional = (trade.size as number) * (trade.price as number);
    if (notional < this.params.minSourceNotionalUsd) {
      ctx.logger.debug({ trade, notional }, 'smart-money-follower: source trade too small');
      return [];
    }

    // Buffer for the next book update on this market.
    const queue = this.pending.get(trade.marketId) ?? [];
    queue.push(trade);
    this.pending.set(trade.marketId, queue);
    return [];
  }

  onBookUpdate(book: OrderBook, ctx: StrategyContext): readonly Signal[] {
    const queue = this.pending.get(book.marketId);
    if (!queue || queue.length === 0) return [];
    this.pending.set(book.marketId, []);

    const out: Signal[] = [];
    const now = ctx.clock.now();

    for (const trade of queue) {
      const ageMs = now.getTime() - trade.timestamp.getTime();
      if (ageMs > this.params.maxAgeMs) {
        ctx.logger.debug({ trade, ageMs }, 'smart-money-follower: stale signal');
        continue;
      }

      const cooldownKey = `${trade.walletAddress}|${trade.marketId}`;
      const lastAt = this.lastCopyAt.get(cooldownKey);
      if (lastAt !== undefined && now.getTime() - lastAt < this.params.perMarketCooldownMs) {
        continue;
      }

      // Look up touch on the right side of the book.
      const touch = trade.side === 'BUY' ? bestAsk(book) : bestBid(book);
      if (touch === null) continue;

      // Drift gate: don't chase a price that already moved.
      const drift = Math.abs((touch.price as number) - (trade.price as number));
      if (drift > this.params.maxPriceDriftCents) {
        ctx.logger.debug(
          { trade, touchPrice: touch.price, drift },
          'smart-money-follower: drift exceeded',
        );
        continue;
      }

      const req = this.buildRequest(trade, book, touch.price as number);
      if (!req) continue;
      out.push({ kind: 'PLACE_ORDER', request: req });
      this.lastCopyAt.set(cooldownKey, now.getTime());
    }
    return out;
  }

  onFill(_fill: Fill, _ctx: StrategyContext): void {
    /* PnL tracked at the venue + risk manager; nothing strategy-side. */
  }

  // --- helpers ---

  private buildRequest(
    trade: WalletTrade,
    book: OrderBook,
    touchPrice: number,
  ): OrderRequest | null {
    const ourSize = this.params.copyNotionalUsd / Math.max(touchPrice, 1e-6);
    if (ourSize <= 0) return null;

    const cid = `smf-${this.nextClientId++}`;
    if (this.params.executionMode === 'taker_market') {
      return {
        marketId: book.marketId,
        tokenId: trade.tokenId,
        side: trade.side,
        type: 'MARKET',
        size: size(ourSize),
        clientOrderId: cid,
      };
    }
    // taker_limit_at_touch
    return {
      marketId: book.marketId,
      tokenId: trade.tokenId,
      side: trade.side,
      type: 'LIMIT',
      size: size(ourSize),
      limitPrice: price(touchPrice),
      clientOrderId: cid,
    };
  }
}
