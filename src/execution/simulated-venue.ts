import { addSize, addUsd, isPriceOnTick, price, size, subUsd, usd } from '../domain/money.js';
import type { Price, Size, Usd } from '../domain/money.js';
import { orderId } from '../domain/order.js';
import type {
  Fill,
  Order,
  OrderId,
  OrderRequest,
  OrderStatus,
  Side,
} from '../domain/order.js';
import type { Market, OrderBook, PriceLevel } from '../domain/market.js';
import type { Position } from '../domain/portfolio.js';
import type { Clock } from '../engine/clock.js';
import type { ExecutionVenue } from './venue.js';
import type { FeeSchedule } from './fees.js';
import type { Logger } from '../logging/logger.js';
import type { TradeLogStore } from '../persistence/repositories/types.js';

/**
 * Per-market metadata the venue needs to validate orders.
 * Indexed by `marketId`.
 */
export interface MarketSpec {
  readonly marketId: string;
  readonly tickSize: Price;
  readonly minOrderSize: Size;
}

export interface SimulatedVenueOptions {
  readonly clock: Clock;
  readonly fees: FeeSchedule;
  readonly latencyMs: number;
  readonly startingCashUsd: Usd;
  readonly markets: ReadonlyMap<string, MarketSpec>;
  readonly logger: Logger;
  readonly tradeLog?: TradeLogStore;
}

/**
 * Simulated venue. Models limit/market fills, partial fills with book walks,
 * latency, fees, and reservation-based cash & position accounting.
 *
 * Honesty rules (do not bypass):
 *   1. Market orders cross the spread; market BUY walks asks, SELL walks bids.
 *   2. Limit orders only fill when the opposite book crosses them.
 *   3. Partial fills are normal; remaining size stays open.
 *   4. Latency: orders are not eligible to match until clock.now() >= placedAt + latencyMs.
 *   5. avgFillPrice is the size-weighted average across walked levels.
 *   6. Rejection: minOrderSize, tick alignment, insufficient cash, insufficient position.
 *
 * The venue does not subscribe to a feed itself. Engine pushes book updates
 * via `onBookUpdate(book)`.
 */
export class SimulatedVenue implements ExecutionVenue {
  private cash: Usd;
  private readonly positions = new Map<string, Position>(); // tokenId -> Position
  private readonly orders = new Map<OrderId, OrderState>();
  private readonly latestBooks = new Map<string, OrderBook>(); // tokenId -> book
  private readonly fillHandlers: Array<(f: Fill) => void> = [];
  private readonly orderUpdateHandlers: Array<(o: Order) => void> = [];
  private nextId = 1;
  // Unique per-process token so order IDs don't collide with prior runs
  // sharing the same SQLite trade log. Without this, a query that joins
  // ORDER_PLACED to CANCEL on order_id can match across runs.
  private readonly idPrefix = `sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-`;
  /** Mutable copy of the market specs the venue knows about. */
  private readonly marketSpecs = new Map<string, MarketSpec>();

  constructor(private readonly opts: SimulatedVenueOptions) {
    this.cash = opts.startingCashUsd;
    for (const [k, v] of opts.markets) this.marketSpecs.set(k, v);
  }

  /**
   * Register (or replace) a market spec at runtime. Used by the engine
   * when MarketRefresher discovers a new market.
   */
  registerMarket(market: Market): void {
    this.marketSpecs.set(market.conditionId, {
      marketId: market.conditionId,
      tickSize: market.tickSize,
      minOrderSize: market.minOrderSize,
    });
  }

  /**
   * Drop a market spec. Open orders on this market remain — caller is
   * expected to cancel them before unregistering.
   */
  unregisterMarket(marketId: string): void {
    this.marketSpecs.delete(marketId);
  }

  // --- ExecutionVenue interface ---

