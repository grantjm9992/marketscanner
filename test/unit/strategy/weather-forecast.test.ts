import { describe, it, expect, vi } from 'vitest';
import {
  WeatherForecastStrategy,
  DEFAULT_WEATHER_PARAMS,
} from '../../../src/strategy/strategies/weather-forecast.js';
import { GeocodeCache } from '../../../src/forecasts/weather/geocode.js';
import { price, size, usd } from '../../../src/domain/money.js';
import type { Market, OrderBook } from '../../../src/domain/market.js';
import type { StrategyContext } from '../../../src/strategy/context.js';
import { FakeClock } from '../../../src/engine/clock.js';
import { createLogger } from '../../../src/logging/logger.js';
import type {
  DailyForecast,
  ForecastQuery,
  WeatherForecastSource,
} from '../../../src/forecasts/weather/open-meteo.js';

class StubForecastSource implements WeatherForecastSource {
  private readonly cache = new Map<string, DailyForecast>();
  fetchCalls = 0;

  set(query: ForecastQuery, forecast: DailyForecast): void {
    this.cache.set(this.key(query), forecast);
  }

  async forecast(query: ForecastQuery): Promise<DailyForecast | null> {
    this.fetchCalls += 1;
    return this.cache.get(this.key(query)) ?? null;
  }

  forecastCached(query: ForecastQuery): DailyForecast | null {
    return this.cache.get(this.key(query)) ?? null;
  }

  private key(q: ForecastQuery): string {
    return `${q.latitude},${q.longitude}|${q.date}`;
  }
}

function ctx(
  marketQuestion: string,
  clock: FakeClock,
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  const market: Market = {
    conditionId: 'm-weather',
    question: marketQuestion,
    outcomes: [{ tokenId: 'yes', label: 'Yes' }],
    tickSize: price(0.01),
    minOrderSize: size(5),
    endDate: new Date('2099-01-01T00:00:00Z'),
    category: 'weather',
  };
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
}): OrderBook {
  return {
    marketId: 'm-weather',
    tokenId: 'yes',
    bids: opts.bids.map(([p, s]) => ({ price: price(p), size: size(s) })),
    asks: opts.asks.map(([p, s]) => ({ price: price(p), size: size(s) })),
    timestamp: new Date(),
  };
}

