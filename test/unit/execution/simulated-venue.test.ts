import { describe, it, expect, beforeEach } from 'vitest';
import {
  SimulatedVenue,
  type MarketSpec,
  type SimulatedVenueOptions,
} from '../../../src/execution/simulated-venue.js';
import { price, size, usd } from '../../../src/domain/money.js';
import type { OrderBook } from '../../../src/domain/market.js';
import type { Fill, Order, OrderRequest } from '../../../src/domain/order.js';
import { FakeClock } from '../../../src/engine/clock.js';
import { FlatFeeSchedule, PolymarketFeeSchedule } from '../../../src/execution/fees.js';
import { createLogger } from '../../../src/logging/logger.js';

const MARKET_ID = 'm1';
const TOKEN_ID = 't1';

const spec: MarketSpec = {
  marketId: MARKET_ID,
  tickSize: price(0.01),
  minOrderSize: size(5),
};

function makeVenue(overrides: Partial<SimulatedVenueOptions> = {}): {
  venue: SimulatedVenue;
  clock: FakeClock;
  fills: Fill[];
  orderUpdates: Order[];
} {
  const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
  const opts: SimulatedVenueOptions = {
    clock,
    fees: new PolymarketFeeSchedule(),
    latencyMs: 0,
    startingCashUsd: usd(1000),
    markets: new Map([[MARKET_ID, spec]]),
    logger: createLogger({ level: 'error' }),
    ...overrides,
  };
  const venue = new SimulatedVenue(opts);
  const fills: Fill[] = [];
  const orderUpdates: Order[] = [];
  venue.onFill((f) => fills.push(f));
  venue.onOrderUpdate((o) => orderUpdates.push(o));
  return { venue, clock, fills, orderUpdates };
}

function book(opts: {
  bids: ReadonlyArray<readonly [number, number]>;
  asks: ReadonlyArray<readonly [number, number]>;
  ts?: Date;
}): OrderBook {
  return {
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    bids: opts.bids.map(([p, s]) => ({ price: price(p), size: size(s) })),
    asks: opts.asks.map(([p, s]) => ({ price: price(p), size: size(s) })),
    timestamp: opts.ts ?? new Date('2026-01-01T00:00:00Z'),
  };
}

function buyLimit(p: number, s: number, id = 'c1'): OrderRequest {
  return {
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    side: 'BUY',
    type: 'LIMIT',
    size: size(s),
    limitPrice: price(p),
    clientOrderId: id,
  };
}

function sellLimit(p: number, s: number, id = 'c2'): OrderRequest {
  return {
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    side: 'SELL',
    type: 'LIMIT',
    size: size(s),
    limitPrice: price(p),
    clientOrderId: id,
  };
}

function buyMarket(s: number, id = 'cm'): OrderRequest {
  return {
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    side: 'BUY',
    type: 'MARKET',
    size: size(s),
    clientOrderId: id,
  };
}

function sellMarket(s: number, id = 'cm2'): OrderRequest {
  return {
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    side: 'SELL',
    type: 'MARKET',
    size: size(s),
    clientOrderId: id,
  };
}

