import { price, size } from '../../domain/money.js';
import { bestAsk, bestBid, spread } from '../../domain/market.js';
import type { OrderBook } from '../../domain/market.js';
import type { Fill, Order, OrderRequest } from '../../domain/order.js';
import type { Signal } from '../signal.js';
import type { Strategy } from '../strategy.js';
import type { StrategyContext } from '../context.js';

export interface WideSpreadParams {
  readonly minSpread: number; // e.g. 0.03 = 3 cents
  readonly quoteSize: number; // shares per quote
  readonly maxHoldMinutes: number;
  readonly cancelMoveCents: number; // cancel if mid moves >= N cents from quote
  readonly minDailyVolumeUsd: number; // strategy currently doesn't fetch volume
  readonly minTimeToEndMs: number; // skip if market closes too soon
}

export const DEFAULT_PARAMS: WideSpreadParams = {
  minSpread: 0.03,
  quoteSize: 10,
  maxHoldMinutes: 30,
  cancelMoveCents: 0.05,
  minDailyVolumeUsd: 10_000,
  minTimeToEndMs: 24 * 60 * 60 * 1000,
};

interface QuoteState {
  // Mid price at the time the quote was placed; used to detect drift.
  readonly midAtPlacement: number;
  // Wall-clock placement time, for the maxHoldMinutes guard.
  readonly placedAt: Date;
  // Side & client id so we can correlate to open orders.
  readonly clientOrderId: string;
}

/**
 * The simplest possible market maker. Validates the pipeline end-to-end
 * rather than chasing alpha:
 *
 *   - Quote BUY at bestBid + tick and SELL at bestAsk - tick (improving
 *     each side by one tick).
 *   - Skip markets with spread below `minSpread`.
 *   - Cancel and requote if mid moves more than `cancelMoveCents`.
 *   - Flatten any open position older than `maxHoldMinutes` at market.
 *
 * This strategy is NOT expected to be profitable. If it is, default
 * assumption is a bug in the simulator.
 */
export class WideSpreadMarketMaker implements Strategy {
  readonly name = 'wide-spread-market-maker';
  private readonly quotesByClientId = new Map<string, QuoteState>();
  private nextClientId = 1;

  constructor(private readonly params: WideSpreadParams = DEFAULT_PARAMS) {}

  async onStart(_ctx: StrategyContext): Promise<void> {
    /* nothing to do */
  }

  async onStop(_ctx: StrategyContext): Promise<void> {
    /* nothing to do */
  }

  onBookUpdate(book: OrderBook, ctx: StrategyContext): readonly Signal[] {
    const signals: Signal[] = [];

    if (book.marketId !== ctx.market.conditionId) return signals;

    const now = ctx.clock.now();

    // Hard time guard: market closing too soon → exit any position and
    // don't place new quotes.
    const timeToEnd = ctx.market.endDate.getTime() - now.getTime();
    if (timeToEnd <= this.params.minTimeToEndMs) {
      signals.push(...this.cancelAllQuotesForMarket(ctx, book.marketId));
      signals.push(...this.flattenIfHeld(book, ctx));
      return signals;
    }

    // Position-age guard.
    signals.push(...this.flattenStalePositions(book, ctx, now));

    const bid = bestBid(book);
    const ask = bestAsk(book);
    const sp = spread(book);
    if (bid === null || ask === null || sp === null) {
      // Empty side — pull any quotes in this market.
      signals.push(...this.cancelAllQuotesForMarket(ctx, book.marketId));
      return signals;
    }

    if ((sp as number) < this.params.minSpread) {
      // Spread too tight — pull and wait.
      signals.push(...this.cancelAllQuotesForMarket(ctx, book.marketId));
      return signals;
    }

    const tick = ctx.market.tickSize as number;
    const desiredBuy = round((bid.price as number) + tick, tick);
    const desiredSell = round((ask.price as number) - tick, tick);
    const mid = ((bid.price as number) + (ask.price as number)) / 2;

    // Cancel quotes that have drifted too far from mid.
    for (const order of ctx.openOrders) {
      if (order.marketId !== book.marketId) continue;
      const q = this.quotesByClientId.get(order.clientOrderId);
      if (!q) continue;
      const drift = Math.abs(mid - q.midAtPlacement);
      if (drift >= this.params.cancelMoveCents) {
        signals.push({ kind: 'CANCEL_ORDER', orderId: order.id });
        this.quotesByClientId.delete(order.clientOrderId);
      }
    }

    // Place fresh quotes if we don't already have one on each side.
    const haveBuy = ctx.openOrders.some(
      (o) => o.marketId === book.marketId && o.side === 'BUY' && this.isOurOrder(o),
    );
    const haveSell = ctx.openOrders.some(
      (o) => o.marketId === book.marketId && o.side === 'SELL' && this.isOurOrder(o),
    );

    if (!haveBuy && this.canAffordBuy(ctx, desiredBuy)) {
      const cid = this.newClientId('B');
      this.quotesByClientId.set(cid, { midAtPlacement: mid, placedAt: now, clientOrderId: cid });
      signals.push({
        kind: 'PLACE_ORDER',
        request: this.makeRequest(book, ctx, 'BUY', desiredBuy, cid),
      });
    }

    if (!haveSell && this.canSellSize(ctx, ctx.market.conditionId, book.tokenId)) {
      const cid = this.newClientId('S');
      this.quotesByClientId.set(cid, { midAtPlacement: mid, placedAt: now, clientOrderId: cid });
      signals.push({
        kind: 'PLACE_ORDER',
        request: this.makeRequest(book, ctx, 'SELL', desiredSell, cid),
      });
    }

    return signals;
  }

