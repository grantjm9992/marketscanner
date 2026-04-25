import { describe, it, expect } from 'vitest';
import {
  SmartMoneyFollower,
  DEFAULT_SMART_MONEY_PARAMS,
} from '../../../src/strategy/strategies/smart-money-follower.js';
import { price, size, usd } from '../../../src/domain/money.js';
import type { Market, OrderBook } from '../../../src/domain/market.js';
import type { StrategyContext } from '../../../src/strategy/context.js';
import type { WalletTrade } from '../../../src/marketdata/wallet-trade-feed.js';
import { FakeClock } from '../../../src/engine/clock.js';
import { createLogger } from '../../../src/logging/logger.js';

const market: Market = {
  conditionId: 'm1',
  question: '?',
  outcomes: [{ tokenId: 't1', label: 'Yes' }],
  tickSize: price(0.01),
  minOrderSize: size(5),
  endDate: new Date('2099-01-01T00:00:00Z'),
  category: 'sports',
};

function ctx(clock: FakeClock, overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    market,
    portfolio: { cashUsd: usd(1000), positions: [] },
    openOrders: [],
    clock,
    logger: createLogger({ level: 'silent' }),
    ...overrides,
  };
}

function book(opts: {
  bids: ReadonlyArray<readonly [number, number]>;
  asks: ReadonlyArray<readonly [number, number]>;
  ts?: Date;
}): OrderBook {
  return {
    marketId: 'm1',
    tokenId: 't1',
    bids: opts.bids.map(([p, s]) => ({ price: price(p), size: size(s) })),
    asks: opts.asks.map(([p, s]) => ({ price: price(p), size: size(s) })),
    timestamp: opts.ts ?? new Date(),
  };
}

function trade(overrides: Partial<WalletTrade> = {}): WalletTrade {
  return {
    walletAddress: '0xsmart',
    marketId: 'm1',
    tokenId: 't1',
    side: 'BUY',
    price: price(0.5),
    size: size(1000), // notional 500 USD by default
    timestamp: new Date('2026-01-01T12:00:00Z'),
    tradeId: '0xtx',
    ...overrides,
  };
}

describe('SmartMoneyFollower', () => {
  it('emits a copy signal on the next book update after a fresh source trade', () => {
    const s = new SmartMoneyFollower(DEFAULT_SMART_MONEY_PARAMS);
    const clock = new FakeClock(new Date('2026-01-01T12:00:00Z'));

    expect(s.onWalletTrade(trade(), ctx(clock))).toEqual([]);

    clock.advance(2_000);
    const sigs = s.onBookUpdate(
      book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }),
      ctx(clock),
    );
    expect(sigs.length).toBe(1);
    const sig = sigs[0];
    if (sig?.kind !== 'PLACE_ORDER') throw new Error('expected PLACE_ORDER');
    expect(sig.request.side).toBe('BUY');
    expect(sig.request.type).toBe('LIMIT'); // taker_limit_at_touch default
    expect(sig.request.limitPrice).toBe(0.5); // ask
  });

  it('skips source trades below minSourceNotionalUsd', () => {
    const s = new SmartMoneyFollower({ ...DEFAULT_SMART_MONEY_PARAMS, minSourceNotionalUsd: 200 });
    const clock = new FakeClock(new Date('2026-01-01T12:00:00Z'));
    // 10 shares * $0.5 = $5 notional, below threshold
    s.onWalletTrade(trade({ size: size(10) }), ctx(clock));
    const sigs = s.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }), ctx(clock));
    expect(sigs.length).toBe(0);
  });

  it('skips stale signals older than maxAgeMs', () => {
    const s = new SmartMoneyFollower({ ...DEFAULT_SMART_MONEY_PARAMS, maxAgeMs: 5_000 });
    const clock = new FakeClock(new Date('2026-01-01T12:00:00Z'));
    s.onWalletTrade(trade(), ctx(clock));
    // Advance past maxAgeMs before the next book update arrives
    clock.advance(10_000);
    const sigs = s.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }), ctx(clock));
    expect(sigs.length).toBe(0);
  });

  it('skips when book has drifted more than maxPriceDriftCents', () => {
    const s = new SmartMoneyFollower({ ...DEFAULT_SMART_MONEY_PARAMS, maxPriceDriftCents: 0.03 });
    const clock = new FakeClock(new Date('2026-01-01T12:00:00Z'));
    // Source at 0.50, but ask is now 0.60 (drift 0.10 > 0.03)
    s.onWalletTrade(trade({ price: price(0.5) }), ctx(clock));
    const sigs = s.onBookUpdate(book({ bids: [[0.59, 100]], asks: [[0.6, 100]] }), ctx(clock));
    expect(sigs.length).toBe(0);
  });

  it('respects per-(wallet,market) cooldown', () => {
    const s = new SmartMoneyFollower({
      ...DEFAULT_SMART_MONEY_PARAMS,
      perMarketCooldownMs: 60_000,
    });
    const clock = new FakeClock(new Date('2026-01-01T12:00:00Z'));

    // First copy succeeds
    s.onWalletTrade(trade({ tradeId: '0xa' }), ctx(clock));
    expect(s.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }), ctx(clock)).length).toBe(1);

    // Second trade from same wallet on same market within cooldown — skipped
    clock.advance(10_000);
    s.onWalletTrade(trade({ tradeId: '0xb', timestamp: clock.now() }), ctx(clock));
    expect(s.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }), ctx(clock)).length).toBe(0);

    // After cooldown elapses, copies again
    clock.advance(60_001);
    s.onWalletTrade(trade({ tradeId: '0xc', timestamp: clock.now() }), ctx(clock));
    expect(s.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }), ctx(clock)).length).toBe(1);
  });

  it('mirrors the side of the source trade', () => {
    const s = new SmartMoneyFollower(DEFAULT_SMART_MONEY_PARAMS);
    const clock = new FakeClock(new Date('2026-01-01T12:00:00Z'));
    // SELL side — drift gate uses the bid side
    s.onWalletTrade(trade({ side: 'SELL', price: price(0.5) }), ctx(clock));
    const sigs = s.onBookUpdate(book({ bids: [[0.5, 100]], asks: [[0.51, 100]] }), ctx(clock));
    expect(sigs.length).toBe(1);
    const sig = sigs[0];
    if (sig?.kind !== 'PLACE_ORDER') throw new Error('expected PLACE_ORDER');
    expect(sig.request.side).toBe('SELL');
    expect(sig.request.limitPrice).toBe(0.5); // bid
  });

  it('emits MARKET orders in taker_market mode', () => {
    const s = new SmartMoneyFollower({
      ...DEFAULT_SMART_MONEY_PARAMS,
      executionMode: 'taker_market',
    });
    const clock = new FakeClock(new Date('2026-01-01T12:00:00Z'));
    s.onWalletTrade(trade(), ctx(clock));
    const sigs = s.onBookUpdate(book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }), ctx(clock));
    const sig = sigs[0];
    if (sig?.kind !== 'PLACE_ORDER') throw new Error('expected PLACE_ORDER');
    expect(sig.request.type).toBe('MARKET');
    expect(sig.request.limitPrice).toBeUndefined();
  });
});
