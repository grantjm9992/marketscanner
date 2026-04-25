import { price, size } from '../../domain/money.js';
import { bestAsk, bestBid, spread } from '../../domain/market.js';
import type { OrderBook } from '../../domain/market.js';
import type { Fill, Order, OrderRequest } from '../../domain/order.js';
import type { Signal } from '../signal.js';
import type { Strategy } from '../strategy.js';
import type { StrategyContext } from '../context.js';

export interface RewardedMarketMakerParams {
  /** Used as quote size when the market doesn't expose rewardsMinSize. */
  readonly fallbackQuoteSize: number;
  /**
   * How many cents inside `rewardsMaxSpread` to quote (safety margin —
   * stay clear of the boundary so a tick of price noise doesn't kick
   * us out of the rewards band).
   */
  readonly rewardsSafetyMarginCents: number;
  readonly maxHoldMinutes: number;
  readonly cancelMoveCents: number;
  readonly minQuoteLifetimeMs: number;
  readonly spreadHysteresis: number;
  readonly minTimeToEndMs: number;
}

export const DEFAULT_REWARDED_PARAMS: RewardedMarketMakerParams = {
  fallbackQuoteSize: 20,
  rewardsSafetyMarginCents: 0.005, // 0.5¢ inside the rewards band
  maxHoldMinutes: 30,
  cancelMoveCents: 0.05,
  minQuoteLifetimeMs: 5_000,
  spreadHysteresis: 0.005,
  minTimeToEndMs: 24 * 60 * 60 * 1000,
};

interface QuoteState {
  readonly midAtPlacement: number;
  readonly placedAt: Date;
  readonly clientOrderId: string;
}

/**
 * Market maker tuned to qualify for Polymarket's CLOB rewards program.
 *
 * Unlike WSMM (which sits one tick inside the touch and waits to earn
 * the spread), this strategy quotes near-mid — specifically within
 * `market.rewards.maxSpread` of mid — to qualify for the rewards
 * subsidy. Posts both sides, sized at >= `market.rewards.minSize`.
 *
 * Edge model:
 *   - Rewards $/day × your share of qualifying volume
 *   - Minus adverse-selection cost (which is higher than WSMM since
 *     we're near-mid, but the rewards subsidy is meant to offset it)
 *
 * Skips any market without rewards info. Use with discovery's
 * `requireRewards: true` filter.
 */
export class RewardedMarketMaker implements Strategy {
  readonly name = 'rewarded-market-maker';
  private readonly quotesByClientId = new Map<string, QuoteState>();
  private nextClientId = 1;

  constructor(private readonly params: RewardedMarketMakerParams = DEFAULT_REWARDED_PARAMS) {}

  async onStart(_ctx: StrategyContext): Promise<void> {
    /* nothing */
  }

  async onStop(_ctx: StrategyContext): Promise<void> {
    /* nothing */
  }

