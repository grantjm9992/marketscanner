import { usd } from '../domain/money.js';
import type { Market, OrderBook } from '../domain/market.js';
import type { Fill, Order } from '../domain/order.js';
import type { Portfolio } from '../domain/portfolio.js';
import type { Logger } from '../logging/logger.js';
import type { MarketDataFeed } from '../marketdata/feed.js';
import type { WalletTrade, WalletTradeFeed } from '../marketdata/wallet-trade-feed.js';
import type { ExecutionVenue } from '../execution/venue.js';
import type { RiskManager } from '../risk/risk-manager.js';
import type { Strategy } from '../strategy/strategy.js';
import type { Signal } from '../strategy/signal.js';
import type { Clock } from './clock.js';

export interface PortfolioProvider {
  snapshot(): Portfolio;
}

export interface SnapshotableVenue {
  snapshot(): {
    cashUsd: import('../domain/money.js').Usd;
    positions: readonly import('../domain/portfolio.js').Position[];
  };
}

export class VenuePortfolioProvider implements PortfolioProvider {
  constructor(private readonly venue: SnapshotableVenue) {}
  snapshot(): Portfolio {
    const s = this.venue.snapshot();
    return { cashUsd: s.cashUsd, positions: s.positions };
  }
}

/**
 * Hook the engine calls on the venue when a market is added/removed at
 * runtime. SimulatedVenue implements this; PolymarketVenue is a no-op.
 */
export interface DynamicMarketsVenue {
  registerMarket?(market: Market): void;
  unregisterMarket?(marketId: string): void;
}

export interface EngineOptions {
  readonly feed: MarketDataFeed;
  readonly venue: ExecutionVenue;
  readonly strategy: Strategy;
  readonly risk: RiskManager;
  readonly portfolioProvider: PortfolioProvider;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly markets: ReadonlyMap<string, Market>;
  readonly shutdownGraceMs?: number;
  readonly walletFeed?: WalletTradeFeed;
  /** Heartbeat log cadence. Default 60_000 (1 min). 0 disables. */
  readonly heartbeatIntervalMs?: number;
}