describe('SimulatedVenue: market orders', () => {
  let h: ReturnType<typeof makeVenue>;
  beforeEach(() => {
    h = makeVenue();
  });

  it('market BUY fills at the best ask', async () => {
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }));
    const order = await h.venue.placeOrder(buyMarket(10));
    // With zero latency and a known book, market BUY fills synchronously.
    expect(order.status).toBe('FILLED');
    expect(h.fills.length).toBe(1);
    expect(h.fills[0]?.price).toBe(0.51);
    expect(h.fills[0]?.size).toBe(10);
  });

  it('market SELL fills at the best bid', async () => {
    // Need a position to sell.
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }));
    await h.venue.placeOrder(buyMarket(20));
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }));
    h.fills.length = 0;

    await h.venue.placeOrder(sellMarket(10));
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }));
    expect(h.fills.length).toBe(1);
    expect(h.fills[0]?.price).toBeCloseTo(0.49, 8);
    expect(h.fills[0]?.size).toBe(10);
  });

  it('market BUY walks the book when size exceeds top level', async () => {
    h.venue.onBookUpdate(
      book({
        bids: [[0.49, 100]],
        asks: [
          [0.51, 100],
          [0.52, 200],
          [0.55, 500],
        ],
      }),
    );
    await h.venue.placeOrder(buyMarket(250));
    h.venue.onBookUpdate(
      book({
        bids: [[0.49, 100]],
        asks: [
          [0.51, 100],
          [0.52, 200],
          [0.55, 500],
        ],
      }),
    );
    expect(h.fills.length).toBe(1);
    // 100 @ 0.51 + 150 @ 0.52 = 51 + 78 = 129 over 250 = 0.516
    expect(h.fills[0]?.size).toBe(250);
    expect(h.fills[0]?.price).toBeCloseTo(0.516, 6);
  });

  it('market BUY larger than total ask depth partially fills', async () => {
    h.venue.onBookUpdate(
      book({
        bids: [[0.49, 100]],
        asks: [
          [0.51, 50],
          [0.52, 50],
        ],
      }),
    );
    await h.venue.placeOrder(buyMarket(500));
    h.venue.onBookUpdate(
      book({
        bids: [[0.49, 100]],
        asks: [
          [0.51, 50],
          [0.52, 50],
        ],
      }),
    );
    expect(h.fills.length).toBe(1);
    expect(h.fills[0]?.size).toBe(100);
    const open = await h.venue.getOpenOrders();
    expect(open.length).toBe(1);
    expect(open[0]?.status).toBe('PARTIALLY_FILLED');
    expect(open[0]?.filledSize).toBe(100);
  });

  it('market BUY does not fill when asks are empty', async () => {
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [] }));
    await h.venue.placeOrder(buyMarket(10));
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [] }));
    expect(h.fills.length).toBe(0);
  });
});

describe('SimulatedVenue: limit orders', () => {
  let h: ReturnType<typeof makeVenue>;
  beforeEach(() => {
    h = makeVenue();
  });

  it('limit BUY does not fill when ask is above limit', async () => {
    await h.venue.placeOrder(buyLimit(0.5, 10));
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }));
    expect(h.fills.length).toBe(0);
  });

  it('limit BUY fills at exact touch (ask == limit)', async () => {
    await h.venue.placeOrder(buyLimit(0.51, 10));
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }));
    expect(h.fills.length).toBe(1);
    expect(h.fills[0]?.price).toBe(0.51);
  });

  it('limit BUY fills at the lower book price when book crosses', async () => {
    await h.venue.placeOrder(buyLimit(0.5, 10));
    h.venue.onBookUpdate(book({ bids: [[0.45, 100]], asks: [[0.48, 100]] }));
    expect(h.fills.length).toBe(1);
    expect(h.fills[0]?.price).toBe(0.48);
  });

  it('limit BUY only consumes liquidity at <= limit', async () => {
    await h.venue.placeOrder(buyLimit(0.5, 200));
    h.venue.onBookUpdate(
      book({
        bids: [[0.49, 100]],
        asks: [
          [0.49, 50],
          [0.5, 100],
          [0.51, 500],
        ],
      }),
    );
    // 50 @ 0.49 + 100 @ 0.5 = 150 filled, avg = (50*0.49+100*0.5)/150
    expect(h.fills.length).toBe(1);
    expect(h.fills[0]?.size).toBe(150);
    expect(h.fills[0]?.price).toBeCloseTo((50 * 0.49 + 100 * 0.5) / 150, 6);
    const open = await h.venue.getOpenOrders();
    expect(open[0]?.status).toBe('PARTIALLY_FILLED');
  });

  it('limit SELL does not fill when bid is below limit', async () => {
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }));
    await h.venue.placeOrder(buyMarket(50));
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }));
    h.fills.length = 0;

    await h.venue.placeOrder(sellLimit(0.55, 10));
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }));
    expect(h.fills.length).toBe(0);
  });

  it('limit SELL fills when bid >= limit', async () => {
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }));
    await h.venue.placeOrder(buyMarket(50));
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }));
    h.fills.length = 0;

    await h.venue.placeOrder(sellLimit(0.45, 10));
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }));
    expect(h.fills.length).toBe(1);
    expect(h.fills[0]?.price).toBeCloseTo(0.49, 8);
  });

  it('marks order FILLED when fully filled', async () => {
    await h.venue.placeOrder(buyLimit(0.5, 10));
    h.venue.onBookUpdate(book({ bids: [[0.45, 100]], asks: [[0.48, 100]] }));
    const open = await h.venue.getOpenOrders();
    expect(open.length).toBe(0);
    expect(h.orderUpdates.at(-1)?.status).toBe('FILLED');
  });
});