  onBookUpdate(book: OrderBook, ctx: StrategyContext): readonly Signal[] {
    const signals: Signal[] = [];
    if (book.marketId !== ctx.market.conditionId) return signals;

    const rewards = ctx.market.rewards;
    if (!rewards) {
      // No rewards data → strategy is a no-op on this market.
      signals.push(...this.cancelAllForMarket(ctx, book.marketId, ctx.clock.now()));
      return signals;
    }

    const now = ctx.clock.now();

    // Hard time guard.
    const timeToEnd = ctx.market.endDate.getTime() - now.getTime();
    if (timeToEnd <= this.params.minTimeToEndMs) {
      signals.push(...this.cancelAllForMarket(ctx, book.marketId, now));
      return signals;
    }

    const bid = bestBid(book);
    const ask = bestAsk(book);
    const sp = spread(book);
    if (bid === null || ask === null || sp === null) {
      signals.push(...this.cancelAllForMarket(ctx, book.marketId, now));
      return signals;
    }

    const tick = ctx.market.tickSize as number;
    const mid = ((bid.price as number) + (ask.price as number)) / 2;

    // Stay this far inside the rewards band on each side (so noise
    // doesn't push us out).
    const margin = this.params.rewardsSafetyMarginCents;
    const effectiveBand = Math.max(0, (rewards.maxSpread as number) - margin);

    // Target both sides: as close to touch as we can without leaving
    // the rewards band, but never inside the existing book (would
    // self-cross or cross the touch).
    const desiredBuyRaw = Math.max((bid.price as number) + tick, mid - effectiveBand);
    const desiredSellRaw = Math.min((ask.price as number) - tick, mid + effectiveBand);

    // Round to tick.
    const desiredBuy = roundToTick(desiredBuyRaw, tick);
    const desiredSell = roundToTick(desiredSellRaw, tick);

    // If after clamping the two sides cross, the spread is too narrow
    // to support both quotes — skip both. (Could quote one side only
    // in a future version.)
    if (desiredBuy >= desiredSell) {
      signals.push(...this.cancelAllForMarket(ctx, book.marketId, now));
      return signals;
    }

    // Quote size = max(rewards.minSize, fallback). Larger sizes help
    // qualify for rewards but consume more cash + inventory.
    const quoteSize = Math.max(this.params.fallbackQuoteSize, rewards.minSize as number);

    // Drift cancels (respect lifetime guard).
    for (const order of ctx.openOrders) {
      if (order.marketId !== book.marketId) continue;
      const q = this.quotesByClientId.get(order.clientOrderId);
      if (!q) continue;
      if (this.tooYoungToCancel(q, now)) continue;
      const drift = Math.abs(mid - q.midAtPlacement);
      if (drift >= this.params.cancelMoveCents) {
        signals.push({ kind: 'CANCEL_ORDER', orderId: order.id });
        this.quotesByClientId.delete(order.clientOrderId);
      }
    }

    const haveBuy = ctx.openOrders.some(
      (o) => o.marketId === book.marketId && o.side === 'BUY' && this.isOurOrder(o),
    );
    const haveSell = ctx.openOrders.some(
      (o) => o.marketId === book.marketId && o.side === 'SELL' && this.isOurOrder(o),
    );

    if (!haveBuy && this.canAffordBuy(ctx, desiredBuy, quoteSize)) {
      const cid = this.newClientId('B');
      this.quotesByClientId.set(cid, {
        midAtPlacement: mid,
        placedAt: now,
        clientOrderId: cid,
      });
      signals.push({
        kind: 'PLACE_ORDER',
        request: this.makeRequest(book, 'BUY', desiredBuy, quoteSize, cid),
      });
    }

    if (!haveSell && this.canSellSize(ctx, ctx.market.conditionId, book.tokenId, quoteSize)) {
      const cid = this.newClientId('S');
      this.quotesByClientId.set(cid, {
        midAtPlacement: mid,
        placedAt: now,
        clientOrderId: cid,
      });
      signals.push({
        kind: 'PLACE_ORDER',
        request: this.makeRequest(book, 'SELL', desiredSell, quoteSize, cid),
      });
    }

    return signals;
  }

  onFill(_fill: Fill, _ctx: StrategyContext): void {
    /* stateless on fills; venue + risk track P&L */
  }

  // --- helpers ---

  private cancelAllForMarket(
    ctx: StrategyContext,
    marketId: string,
    now: Date,
  ): readonly Signal[] {
    const out: Signal[] = [];
    for (const order of ctx.openOrders) {
      if (order.marketId !== marketId) continue;
      const q = this.quotesByClientId.get(order.clientOrderId);
      if (!q) continue;
      if (this.tooYoungToCancel(q, now)) continue;
      out.push({ kind: 'CANCEL_ORDER', orderId: order.id });
      this.quotesByClientId.delete(order.clientOrderId);
    }
    return out;
  }

  private isOurOrder(o: Order): boolean {
    return this.quotesByClientId.has(o.clientOrderId);
  }

  private tooYoungToCancel(q: QuoteState, now: Date): boolean {
    return now.getTime() - q.placedAt.getTime() < this.params.minQuoteLifetimeMs;
  }

  private canAffordBuy(ctx: StrategyContext, atPrice: number, qty: number): boolean {
    return (ctx.portfolio.cashUsd as number) >= atPrice * qty;
  }

  private canSellSize(
    ctx: StrategyContext,
    marketId: string,
    tokenId: string,
    qty: number,
  ): boolean {
    const pos = ctx.portfolio.positions.find(
      (p) => p.marketId === marketId && p.tokenId === tokenId,
    );
    return (pos?.size ?? 0) >= qty;
  }

  private newClientId(prefix: string): string {
    return `rmm-${prefix}-${this.nextClientId++}`;
  }

  private makeRequest(
    book: OrderBook,
    side: 'BUY' | 'SELL',
    p: number,
    sz: number,
    clientId: string,
  ): OrderRequest {
    return {
      marketId: book.marketId,
      tokenId: book.tokenId,
      side,
      type: 'LIMIT',
      size: size(sz),
      limitPrice: price(p),
      clientOrderId: clientId,
    };
  }
}

function roundToTick(v: number, tick: number): number {
  return Math.round(v / tick) * tick;
}