  async placeOrder(req: OrderRequest): Promise<Order> {
    const now = this.opts.clock.now();
    const reject = (reason: string): Order => {
      const rejected = this.makeOrder(req, '__rejected__' as unknown as OrderId, 'REJECTED', now);
      this.fireAndForget(this.opts.tradeLog?.recordReject(req, reason, now));
      this.opts.logger.warn({ req, reason }, 'simulated-venue: order rejected');
      return rejected;
    };

    const validation = this.validate(req);
    if (validation !== null) return reject(validation);

    const id = orderId(`${this.idPrefix}${this.nextId++}`);
    const eligibleAt = new Date(now.getTime() + this.opts.latencyMs);

    const reservedCash = this.reservationCashFor(req);
    const reservedSize = this.reservationSizeFor(req);

    if (reservedCash > this.availableCash()) {
      return reject(`insufficient cash: need ${reservedCash}, have ${this.availableCash()}`);
    }
    if (reservedSize > 0 && this.availableSize(req.tokenId) < reservedSize) {
      return reject(
        `insufficient position: need ${reservedSize} of ${req.tokenId}, have ${this.availableSize(req.tokenId)}`,
      );
    }

    const state: OrderState = {
      order: this.makeOrder(req, id, 'OPEN', now),
      eligibleAt,
      reservedCash,
      reservedSize,
      lastMatchedBookTs: -1,
      marketOrderConsumed: false,
    };
    this.orders.set(id, state);
    this.fireAndForget(this.opts.tradeLog?.recordOrderPlaced(req, id, now));
    this.emitOrderUpdate(state.order);

    // Best-effort immediate match: if the order has zero latency and a book
    // is already known, try matching synchronously. Otherwise it'll be
    // matched when the next book update arrives after eligibleAt.
    if (this.opts.latencyMs === 0) {
      this.tryMatchOne(state);
    }

    return state.order;
  }

  async cancelOrder(id: OrderId): Promise<void> {
    const state = this.orders.get(id);
    if (!state) return;
    if (state.order.status === 'FILLED' || state.order.status === 'CANCELLED') return;

    this.releaseReservations(state);
    state.order = { ...state.order, status: 'CANCELLED', updatedAt: this.opts.clock.now() };
    this.fireAndForget(this.opts.tradeLog?.recordCancel(state.order, this.opts.clock.now()));
    this.emitOrderUpdate(state.order);
  }