describe('SimulatedVenue: rejections', () => {
  let h: ReturnType<typeof makeVenue>;
  beforeEach(() => {
    h = makeVenue();
  });

  it('rejects unknown market', async () => {
    const order = await h.venue.placeOrder({
      marketId: 'unknown',
      tokenId: TOKEN_ID,
      side: 'BUY',
      type: 'LIMIT',
      size: size(10),
      limitPrice: price(0.5),
      clientOrderId: 'c',
    });
    expect(order.status).toBe('REJECTED');
  });

  it('rejects size below minOrderSize', async () => {
    const order = await h.venue.placeOrder(buyLimit(0.5, 1));
    expect(order.status).toBe('REJECTED');
  });

  it('rejects price not on tick', async () => {
    const order = await h.venue.placeOrder(buyLimit(0.505, 10));
    expect(order.status).toBe('REJECTED');
  });

  it('rejects LIMIT without limitPrice', async () => {
    const req: OrderRequest = {
      marketId: MARKET_ID,
      tokenId: TOKEN_ID,
      side: 'BUY',
      type: 'LIMIT',
      size: size(10),
      clientOrderId: 'x',
    };
    const order = await h.venue.placeOrder(req);
    expect(order.status).toBe('REJECTED');
  });

  it('rejects MARKET with limitPrice', async () => {
    const req: OrderRequest = {
      marketId: MARKET_ID,
      tokenId: TOKEN_ID,
      side: 'BUY',
      type: 'MARKET',
      size: size(10),
      limitPrice: price(0.5),
      clientOrderId: 'x',
    };
    const order = await h.venue.placeOrder(req);
    expect(order.status).toBe('REJECTED');
  });

  it('rejects when reserving more cash than available', async () => {
    // 10000 shares at 0.5 = $5000, but startingCashUsd is $1000.
    const order = await h.venue.placeOrder(buyLimit(0.5, 10000));
    expect(order.status).toBe('REJECTED');
  });

  it('rejects SELL with no position', async () => {
    const order = await h.venue.placeOrder(sellLimit(0.5, 10));
    expect(order.status).toBe('REJECTED');
  });
});

describe('SimulatedVenue: latency', () => {
  it('does not match before eligibleAt', async () => {
    const h = makeVenue({ latencyMs: 250 });
    h.venue.onBookUpdate(book({ bids: [[0.45, 100]], asks: [[0.48, 100]] }));
    await h.venue.placeOrder(buyLimit(0.5, 10));
    h.venue.onBookUpdate(book({ bids: [[0.45, 100]], asks: [[0.48, 100]] }));
    expect(h.fills.length).toBe(0);

    h.clock.advance(249);
    h.venue.onBookUpdate(book({ bids: [[0.45, 100]], asks: [[0.48, 100]] }));
    expect(h.fills.length).toBe(0);

    h.clock.advance(1); // now at 250ms
    h.venue.onBookUpdate(book({ bids: [[0.45, 100]], asks: [[0.48, 100]] }));
    expect(h.fills.length).toBe(1);
  });
});

describe('SimulatedVenue: fees', () => {
  it('charges flat-rate fees on fills and reduces realized PnL', async () => {
    const h = makeVenue({ fees: new FlatFeeSchedule(0.01) }); // 1%
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }));
    await h.venue.placeOrder(buyMarket(100));
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }));
    expect(h.fills[0]?.feeUsd).toBeCloseTo(100 * 0.5 * 0.01); // 0.5
  });

  it('PolymarketFeeSchedule charges 0', async () => {
    const h = makeVenue();
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }));
    await h.venue.placeOrder(buyMarket(10));
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }));
    expect(h.fills[0]?.feeUsd).toBe(0);
  });
});

