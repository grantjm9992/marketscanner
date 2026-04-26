import { describe, it, expect } from 'vitest';
import {
  RewardedMarketMaker,
  DEFAULT_REWARDED_PARAMS,
} from '../../../src/strategy/strategies/rewarded-market-maker.js';
import { price, size, usd } from '../../../src/domain/money.js';
import type { Market, MarketRewards, OrderBook } from '../../../src/domain/market.js';
import type { StrategyContext } from '../../../src/strategy/context.js';
import { FakeClock } from '../../../src/engine/clock.js';
import { createLogger } from '../../../src/logging/logger.js';

const rewards: MarketRewards = {
  dailyRateUsd: 1,
  maxSpread: price(0.035), // 3.5¢
  minSize: size(20),
};

const market: Market = {
  conditionId: 'm1',
  question: '?',
  outcomes: [{ tokenId: 't1', label: 'Yes' }],
  tickSize: price(0.01),
  minOrderSize: size(5),
  endDate: new Date('2099-01-01T00:00:00Z'),
  category: 'sports',
  rewards,
};

function ctx(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    market,
    portfolio: {
      cashUsd: usd(1000),
      positions: [
        {
          marketId: 'm1',
          tokenId: 't1',
          size: size(50),
          avgEntryPrice: price(0.5),
          realizedPnlUsd: usd(0),
        },
      ],
    },
    openOrders: [],
    clock: new FakeClock(new Date('2026-01-01T12:00:00Z')),
    logger: createLogger({ level: 'silent' }),
    ...overrides,
  };
}

function book(opts: {
  bids: ReadonlyArray<readonly [number, number]>;
  asks: ReadonlyArray<readonly [number, number]>;
}): OrderBook {
  return {
    marketId: 'm1',
    tokenId: 't1',
    bids: opts.bids.map(([p, s]) => ({ price: price(p), size: size(s) })),
    asks: opts.asks.map(([p, s]) => ({ price: price(p), size: size(s) })),
    timestamp: new Date(),
  };
}

describe('RewardedMarketMaker', () => {
  it('quotes inside the rewards band on a wide-spread book', () => {
    const s = new RewardedMarketMaker(DEFAULT_REWARDED_PARAMS);
    // Mid 0.50; rewardsMaxSpread 3.5¢; safety 0.5¢; effective band 3¢.
    // Bid 0.30, Ask 0.70 — both touches are way outside the band, so
    // we should quote at mid - band = 0.47 BUY and mid + band = 0.53 SELL.
    const sigs = s.onBookUpdate(book({ bids: [[0.3, 100]], asks: [[0.7, 100]] }), ctx());
    const places = sigs.filter((x) => x.kind === 'PLACE_ORDER');
    expect(places.length).toBe(2);
    const buy = places.find((x) => x.kind === 'PLACE_ORDER' && x.request.side === 'BUY');
    const sell = places.find((x) => x.kind === 'PLACE_ORDER' && x.request.side === 'SELL');
    expect(buy?.kind === 'PLACE_ORDER' && buy.request.limitPrice).toBeCloseTo(0.47);
    expect(sell?.kind === 'PLACE_ORDER' && sell.request.limitPrice).toBeCloseTo(0.53);
  });

  it('hugs the touch when the book is already tight enough', () => {
    const s = new RewardedMarketMaker(DEFAULT_REWARDED_PARAMS);
    // Mid 0.50; bid 0.49, ask 0.51. bestBid+tick = 0.50 = mid, which
    // is inside the band — but it would cross the SELL at 0.50 too.
    // Strategy should skip both rather than self-cross.
    const sigs = s.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }), ctx());
    expect(sigs.filter((x) => x.kind === 'PLACE_ORDER').length).toBe(0);
  });

  it('uses rewardsMinSize as the floor on quote size', () => {
    const s = new RewardedMarketMaker({ ...DEFAULT_REWARDED_PARAMS, fallbackQuoteSize: 5 });
    const sigs = s.onBookUpdate(book({ bids: [[0.3, 100]], asks: [[0.7, 100]] }), ctx());
    for (const sig of sigs) {
      if (sig.kind === 'PLACE_ORDER') {
        expect(sig.request.size).toBe(20); // rewards.minSize, not fallback 5
      }
    }
  });

  it('does nothing on markets without rewards info', () => {
    const s = new RewardedMarketMaker(DEFAULT_REWARDED_PARAMS);
    const { rewards: _r, ...rest } = market;
    const noRewardsMarket: Market = rest;
    const sigs = s.onBookUpdate(
      book({ bids: [[0.3, 100]], asks: [[0.7, 100]] }),
      ctx({ market: noRewardsMarket }),
    );
    expect(sigs.filter((x) => x.kind === 'PLACE_ORDER').length).toBe(0);
  });

  it('cancels quotes when market has < minTimeToEndMs to resolve', () => {
    const s = new RewardedMarketMaker(DEFAULT_REWARDED_PARAMS);
    // Make the market end 30 minutes away (well below 24h default).
    const closing: Market = {
      ...market,
      endDate: new Date(new Date('2026-01-01T12:00:00Z').getTime() + 30 * 60_000),
    };
    const sigs = s.onBookUpdate(
      book({ bids: [[0.3, 100]], asks: [[0.7, 100]] }),
      ctx({ market: closing }),
    );
    expect(sigs.filter((x) => x.kind === 'PLACE_ORDER').length).toBe(0);
  });

  it('skips when rewards band collapses to zero (quotes would cross)', () => {
    const s = new RewardedMarketMaker(DEFAULT_REWARDED_PARAMS);
    // Mid 0.50; book very tight. After clamping to mid ± band the
    // BUY/SELL would both land near mid and cross.
    const tightRewards: MarketRewards = {
      dailyRateUsd: 1,
      maxSpread: price(0.005),
      minSize: size(20),
    };
    const sigs = s.onBookUpdate(
      book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }),
      ctx({ market: { ...market, rewards: tightRewards } }),
    );
    expect(sigs.filter((x) => x.kind === 'PLACE_ORDER').length).toBe(0);
  });
});