describe('WeatherForecastStrategy', () => {
  it('fetches on first book update, emits no signal yet', () => {
    const src = new StubForecastSource();
    const s = new WeatherForecastStrategy(src, DEFAULT_WEATHER_PARAMS);
    const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
    const sigs = s.onBookUpdate(
      book({ bids: [[0.4, 100]], asks: [[0.6, 100]] }),
      ctx('Will the highest temperature in Seoul exceed 30°C on 2026-04-26?', clock),
    );
    expect(sigs.length).toBe(0);
    expect(src.fetchCalls).toBeGreaterThanOrEqual(1);
  });

  it('emits SELL YES when market overprices a forecast that says YES is unlikely', () => {
    const src = new StubForecastSource();
    // Forecast high 22°C, threshold 30°C → ~5σ unlikely → P(YES) ≈ 0
    src.set(
      { latitude: 37.5665, longitude: 126.978, date: '2026-04-26' },
      { date: '2026-04-26', highC: 22, lowC: 12 },
    );
    const s = new WeatherForecastStrategy(src, DEFAULT_WEATHER_PARAMS);
    const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
    const sigs = s.onBookUpdate(
      // Market YES bid at 0.30 (someone willing to buy YES at 30c).
      // We sell YES at 30c (= take their bid).
      book({ bids: [[0.3, 100]], asks: [[0.31, 100]] }),
      ctx('Will the highest temperature in Seoul exceed 30°C on 2026-04-26?', clock),
    );
    expect(sigs.length).toBe(1);
    const sig = sigs[0];
    if (sig?.kind !== 'PLACE_ORDER') throw new Error('expected PLACE_ORDER');
    expect(sig.request.side).toBe('SELL');
    expect(sig.request.limitPrice).toBe(0.3);
  });

  it('emits BUY YES when market underprices a forecast that says YES is likely', () => {
    const src = new StubForecastSource();
    // Forecast high 30°C, threshold 25°C → very likely YES
    src.set(
      { latitude: 37.5665, longitude: 126.978, date: '2026-04-26' },
      { date: '2026-04-26', highC: 30, lowC: 18 },
    );
    const s = new WeatherForecastStrategy(src, DEFAULT_WEATHER_PARAMS);
    const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
    const sigs = s.onBookUpdate(
      // Market is selling YES at 50c — way underpriced.
      book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }),
      ctx('Will the highest temperature in Seoul exceed 25°C on 2026-04-26?', clock),
    );
    expect(sigs.length).toBe(1);
    const sig = sigs[0];
    if (sig?.kind !== 'PLACE_ORDER') throw new Error('expected PLACE_ORDER');
    expect(sig.request.side).toBe('BUY');
    expect(sig.request.limitPrice).toBe(0.5);
  });

  it('does nothing when edge is below minEdge', () => {
    const src = new StubForecastSource();
    src.set(
      { latitude: 37.5665, longitude: 126.978, date: '2026-04-26' },
      { date: '2026-04-26', highC: 25, lowC: 15 }, // forecast == threshold ⇒ P ≈ 0.5
    );
    const s = new WeatherForecastStrategy(src, { ...DEFAULT_WEATHER_PARAMS, minEdge: 0.1 });
    const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
    const sigs = s.onBookUpdate(
      book({ bids: [[0.49, 100]], asks: [[0.51, 100]] }),
      ctx('Will the highest temperature in Seoul exceed 25°C on 2026-04-26?', clock),
    );
    expect(sigs.length).toBe(0);
  });

  it('skips markets whose YES price is above maxYesPrice (avoid 99c trap)', () => {
    const src = new StubForecastSource();
    src.set(
      { latitude: 37.5665, longitude: 126.978, date: '2026-04-26' },
      { date: '2026-04-26', highC: 30, lowC: 18 },
    );
    const s = new WeatherForecastStrategy(src, {
      ...DEFAULT_WEATHER_PARAMS,
      maxYesPrice: 0.97,
    });
    const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
    const sigs = s.onBookUpdate(
      book({ bids: [[0.98, 100]], asks: [[0.99, 100]] }),
      ctx('Will the highest temperature in Seoul exceed 25°C on 2026-04-26?', clock),
    );
    expect(sigs.length).toBe(0);
  });

  it('respects per-market cooldown', () => {
    const src = new StubForecastSource();
    src.set(
      { latitude: 37.5665, longitude: 126.978, date: '2026-04-26' },
      { date: '2026-04-26', highC: 22, lowC: 12 },
    );
    const s = new WeatherForecastStrategy(src, DEFAULT_WEATHER_PARAMS);
    const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
    const c = ctx('Will the highest temperature in Seoul exceed 30°C on 2026-04-26?', clock);
    const first = s.onBookUpdate(book({ bids: [[0.3, 100]], asks: [[0.31, 100]] }), c);
    expect(first.length).toBe(1);
    // Same book, immediately again — cooldown blocks.
    const second = s.onBookUpdate(book({ bids: [[0.3, 100]], asks: [[0.31, 100]] }), c);
    expect(second.length).toBe(0);
  });

  it('skips non-weather markets', () => {
    const src = new StubForecastSource();
    const s = new WeatherForecastStrategy(src, DEFAULT_WEATHER_PARAMS);
    const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
    const sigs = s.onBookUpdate(
      book({ bids: [[0.3, 100]], asks: [[0.31, 100]] }),
      ctx('Will Trump win the 2028 election?', clock),
    );
    expect(sigs.length).toBe(0);
    expect(src.fetchCalls).toBe(0);
  });

  describe('geocoding integration', () => {
    it('fires geocode prefetch for unknown city and emits no signal on first tick', async () => {
      const src = new StubForecastSource();
      const fetcher = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
      const geocodeCache = new GeocodeCache({
        logger: createLogger({ level: 'silent' }),
        fetcher,
      });
      const s = new WeatherForecastStrategy(src, DEFAULT_WEATHER_PARAMS, geocodeCache);
      const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
      const sigs = s.onBookUpdate(
        book({ bids: [[0.3, 100]], asks: [[0.31, 100]] }),
        ctx('Will the highest temperature in Kraków exceed 20°C on 2026-04-26?', clock),
      );
      expect(sigs.length).toBe(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const url = fetcher.mock.calls[0]?.[0] as string;
      expect(url).toContain('Krak');
    });

    it('emits a signal once geocoding resolves', async () => {
      const src = new StubForecastSource();
      const geocodeResponse = new Response(
        JSON.stringify({
          results: [{ name: 'Kraków', latitude: 50.0647, longitude: 19.945 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
      const fetcher = vi.fn().mockResolvedValue(geocodeResponse);
      const geocodeCache = new GeocodeCache({
        logger: createLogger({ level: 'silent' }),
        fetcher,
      });

      // Pre-populate the forecast so it's available immediately.
      src.set(
        { latitude: 50.0647, longitude: 19.945, date: '2026-04-26' },
        { date: '2026-04-26', highC: 25, lowC: 10 }, // 25°C > 20°C → likely YES
      );

      const s = new WeatherForecastStrategy(src, DEFAULT_WEATHER_PARAMS, geocodeCache);
      const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
      const b = book({ bids: [[0.1, 100]], asks: [[0.11, 100]] });
      const c = ctx('Will the highest temperature in Kraków exceed 20°C on 2026-04-26?', clock);

      // First tick — geocode request fires but hasn't resolved.
      expect(s.onBookUpdate(b, c).length).toBe(0);

      // Wait for the geocoding microtask.
      await new Promise((r) => setTimeout(r, 0));

      // Second tick — geocode resolved, question parses, forecast is hot.
      const sigs = s.onBookUpdate(b, c);
      expect(sigs.length).toBe(1);
      expect(sigs[0]?.kind).toBe('PLACE_ORDER');
    });

    it('permanently skips a market once geocoding confirms city not found', async () => {
      const src = new StubForecastSource();
      const fetcher = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const geocodeCache = new GeocodeCache({
        logger: createLogger({ level: 'silent' }),
        fetcher,
      });
      const s = new WeatherForecastStrategy(src, DEFAULT_WEATHER_PARAMS, geocodeCache);
      const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
      const b = book({ bids: [[0.3, 100]], asks: [[0.31, 100]] });
      const c = ctx('Will the highest temperature in Fictoria exceed 20°C on 2026-04-26?', clock);

      s.onBookUpdate(b, c); // fires prefetch
      await new Promise((r) => setTimeout(r, 0)); // geocode resolves as not-found

      // Second and third ticks — should not fire additional geocode requests.
      s.onBookUpdate(b, c);
      s.onBookUpdate(b, c);
      expect(fetcher).toHaveBeenCalledTimes(1); // only one geocode call ever
    });
  });

  describe('tradeDirection gates', () => {
    it('sell_only suppresses a BUY signal that would otherwise fire', () => {
      const src = new StubForecastSource();
      // Forecast 30°C, threshold 25°C → very high P(YES). Market YES
      // at 0.50 → big BUY edge in 'both' mode.
      src.set(
        { latitude: 37.5665, longitude: 126.978, date: '2026-04-26' },
        { date: '2026-04-26', highC: 30, lowC: 18 },
      );
      const s = new WeatherForecastStrategy(src, {
        ...DEFAULT_WEATHER_PARAMS,
        tradeDirection: 'sell_only',
      });
      const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
      const sigs = s.onBookUpdate(
        book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }),
        ctx('Will the highest temperature in Seoul exceed 25°C on 2026-04-26?', clock),
      );
      expect(sigs.length).toBe(0);
    });

    it('sell_only still emits SELL on overpriced YES', () => {
      const src = new StubForecastSource();
      // Forecast 22°C, threshold 30°C → P(YES) ≈ 0. Market bidding
      // 30c for YES — big SELL edge.
      src.set(
        { latitude: 37.5665, longitude: 126.978, date: '2026-04-26' },
        { date: '2026-04-26', highC: 22, lowC: 12 },
      );
      const s = new WeatherForecastStrategy(src, {
        ...DEFAULT_WEATHER_PARAMS,
        tradeDirection: 'sell_only',
      });
      const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
      const sigs = s.onBookUpdate(
        book({ bids: [[0.3, 100]], asks: [[0.31, 100]] }),
        ctx('Will the highest temperature in Seoul exceed 30°C on 2026-04-26?', clock),
      );
      expect(sigs.length).toBe(1);
      const sig = sigs[0];
      if (sig?.kind !== 'PLACE_ORDER') throw new Error('expected PLACE_ORDER');
      expect(sig.request.side).toBe('SELL');
    });

    it('buy_only suppresses a SELL signal that would otherwise fire', () => {
      const src = new StubForecastSource();
      src.set(
        { latitude: 37.5665, longitude: 126.978, date: '2026-04-26' },
        { date: '2026-04-26', highC: 22, lowC: 12 },
      );
      const s = new WeatherForecastStrategy(src, {
        ...DEFAULT_WEATHER_PARAMS,
        tradeDirection: 'buy_only',
      });
      const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
      const sigs = s.onBookUpdate(
        book({ bids: [[0.3, 100]], asks: [[0.31, 100]] }),
        ctx('Will the highest temperature in Seoul exceed 30°C on 2026-04-26?', clock),
      );
      expect(sigs.length).toBe(0);
    });

    it('buy_only still emits BUY on underpriced YES', () => {
      const src = new StubForecastSource();
      src.set(
        { latitude: 37.5665, longitude: 126.978, date: '2026-04-26' },
        { date: '2026-04-26', highC: 30, lowC: 18 },
      );
      const s = new WeatherForecastStrategy(src, {
        ...DEFAULT_WEATHER_PARAMS,
        tradeDirection: 'buy_only',
      });
      const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));
      const sigs = s.onBookUpdate(
        book({ bids: [[0.49, 100]], asks: [[0.5, 100]] }),
        ctx('Will the highest temperature in Seoul exceed 25°C on 2026-04-26?', clock),
      );
      expect(sigs.length).toBe(1);
      const sig = sigs[0];
      if (sig?.kind !== 'PLACE_ORDER') throw new Error('expected PLACE_ORDER');
      expect(sig.request.side).toBe('BUY');
    });
  });
});
