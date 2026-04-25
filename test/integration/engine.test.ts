import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/persistence/db.js';
import type { Db } from '../../src/persistence/db.js';
import { MarketSnapshotRepository } from '../../src/persistence/repositories/market-snapshot.js';
import { TradeLogRepository } from '../../src/persistence/repositories/trade-log.js';
import { HistoricalFeed } from '../../src/marketdata/historical-feed.js';
import {
  SimulatedVenue,
  type MarketSpec,
} from '../../src/execution/simulated-venue.js';
import { PolymarketFeeSchedule } from '../../src/execution/fees.js';
import { DefaultRiskManager } from '../../src/risk/risk-manager.js';
import { WideSpreadMarketMaker } from '../../src/strategy/strategies/wide-spread-market-maker.js';
import { Engine, VenuePortfolioProvider } from '../../src/engine/engine.js';
import { FakeClock } from '../../src/engine/clock.js';
import { createLogger } from '../../src/logging/logger.js';
import { price, size, usd } from '../../src/domain/money.js';
import type { Market, OrderBook } from '../../src/domain/market.js';

describe('Engine integration: HistoricalFeed + SimulatedVenue + WSMM + RiskManager', () => {
  let db: Db;
  let snapRepo: MarketSnapshotRepository;
  let tradeLog: TradeLogRepository;

  const market: Market = {
    conditionId: 'm1',
    question: 'Will it rain?',
    outcomes: [{ tokenId: 't1', label: 'Yes' }],
    tickSize: price(0.01),
    minOrderSize: size(5),
    endDate: new Date('2099-01-01T00:00:00Z'),
    category: 'weather',
  };

  const spec: MarketSpec = {
    marketId: 'm1',
    tickSize: price(0.01),
    minOrderSize: size(5),
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    snapRepo = new MarketSnapshotRepository(db);
    tradeLog = new TradeLogRepository(db, 'backtest');
  });

  afterEach(() => {
    db.close();
  });

  function snap(ts: Date, bidP: number, askP: number, sz = 100): OrderBook {
    return {
      marketId: 'm1',
      tokenId: 't1',
      bids: [{ price: price(bidP), size: size(sz) }],
      asks: [{ price: price(askP), size: size(sz) }],
      timestamp: ts,
    };
  }

  it('runs end-to-end on canned snapshots and produces trade-log rows', async () => {
    // Canned sequence: wide spread -> wide spread (BUY quote stays open)
    // -> book moves so ask crosses our buy limit -> our BUY fills.
    const t0 = new Date('2026-01-01T12:00:00Z');
    snapRepo.record(snap(new Date(t0.getTime() + 0), 0.4, 0.6));
    snapRepo.record(snap(new Date(t0.getTime() + 1000), 0.4, 0.6));
    // Book crosses: ask now 0.40 — our BUY at 0.41 should fill at 0.40.
    snapRepo.record(snap(new Date(t0.getTime() + 2000), 0.39, 0.4));

    const clock = new FakeClock(new Date(t0.getTime() - 1000));
    const logger = createLogger({ level: 'silent' });

    const feed = new HistoricalFeed({
      repo: snapRepo,
      clock,
      from: t0,
      to: new Date(t0.getTime() + 60_000),
      logger,
    });

    const venue = new SimulatedVenue({
      clock,
      fees: new PolymarketFeeSchedule(),
      latencyMs: 0,
      startingCashUsd: usd(1000),
      markets: new Map([[spec.marketId, spec]]),
      logger,
      tradeLog,
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

    const strategy = new WideSpreadMarketMaker();
    const engine = new Engine({
      feed,
      venue,
      strategy,
      risk,
      portfolioProvider: new VenuePortfolioProvider(venue),
      logger,
      clock,
      markets: new Map([[market.conditionId, market]]),
    });

    // Wire feed → venue so the venue sees book updates the same time the
    // strategy does. (In production, main.ts does this wiring.)
    feed.onBookUpdate((b) => venue.onBookUpdate(b));

    await engine.start();

    // Confirm the trade log captured at least one ORDER_PLACED and one FILL.
    const events = tradeLog.recentForMarket('m1');
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('ORDER_PLACED');
    expect(eventTypes).toContain('FILL');

    // After fill we should have a position in t1.
    const positions = await venue.getPositions();
    const heldT1 = positions.find((p) => p.tokenId === 't1');
    expect(heldT1).toBeDefined();
    expect((heldT1?.size as number) ?? 0).toBeGreaterThan(0);

    await engine.stop();
  });

  it('halts on kill switch and stops dispatching new orders', async () => {
    const t0 = new Date('2026-01-01T12:00:00Z');
    snapRepo.record(snap(new Date(t0.getTime() + 0), 0.4, 0.6));
    snapRepo.record(snap(new Date(t0.getTime() + 1000), 0.4, 0.6));

    const clock = new FakeClock(new Date(t0.getTime() - 1000));
    const logger = createLogger({ level: 'silent' });

    const feed = new HistoricalFeed({
      repo: snapRepo,
      clock,
      from: t0,
      to: new Date(t0.getTime() + 60_000),
      logger,
    });
    const venue = new SimulatedVenue({
      clock,
      fees: new PolymarketFeeSchedule(),
      latencyMs: 0,
      startingCashUsd: usd(1000),
      markets: new Map([[spec.marketId, spec]]),
      logger,
      tradeLog,
    });
    const risk = new DefaultRiskManager({
      limits: {
        maxPositionSizeUsd: usd(500),
        maxTotalDeployedUsd: usd(1000),
        maxDailyLossUsd: usd(0.01),
        maxOrdersPerMinute: 60,
        perMarketCooldownMs: 0,
        maxOpenOrdersPerMarket: 4,
      },
      clock,
      logger,
    });

    risk.halt('manual');

    const engine = new Engine({
      feed,
      venue,
      strategy: new WideSpreadMarketMaker(),
      risk,
      portfolioProvider: new VenuePortfolioProvider(venue),
      logger,
      clock,
      markets: new Map([[market.conditionId, market]]),
    });
    feed.onBookUpdate((b) => venue.onBookUpdate(b));

    await engine.start();
    const events = tradeLog.recentForMarket('m1');
    expect(events.find((e) => e.eventType === 'ORDER_PLACED')).toBeUndefined();
    await engine.stop();
  });
});