export class Engine {
  private openOrders = new Map<string, Order>();
  private readonly markets = new Map<string, Market>();
  private started = false;
  private stopping = false;
  private bookUpdatesSinceHeartbeat = 0;
  private signalsSinceHeartbeat = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: EngineOptions) {
    for (const [k, v] of opts.markets) this.markets.set(k, v);
  }

  // --- lifecycle ---

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.wireVenueEvents();
    this.opts.feed.onBookUpdate((b) => this.handleBookUpdate(b));
    this.opts.feed.onError((e) => this.opts.logger.error({ err: e }, 'engine: feed error'));

    if (this.opts.walletFeed && typeof this.opts.strategy.onWalletTrade === 'function') {
      this.opts.walletFeed.onTrade((t) => this.handleWalletTrade(t));
      this.opts.walletFeed.onError((e) =>
        this.opts.logger.error({ err: e }, 'engine: wallet feed error'),
      );
    }

    for (const market of this.markets.values()) {
      // eslint-disable-next-line no-await-in-loop
      await this.opts.strategy.onStart(this.contextFor(market));
    }

    await this.opts.feed.subscribe([...this.markets.keys()]);
    await this.opts.feed.start();
    if (this.opts.walletFeed && typeof this.opts.strategy.onWalletTrade === 'function') {
      await this.opts.walletFeed.start();
      this.opts.logger.info('engine: wallet feed started');
    }

    const heartbeatMs = this.opts.heartbeatIntervalMs ?? 60_000;
    if (heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), heartbeatMs);
    }

    this.opts.logger.info(
      { strategy: this.opts.strategy.name, markets: this.markets.size },
      'engine: started',
    );
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.opts.logger.info('engine: stopping');

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    try {
      await this.opts.feed.stop();
    } catch (err) {
      this.opts.logger.error({ err }, 'engine: feed.stop failed');
    }

    if (this.opts.walletFeed) {
      try {
        await this.opts.walletFeed.stop();
      } catch (err) {
        this.opts.logger.error({ err }, 'engine: walletFeed.stop failed');
      }
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

    for (const market of this.markets.values()) {
      try {
        await this.opts.strategy.onStop(this.contextFor(market));
      } catch (err) {
        this.opts.logger.error({ err }, 'engine: strategy.onStop failed');
      }
    }
    this.opts.logger.info('engine: stopped');
  }

  // --- runtime market churn ---

  /** Returns a defensive copy of currently-tracked market IDs. */
  trackedMarketIds(): readonly string[] {
    return [...this.markets.keys()];
  }

  /**
   * Add a market at runtime. Subscribes the feed, registers with the
   * venue (if it supports DynamicMarketsVenue), and runs strategy.onStart.
   * Idempotent: re-adding an already-tracked market replaces the metadata.
   */
  async addMarket(market: Market): Promise<void> {
    const isNew = !this.markets.has(market.conditionId);
    this.markets.set(market.conditionId, market);

    const dyn = this.opts.venue as unknown as DynamicMarketsVenue;
    dyn.registerMarket?.(market);

    if (isNew) {
      try {
        await this.opts.feed.subscribe([market.conditionId]);
      } catch (err) {
        this.opts.logger.error({ err, marketId: market.conditionId }, 'engine: feed.subscribe failed');
      }
      try {
        await this.opts.strategy.onStart(this.contextFor(market));
      } catch (err) {
        this.opts.logger.error({ err, marketId: market.conditionId }, 'engine: strategy.onStart failed');
      }
      this.opts.logger.info(
        { marketId: market.conditionId, question: market.question },
        'engine: market added',
      );
    } else {
      this.opts.logger.debug(
        { marketId: market.conditionId },
        'engine: market metadata refreshed',
      );
    }
  }

  /**
   * Remove a market at runtime. Cancels any open orders on it, unsubscribes
   * the feed, unregisters with the venue, and runs strategy.onStop.
   * No-op if the market wasn't tracked.
   */
  async removeMarket(marketId: string): Promise<void> {
    const market = this.markets.get(marketId);
    if (!market) return;

    // Cancel any open orders on this market.
    const ours = [...this.openOrders.values()].filter((o) => o.marketId === marketId);
    for (const o of ours) {
      try {
        await this.opts.venue.cancelOrder(o.id);
      } catch (err) {
        this.opts.logger.error({ err, orderId: o.id }, 'engine: cancel-on-remove failed');
      }
    }

    try {
      await this.opts.feed.unsubscribe([marketId]);
    } catch (err) {
      this.opts.logger.error({ err, marketId }, 'engine: feed.unsubscribe failed');
    }

    const dyn = this.opts.venue as unknown as DynamicMarketsVenue;
    dyn.unregisterMarket?.(marketId);

    try {
      await this.opts.strategy.onStop(this.contextFor(market));
    } catch (err) {
      this.opts.logger.error({ err, marketId }, 'engine: strategy.onStop failed');
    }

    this.markets.delete(marketId);
    this.opts.logger.info(
      { marketId, question: market.question, cancelledOrders: ours.length },
      'engine: market removed',
    );
  }

  // --- internals ---

  private wireVenueEvents(): void {
    this.opts.venue.onOrderUpdate((o) => {
      if (o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED') {
        this.openOrders.set(o.id, o);
      } else {
        this.openOrders.delete(o.id);
      }
      this.opts.logger.debug(
        {
          orderId: o.id,
          status: o.status,
          side: o.side,
          marketId: o.marketId,
          filled: o.filledSize,
        },
        'engine: order update',
      );
    });
    this.opts.venue.onFill((f) => this.handleFill(f));
  }

  private handleBookUpdate(book: OrderBook): void {
    if (this.stopping) return;
    if (this.opts.risk.isHalted()) return;

    const market = this.markets.get(book.marketId);
    if (!market) {
      this.opts.logger.warn({ marketId: book.marketId }, 'engine: book for unknown market');
      return;
    }
    this.bookUpdatesSinceHeartbeat += 1;

    let signals: readonly Signal[];
    try {
      signals = this.opts.strategy.onBookUpdate(book, this.contextFor(market));
    } catch (err) {
      this.opts.logger.error({ err }, 'engine: strategy.onBookUpdate threw');
      this.opts.risk.halt('strategy threw');
      return;
    }

    if (signals.length > 0) {
      this.signalsSinceHeartbeat += signals.length;
      this.opts.logger.info(
        {
          marketId: book.marketId,
          signals: signals.length,
          kinds: signals.map((s) => s.kind),
        },
        'engine: strategy emitted signals',
      );
    }

    for (const sig of signals) {
      void this.dispatchSignal(sig);
    }
  }

  private handleFill(fill: Fill): void {
    this.opts.risk.onFill(fill);
    this.opts.logger.info(
      {
        orderId: fill.orderId,
        side: fill.side,
        size: fill.size,
        price: fill.price,
        feeUsd: fill.feeUsd,
        marketId: fill.marketId,
      },
      'engine: FILL',
    );
    const market = this.markets.get(fill.marketId);
    if (market) {
      try {
        this.opts.strategy.onFill(fill, this.contextFor(market));
      } catch (err) {
        this.opts.logger.error({ err }, 'engine: strategy.onFill threw');
        this.opts.risk.halt('strategy.onFill threw');
      }
    }
  }

  private handleWalletTrade(trade: WalletTrade): void {
    if (this.stopping) return;
    if (this.opts.risk.isHalted()) return;

    const market = this.markets.get(trade.marketId);
    if (!market) return;

    const onWalletTrade = this.opts.strategy.onWalletTrade?.bind(this.opts.strategy);
    if (!onWalletTrade) return;

    let signals: readonly Signal[];
    try {
      signals = onWalletTrade(trade, this.contextFor(market));
    } catch (err) {
      this.opts.logger.error({ err }, 'engine: strategy.onWalletTrade threw');
      this.opts.risk.halt('strategy.onWalletTrade threw');
      return;
    }
    if (signals.length > 0) {
      this.signalsSinceHeartbeat += signals.length;
      this.opts.logger.info(
        {
          marketId: trade.marketId,
          walletAddress: trade.walletAddress,
          signals: signals.length,
        },
        'engine: wallet-trade triggered signals',
      );
    }
    for (const sig of signals) void this.dispatchSignal(sig);
  }

  private async dispatchSignal(sig: Signal): Promise<void> {
    const ctx = {
      positions: this.portfolio().positions,
      openOrders: [...this.openOrders.values()],
    };

    const decision = this.opts.risk.approve(sig, ctx);
    if (!decision.approved) {
      this.opts.logger.warn(
        { sig, reason: decision.reason },
        'engine: signal rejected by risk',
      );
      return;
    }

    try {
      if (sig.kind === 'PLACE_ORDER') {
        const order = await this.opts.venue.placeOrder(sig.request);
        this.opts.logger.info(
          {
            orderId: order.id,
            status: order.status,
            side: sig.request.side,
            type: sig.request.type,
            size: sig.request.size,
            limitPrice: sig.request.limitPrice,
            marketId: sig.request.marketId,
          },
          'engine: ORDER PLACED',
        );
      } else {
        await this.opts.venue.cancelOrder(sig.orderId);
        this.opts.logger.info({ orderId: sig.orderId }, 'engine: ORDER CANCELLED');
      }
    } catch (err) {
      this.opts.logger.error({ err, sig }, 'engine: venue call failed');
    }
  }

  private heartbeat(): void {
    const portfolio = this.portfolio();
    void this.opts.venue.getOpenOrders().then((open) => {
      this.opts.logger.info(
        {
          markets: this.markets.size,
          openOrders: open.length,
          positions: portfolio.positions.length,
          cashUsd: portfolio.cashUsd,
          bookUpdates: this.bookUpdatesSinceHeartbeat,
          signals: this.signalsSinceHeartbeat,
          halted: this.opts.risk.isHalted(),
        },
        'engine: heartbeat',
      );
      this.bookUpdatesSinceHeartbeat = 0;
      this.signalsSinceHeartbeat = 0;
    });
  }

  private contextFor(market: Market) {
    return {
      market,
      portfolio: this.portfolio(),
      openOrders: [...this.openOrders.values()].filter(
        (o) => o.marketId === market.conditionId,
      ),
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