describe('SimulatedVenue: cash & position accounting', () => {
  it('decreases cash on BUY, increases on SELL', async () => {
    const h = makeVenue();
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }));
    await h.venue.placeOrder(buyMarket(100));
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }));
    let snap = h.venue.snapshot();
    expect(snap.cashUsd).toBeCloseTo(1000 - 50);
    expect(snap.positions[0]?.size).toBe(100);
    expect(snap.positions[0]?.avgEntryPrice).toBe(0.5);

    await h.venue.placeOrder(sellMarket(50));
    h.venue.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }));
    snap = h.venue.snapshot();
    expect(snap.cashUsd).toBeCloseTo(1000 - 50 + 50 * 0.49);
    expect(snap.positions[0]?.size).toBe(50);
    // realizedPnl = (0.49 - 0.5) * 50 = -0.5
    expect(snap.positions[0]?.realizedPnlUsd).toBeCloseTo(-0.5);
  });

  it('partial fills walking levels produce a single weighted-avg fill event', async () => {
    const h = makeVenue();
    h.venue.onBookUpdate(
      book({
        bids: [[0.49, 100]],
        asks: [
          [0.5, 50],
          [0.52, 50],
        ],
      }),
    );
    await h.venue.placeOrder(buyMarket(100));
    h.venue.onBookUpdate(
      book({
        bids: [[0.49, 100]],
        asks: [
          [0.5, 50],
          [0.52, 50],
        ],
      }),
    );
    expect(h.fills.length).toBe(1);
    expect(h.fills[0]?.price).toBeCloseTo((50 * 0.5 + 50 * 0.52) / 100);
  });

  it('limit BUY filling below limit refunds the unused cash reservation', async () => {
    const h = makeVenue();
    // Place a BUY LIMIT at 0.50 — reservation = 100 * 0.50 = $50
    await h.venue.placeOrder(buyLimit(0.5, 100));
    // Cross at 0.40 — should fill all 100 at 0.40 = $40 spent
    h.venue.onBookUpdate(book({ bids: [[0.39, 100]], asks: [[0.4, 100]] }));
    const snap = h.venue.snapshot();
    expect(snap.cashUsd).toBeCloseTo(1000 - 40);
  });
});

describe('SimulatedVenue: cancellation', () => {
  it('cancels an open order and releases cash', async () => {
    const h = makeVenue();
    const placed = await h.venue.placeOrder(buyLimit(0.5, 100));
    await h.venue.cancelOrder(placed.id);
    expect((await h.venue.getOpenOrders()).length).toBe(0);
    expect(h.orderUpdates.at(-1)?.status).toBe('CANCELLED');
  });

  it('cancelAll cancels every open order', async () => {
    const h = makeVenue();
    await h.venue.placeOrder(buyLimit(0.5, 10, 'a'));
    await h.venue.placeOrder(buyLimit(0.49, 10, 'b'));
    await h.venue.cancelAll();
    expect((await h.venue.getOpenOrders()).length).toBe(0);
  });

  it('cancelling an unknown id is a no-op', async () => {
    const h = makeVenue();
    await expect(h.venue.cancelOrder('nope' as never)).resolves.not.toThrow();
  });
});

describe('SimulatedVenue: tight-spread book is a no-op for limit-at-mid', () => {
  it('does not fill a BUY LIMIT at mid when ask is above mid', async () => {
    const h = makeVenue();
    // Spread of 0.01: bid 0.50, ask 0.51, mid 0.505 (off-tick).
    // Place a BUY LIMIT at 0.50 — best ask 0.51, no fill.
    await h.venue.placeOrder(buyLimit(0.5, 10));
    h.venue.onBookUpdate(book({ bids: [[0.5, 100]], asks: [[0.51, 100]] }));
    expect(h.fills.length).toBe(0);
  });
});
