import { describe, it, expect, vi } from 'vitest';
import { Engine, VenuePortfolioProvider } from '../../../src/engine/engine.js';
import { SimulatedVenue } from '../../../src/execution/simulated-venue.js';
import { PolymarketFeeSchedule } from '../../../src/execution/fees.js';
import { DefaultRiskManager } from '../../../src/risk/risk-manager.js';
import { FakeClock } from '../../../src/engine/clock.js';
import { createLogger } from '../../../src/logging/logger.js';
import { price, size, usd } from '../../../src/domain/money.js';
import type { Market, OrderBook } from '../../../src/domain/market.js';
import type { MarketDataFeed } from '../../../src/marketdata/feed.js';
import type { Strategy } from '../../../src/strategy/strategy.js';

const logger = createLogger({ level: 'silent' });

function market(id: string): Market {
  return {
    conditionId: id,
    question: `Q ${id}`,
    outcomes: [{ tokenId: `t-${id}`, label: 'Yes' }],
    tickSize: price(0.01),
    minOrderSize: size(5),
    endDate: new Date('2099-01-01'),
    category: 'weather',
  };
}

function fakeFeed(): MarketDataFeed & {
  subscribed: Set<string>;
  unsubscribed: string[];
} {
  const subscribed = new Set<string>();
  const unsubscribed: string[] = [];
  return {
    subscribed,
    unsubscribed,
    subscribe: vi.fn(async (ids: readonly string[]) => {
      for (const id of ids) subscribed.add(id);
    }),
    unsubscribe: vi.fn(async (ids: readonly string[]) => {
      for (const id of ids) {
        subscribed.delete(id);
        unsubscribed.push(id);
      }
    }),
    onBookUpdate: vi.fn(),
    onError: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

const stubStrategy: Strategy = {
  name: 'noop',
  onBookUpdate: () => [],
  onFill: () => {},
  onStart: async () => {},
  onStop: async () => {},
};

function makeEngine(initialMarketIds: readonly string[] = []) {
  const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
  const feed = fakeFeed();
  const venue = new SimulatedVenue({
    clock,
    fees: new PolymarketFeeSchedule(),
    latencyMs: 0,
    startingCashUsd: usd(1000),
    markets: new Map(initialMarketIds.map((id) => [id, { marketId: id, tickSize: price(0.01), minOrderSize: size(5) }])),
    logger,
  });
  const risk = new DefaultRiskManager({
    limits: {
      maxPositionSizeUsd: usd(500),
      maxTotalDeployedUsd: usd(1000),
      maxDailyLossUsd: usd(100),
      maxOrdersPerMinute: 60,
      perMarketCooldownMs: 0,
      maxOpenOrdersPerMarket: 4,
    },
    clock,
    logger,
  });
  const initial = new Map(initialMarketIds.map((id) => [id, market(id)]));
  const engine = new Engine({
    feed,
    venue,
    strategy: stubStrategy,
    risk,
    portfolioProvider: new VenuePortfolioProvider(venue),
    logger,
    clock,
    markets: initial,
    heartbeatIntervalMs: 0, // disable heartbeat in tests
  });
  return { engine, feed, venue, clock };
}

describe('Engine.addMarket / removeMarket', () => {
  it('addMarket subscribes the feed and registers with the venue', async () => {
    const { engine, feed, venue } = makeEngine([]);
    await engine.addMarket(market('0xa'));
    expect(feed.subscribed.has('0xa')).toBe(true);
    expect(engine.trackedMarketIds()).toContain('0xa');

    // SimulatedVenue should now accept orders for this market.
    const order = await venue.placeOrder({
      marketId: '0xa',
      tokenId: 't-0xa',
      side: 'BUY',
      type: 'LIMIT',
      size: size(10),
      limitPrice: price(0.5),
      clientOrderId: 'c1',
    });
    expect(order.status).not.toBe('REJECTED');
  });

  it('removeMarket unsubscribes the feed and cancels open orders', async () => {
    const { engine, feed, venue } = makeEngine(['0xa']);
    // Wait for the event handlers to be wired.
    await engine.start();

    // Place a quote on the soon-to-be-removed market.
    await venue.placeOrder({
      marketId: '0xa',
      tokenId: 't-0xa',
      side: 'BUY',
      type: 'LIMIT',
      size: size(10),
      limitPrice: price(0.5),
      clientOrderId: 'c1',
    });
    expect((await venue.getOpenOrders()).length).toBe(1);

    await engine.removeMarket('0xa');
    expect(feed.unsubscribed).toContain('0xa');
    expect(engine.trackedMarketIds()).not.toContain('0xa');
    expect((await venue.getOpenOrders()).length).toBe(0);

    await engine.stop();
  });

  it('removeMarket on an unknown id is a no-op', async () => {
    const { engine } = makeEngine(['0xa']);
    await engine.removeMarket('0xnope');
    expect(engine.trackedMarketIds()).toEqual(['0xa']);
  });

  it('addMarket is idempotent (re-add updates metadata, no duplicate subscribes)', async () => {
    const { engine, feed } = makeEngine([]);
    await engine.addMarket(market('0xa'));
    await engine.addMarket(market('0xa'));
    expect(engine.trackedMarketIds()).toEqual(['0xa']);
    // subscribe was called once for this market.
    expect((feed.subscribe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
