import { usd } from '../domain/money.js';
import type { Market, OrderBook } from '../domain/market.js';
import type { Fill, Order } from '../domain/order.js';
import type { Portfolio } from '../domain/portfolio.js';
import type { Logger } from '../logging/logger.js';
import type { MarketDataFeed } from '../marketdata/feed.js';
import type { ExecutionVenue } from '../execution/venue.js';
import type { RiskManager } from '../risk/risk-manager.js';
import type { Strategy } from '../strategy/strategy.js';
import type { Signal } from '../strategy/signal.js';
import type { Clock } from './clock.js';

export interface PortfolioProvider {
  snapshot(): Portfolio;
}

/**
 * Build a PortfolioProvider that reads cash + positions from a venue. The
 * `SimulatedVenue` exposes `snapshot()` directly; the `PolymarketVenue`
 * needs a small adapter that polls cash from on-chain (TBD).
 */
export interface SnapshotableVenue {
  snapshot(): { cashUsd: import('../domain/money.js').Usd; positions: readonly import('../domain/portfolio.js').Position[] };
}

export class VenuePortfolioProvider implements PortfolioProvider {
  constructor(private readonly venue: SnapshotableVenue) {}
  snapshot(): Portfolio {
    const s = this.venue.snapshot();
    return { cashUsd: s.cashUsd, positions: s.positions };
  }
}

export interface EngineOptions {
  readonly feed: MarketDataFeed;
  readonly venue: ExecutionVenue;
  readonly strategy: Strategy;
  readonly risk: RiskManager;
  readonly portfolioProvider: PortfolioProvider;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly markets: ReadonlyMap<string, Market>; // marketId -> Market
  readonly shutdownGraceMs?: number; // how long to wait for cancels on stop
}

/**
 * Wires everything together. The composition root (main.ts) decides which
 * concrete venue/feed are passed in. The engine itself is mode-agnostic.
 *
 * Flow:
 *   1. Feed emits OrderBook
 *   2. Engine builds StrategyContext (fresh portfolio + open orders)
 *   3. Strategy returns Signal[]
 *   4. Each signal goes through RiskManager.approve()
 *   5. Approved → venue.placeOrder / venue.cancelOrder
 *   6. Fills flow back: strategy.onFill + risk.onFill
 *
 * Shutdown:
 *   1. Stop feed
 *   2. venue.cancelAll()
 *   3. Wait up to shutdownGraceMs
 *   4. Caller closes DB
 */
export class Engine {
  private openOrders = new Map<string, Order>(); // OrderId -> Order
  private started = false;
  private stopping = false;

  constructor(private readonly opts: EngineOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.wireVenueEvents();
    this.opts.feed.onBookUpdate((b) => this.handleBookUpdate(b));
    this.opts.feed.onError((e) => this.opts.logger.error({ err: e }, 'engine: feed error'));

    for (const market of this.opts.markets.values()) {
      // eslint-disable-next-line no-await-in-loop
      await this.opts.strategy.onStart(this.contextFor(market));
    }

    await this.opts.feed.subscribe([...this.opts.markets.keys()]);
    await this.opts.feed.start();
    this.opts.logger.info({ strategy: this.opts.strategy.name }, 'engine: started');
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.opts.logger.info('engine: stopping');

    try {
      await this.opts.feed.stop();
    } catch (err) {
      this.opts.logger.error({ err }, 'engine: feed.stop failed');
    }

    try {
      await this.opts.venue.cancelAll();
    } catch (err) {
      this.opts.logger.error({ err }, 'engine: venue.cancelAll failed');
    }

    const grace = this.opts.shutdownGraceMs ?? 10_000;
    const deadline = Date.now() + grace;
    while (Date.now() < deadline) {
      const open = await this.opts.venue.getOpenOrders();
      if (open.length === 0) break;
      await sleep(100);
    }

    for (const market of this.opts.markets.values()) {
      try {
        await this.opts.strategy.onStop(this.contextFor(market));
      } catch (err) {
        this.opts.logger.error({ err }, 'engine: strategy.onStop failed');
      }
    }
    this.opts.logger.info('engine: stopped');
  }

  // --- internals ---

  private wireVenueEvents(): void {
    this.opts.venue.onOrderUpdate((o) => {
      if (o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED') {
        this.openOrders.set(o.id, o);
      } else {
        this.openOrders.delete(o.id);
      }
    });
    this.opts.venue.onFill((f) => this.handleFill(f));
  }

  private handleBookUpdate(book: OrderBook): void {
    if (this.stopping) return;
    if (this.opts.risk.isHalted()) return;

    const market = this.opts.markets.get(book.marketId);
    if (!market) {
      this.opts.logger.warn({ marketId: book.marketId }, 'engine: book for unknown market');
      return;
    }

    let signals: readonly Signal[];
    try {
      signals = this.opts.strategy.onBookUpdate(book, this.contextFor(market));
    } catch (err) {
      this.opts.logger.error({ err }, 'engine: strategy.onBookUpdate threw');
      this.opts.risk.halt('strategy threw');
      return;
    }

    for (const sig of signals) {
      void this.dispatchSignal(sig);
    }
  }

  private handleFill(fill: Fill): void {
    this.opts.risk.onFill(fill);
    const market = this.opts.markets.get(fill.marketId);
    if (market) {
      try {
        this.opts.strategy.onFill(fill, this.contextFor(market));
      } catch (err) {
        this.opts.logger.error({ err }, 'engine: strategy.onFill threw');
        this.opts.risk.halt('strategy.onFill threw');
      }
    }
  }

  private async dispatchSignal(sig: Signal): Promise<void> {
    const market =
      sig.kind === 'PLACE_ORDER'
        ? this.opts.markets.get(sig.request.marketId)
        : undefined;
    const ctx = market
      ? { positions: this.portfolio().positions, openOrders: [...this.openOrders.values()] }
      : { positions: this.portfolio().positions, openOrders: [...this.openOrders.values()] };

    const decision = this.opts.risk.approve(sig, ctx);
    if (!decision.approved) {
      this.opts.logger.warn({ sig, reason: decision.reason }, 'engine: signal rejected by risk');
      return;
    }

    try {
      if (sig.kind === 'PLACE_ORDER') {
        await this.opts.venue.placeOrder(sig.request);
      } else {
        await this.opts.venue.cancelOrder(sig.orderId);
      }
    } catch (err) {
      this.opts.logger.error({ err, sig }, 'engine: venue call failed');
    }
  }

  private contextFor(market: Market) {
    return {
      market,
      portfolio: this.portfolio(),
      openOrders: [...this.openOrders.values()].filter((o) => o.marketId === market.conditionId),
      clock: this.opts.clock,
      logger: this.opts.logger,
    };
  }

  private portfolio(): Portfolio {
    try {
      return this.opts.portfolioProvider.snapshot();
    } catch (err) {
      this.opts.logger.error({ err }, 'engine: portfolio snapshot failed');
      return { cashUsd: usd(0), positions: [] };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