  onFill(_fill: Fill, _ctx: StrategyContext): void {
    // Stateless on fills — quote state is keyed by client id, and a filled
    // order disappears from openOrders, which removes its slot for next
    // requote on the next book update.
  }

  // --- helpers ---

  private flattenStalePositions(
    book: OrderBook,
    ctx: StrategyContext,
    now: Date,
  ): readonly Signal[] {
    const out: Signal[] = [];
    for (const pos of ctx.portfolio.positions) {
      if (pos.marketId !== book.marketId || pos.tokenId !== book.tokenId) continue;
      if ((pos.size as number) <= 0) continue;
      const ageMs = now.getTime() - this.oldestRelevantTime(ctx).getTime();
      if (ageMs / 60_000 < this.params.maxHoldMinutes) continue;
      // Flatten at market.
      out.push({
        kind: 'PLACE_ORDER',
        request: {
          marketId: book.marketId,
          tokenId: book.tokenId,
          side: 'SELL',
          type: 'MARKET',
          size: pos.size,
          clientOrderId: this.newClientId('FLAT'),
        },
      });
    }
    return out;
  }

  private flattenIfHeld(book: OrderBook, ctx: StrategyContext): readonly Signal[] {
    const out: Signal[] = [];
    for (const pos of ctx.portfolio.positions) {
      if (pos.tokenId !== book.tokenId) continue;
      if ((pos.size as number) <= 0) continue;
      out.push({
        kind: 'PLACE_ORDER',
        request: {
          marketId: book.marketId,
          tokenId: book.tokenId,
          side: 'SELL',
          type: 'MARKET',
          size: pos.size,
          clientOrderId: this.newClientId('END'),
        },
      });
    }
    return out;
  }

  private cancelAllQuotesForMarket(
    ctx: StrategyContext,
    marketId: string,
  ): readonly Signal[] {
    const out: Signal[] = [];
    for (const order of ctx.openOrders) {
      if (order.marketId !== marketId) continue;
      if (!this.isOurOrder(order)) continue;
      out.push({ kind: 'CANCEL_ORDER', orderId: order.id });
      this.quotesByClientId.delete(order.clientOrderId);
    }
    return out;
  }

  private isOurOrder(o: Order): boolean {
    return this.quotesByClientId.has(o.clientOrderId);
  }

  private canAffordBuy(ctx: StrategyContext, atPrice: number): boolean {
    return (ctx.portfolio.cashUsd as number) >= atPrice * this.params.quoteSize;
  }

  private canSellSize(ctx: StrategyContext, marketId: string, tokenId: string): boolean {
    const pos = ctx.portfolio.positions.find(
      (p) => p.marketId === marketId && p.tokenId === tokenId,
    );
    return (pos?.size ?? 0) >= this.params.quoteSize;
  }

  private newClientId(prefix: string): string {
    return `wsmm-${prefix}-${this.nextClientId++}`;
  }

  private oldestRelevantTime(ctx: StrategyContext): Date {
    // Best-effort: use the oldest of our currently-open orders' createdAt.
    // If we don't have any tracked, treat "now" as creation time so we
    // don't accidentally flatten a brand-new position.
    let oldest: Date | null = null;
    for (const o of ctx.openOrders) {
      if (!this.isOurOrder(o)) continue;
      if (oldest === null || o.createdAt < oldest) oldest = o.createdAt;
    }
    return oldest ?? ctx.clock.now();
  }

  private makeRequest(
    book: OrderBook,
    ctx: StrategyContext,
    side: 'BUY' | 'SELL',
    p: number,
    clientId: string,
  ): OrderRequest {
    return {
      marketId: book.marketId,
      tokenId: book.tokenId,
      side,
      type: 'LIMIT',
      size: size(this.params.quoteSize),
      limitPrice: price(p),
      clientOrderId: clientId,
    };
  }
}

function round(value: number, tick: number): number {
  return Math.round(value / tick) * tick;
}