  async cancelAll(): Promise<void> {
    const ids = [...this.orders.keys()];
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      await this.cancelOrder(id);
    }
  }

  async getOpenOrders(): Promise<readonly Order[]> {
    return [...this.orders.values()]
      .filter((s) => s.order.status === 'OPEN' || s.order.status === 'PARTIALLY_FILLED')
      .map((s) => s.order);
  }

  async getPositions(): Promise<readonly Position[]> {
    return [...this.positions.values()];
  }

  onFill(handler: (f: Fill) => void): void {
    this.fillHandlers.push(handler);
  }

  onOrderUpdate(handler: (o: Order) => void): void {
    this.orderUpdateHandlers.push(handler);
  }

  // --- Driven by the engine ---

  /**
   * Engine calls this for every book update. Triggers matching of any
   * eligible open orders against the new book.
   */
  onBookUpdate(book: OrderBook): void {
    this.latestBooks.set(book.tokenId, book);
    this.matchAll();
  }

  /**
   * Read-only snapshot of cash + positions. Used by the engine to build
   * StrategyContext.
   */
  snapshot(): { cashUsd: Usd; positions: readonly Position[] } {
    return { cashUsd: this.cash, positions: [...this.positions.values()] };
  }

  // --- Internals ---

  private matchAll(): void {
    // Match in placement order so ordering of partial fills is stable.
    const sorted = [...this.orders.values()].sort(
      (a, b) => a.order.createdAt.getTime() - b.order.createdAt.getTime(),
    );
    for (const state of sorted) {
      this.tryMatchOne(state);
    }
  }

  private tryMatchOne(state: OrderState): void {
    if (state.order.status !== 'OPEN' && state.order.status !== 'PARTIALLY_FILLED') return;

    const now = this.opts.clock.now();
    if (now.getTime() < state.eligibleAt.getTime()) return;

    const book = this.latestBooks.get(state.order.tokenId);
    if (!book) return;

    // Each book update is a single moment of liquidity. Don't let the same
    // book be consumed twice — limit orders wait for a new book update;
    // market orders only get one shot total.
    if (book.timestamp.getTime() <= state.lastMatchedBookTs) return;
    if (state.order.type === 'MARKET' && state.marketOrderConsumed) return;

    const remaining = (state.order.size as number) - (state.order.filledSize as number);
    if (remaining <= 0) return;

    const consumable = consumableLevels(book, state.order);
    if (consumable.length === 0) return;

    let filledThisRound = 0;
    let weightedNotional = 0;
    for (const level of consumable) {
      const take = Math.min(level.size as number, remaining - filledThisRound);
      if (take <= 0) break;
      filledThisRound += take;
      weightedNotional += take * (level.price as number);
      if (filledThisRound >= remaining) break;
    }

    state.lastMatchedBookTs = book.timestamp.getTime();
    if (state.order.type === 'MARKET') state.marketOrderConsumed = true;

    if (filledThisRound <= 0) return;

    // If only one level was consumed, take its price directly to avoid
    // IEEE 754 noise from divide-then-multiply.
    const avgFillPrice =
      consumable.length === 1 || filledThisRound === (consumable[0]?.size as number | undefined)
        ? (consumable[0]?.price as Price)
        : price(weightedNotional / filledThisRound);
    const fillSize = size(filledThisRound);
    const feeUsd = this.opts.fees.feeFor({
      side: state.order.side,
      price: avgFillPrice,
      size: fillSize,
    });

    // Settle cash & position. Reservations are pre-fill checks only — they
    // never debit `this.cash` directly. Cash moves only at fill time.
    const notional = (avgFillPrice as number) * filledThisRound;
    if (state.order.side === 'BUY') {
      this.cash = usd((this.cash as number) - notional - (feeUsd as number));
      const reservationPrice = state.order.limitPrice ?? price(1);
      const releasedReservation = (reservationPrice as number) * filledThisRound;
      state.reservedCash = usd(Math.max(0, (state.reservedCash as number) - releasedReservation));
      this.applyPositionDelta(state.order.marketId, state.order.tokenId, 'BUY', fillSize, avgFillPrice, feeUsd);
    } else {
      this.cash = usd((this.cash as number) + notional - (feeUsd as number));
      state.reservedSize = size(Math.max(0, (state.reservedSize as number) - filledThisRound));
      this.applyPositionDelta(
        state.order.marketId,
        state.order.tokenId,
        'SELL',
        fillSize,
        avgFillPrice,
        feeUsd,
      );
    }

    const newFilled = addSize(state.order.filledSize, fillSize);
    const totalSize = state.order.size as number;
    const newStatus: OrderStatus = newFilled >= totalSize ? 'FILLED' : 'PARTIALLY_FILLED';
    const prevAvg = state.order.avgFillPrice;
    const prevFilled = state.order.filledSize as number;
    const newAvg = price(
      ((prevAvg ?? 0) * prevFilled + (avgFillPrice as number) * filledThisRound) /
        (prevFilled + filledThisRound),
    );

    state.order = {
      ...state.order,
      status: newStatus,
      filledSize: newFilled,
      avgFillPrice: newAvg,
      updatedAt: now,
    };

    if (newStatus === 'FILLED') {
      // Release any leftover reservation slack (e.g., a BUY filled below
      // its limit price has unused reserved cash).
      this.releaseReservations(state);
    }

    const fill: Fill = {
      orderId: state.order.id,
      marketId: state.order.marketId,
      tokenId: state.order.tokenId,
      side: state.order.side,
      price: avgFillPrice,
      size: fillSize,
      feeUsd,
      timestamp: now,
    };
    this.fireAndForget(this.opts.tradeLog?.recordFill(fill));
    this.emitFill(fill);
    this.emitOrderUpdate(state.order);

    if (filledThisRound > 0 && (consumable[0]?.size ?? 0) < filledThisRound) {
      this.opts.logger.debug(
        {
          orderId: state.order.id,
          fillSize,
          avgFillPrice,
          levelsWalked: consumable.length,
        },
        'simulated-venue: walked book',
      );
    }
  }

  private applyPositionDelta(
    marketId: string,
    tokenId: string,
    side: Side,
    qty: Size,
    fillPrice: Price,
    feeUsd: Usd,
  ): void {
    const existing = this.positions.get(tokenId);
    if (side === 'BUY') {
      if (!existing) {
        this.positions.set(tokenId, {
          marketId,
          tokenId,
          size: qty,
          avgEntryPrice: fillPrice,
          realizedPnlUsd: usd(-(feeUsd as number)),
        });
        return;
      }
      const newSize = (existing.size as number) + (qty as number);
      const newAvg =
        ((existing.avgEntryPrice as number) * (existing.size as number) +
          (fillPrice as number) * (qty as number)) /
        newSize;
      this.positions.set(tokenId, {
        ...existing,
        size: size(newSize),
        avgEntryPrice: price(newAvg),
        realizedPnlUsd: subUsd(existing.realizedPnlUsd, feeUsd),
      });
    } else {
      // SELL: realize PnL = (fillPrice - avgEntry) * qty - fee
      if (!existing) {
        // Shouldn't happen — reservation guard should have caught this.
        throw new Error(`SELL fill on tokenId=${tokenId} with no position`);
      }
      const realized = ((fillPrice as number) - (existing.avgEntryPrice as number)) * (qty as number);
      const newSize = (existing.size as number) - (qty as number);
      const newRealized = addUsd(existing.realizedPnlUsd, usd(realized - (feeUsd as number)));
      if (newSize <= 1e-12) {
        // Effectively flat. Keep the position record so realized PnL is
        // still queryable; size goes to 0.
        this.positions.set(tokenId, {
          ...existing,
          size: size(0),
          realizedPnlUsd: newRealized,
        });
      } else {
        this.positions.set(tokenId, {
          ...existing,
          size: size(newSize),
          realizedPnlUsd: newRealized,
        });
      }
    }
  }

  private releaseReservations(state: OrderState): void {
    if (state.reservedCash > 0) {
      // Cash was reserved up-front; releasing means it goes back to free.
      // (For BUY orders that filled, we already deducted actual cost in
      // tryMatchOne; reservedCash now holds only the unfilled portion.)
      // No-op on cash itself: availableCash() already accounts for
      // reservedCash dynamically. We just zero the reservation.
      state.reservedCash = usd(0);
    }
    if (state.reservedSize > 0) {
      state.reservedSize = size(0);
    }
  }

  private validate(req: OrderRequest): string | null {
    const spec = this.marketSpecs.get(req.marketId);
    if (!spec) return `unknown market: ${req.marketId}`;
    if ((req.size as number) < (spec.minOrderSize as number)) {
      return `size ${req.size} below minOrderSize ${spec.minOrderSize}`;
    }
    if (req.type === 'LIMIT') {
      if (req.limitPrice === undefined) return 'LIMIT order requires limitPrice';
      if (!isPriceOnTick(req.limitPrice, spec.tickSize)) {
        return `price ${req.limitPrice} not aligned to tick ${spec.tickSize}`;
      }
    }
    if (req.type === 'MARKET' && req.limitPrice !== undefined) {
      return 'MARKET order must not include limitPrice';
    }
    return null;
  }

  private reservationCashFor(req: OrderRequest): Usd {
    if (req.side !== 'BUY') return usd(0);
    // For LIMIT BUY: reserve at the limit price. For MARKET BUY: reserve
    // size * 1.0 (max possible price for a binary outcome).
    const reservePrice = req.limitPrice ?? price(1);
    return usd((req.size as number) * (reservePrice as number));
  }

  private reservationSizeFor(req: OrderRequest): Size {
    if (req.side !== 'SELL') return size(0);
    return req.size;
  }

  private availableCash(): Usd {
    let reserved = 0;
    for (const s of this.orders.values()) {
      if (s.order.status === 'OPEN' || s.order.status === 'PARTIALLY_FILLED') {
        reserved += s.reservedCash as number;
      }
    }
    return usd((this.cash as number) - reserved);
  }

  private availableSize(tokenId: string): Size {
    const pos = this.positions.get(tokenId);
    let reserved = 0;
    for (const s of this.orders.values()) {
      if (
        s.order.tokenId === tokenId &&
        (s.order.status === 'OPEN' || s.order.status === 'PARTIALLY_FILLED')
      ) {
        reserved += s.reservedSize as number;
      }
    }
    return size(Math.max(0, (pos?.size ?? size(0)) - reserved));
  }

  private makeOrder(
    req: OrderRequest,
    id: OrderId,
    status: OrderStatus,
    at: Date,
  ): Order {
    return {
      ...req,
      id,
      status,
      filledSize: size(0),
      avgFillPrice: null,
      createdAt: at,
      updatedAt: at,
    };
  }

  private emitFill(fill: Fill): void {
    for (const h of this.fillHandlers) h(fill);
  }

  private emitOrderUpdate(order: Order): void {
    for (const h of this.orderUpdateHandlers) h(order);
  }

  /**
   * Fire-and-forget for trade-log writes. Callers don't need to wait
   * for an audit row to commit before continuing the fill loop. Errors
   * are logged but don't propagate.
   */
  private fireAndForget(p: Promise<void> | undefined): void {
    if (!p) return;
    p.catch((err: unknown) => {
      this.opts.logger.error({ err }, 'simulated-venue: trade-log write failed');
    });
  }
}

interface OrderState {
  order: Order;
  readonly eligibleAt: Date;
  reservedCash: Usd;
  reservedSize: Size;
  lastMatchedBookTs: number;
  marketOrderConsumed: boolean;
}

/**
 * Returns the levels (in walk order) that an order is allowed to consume,
 * given a book. For a BUY: asks priced <= limitPrice (or all asks for a
 * market BUY). For a SELL: bids priced >= limitPrice (or all bids for a
 * market SELL).
 */
function consumableLevels(book: OrderBook, order: Order): readonly PriceLevel[] {
  if (order.side === 'BUY') {
    const limit = order.type === 'MARKET' ? Number.POSITIVE_INFINITY : (order.limitPrice as number);
    return book.asks.filter((l) => (l.price as number) <= limit);
  } else {
    const limit = order.type === 'MARKET' ? Number.NEGATIVE_INFINITY : (order.limitPrice as number);
    return book.bids.filter((l) => (l.price as number) >= limit);
  }
}
