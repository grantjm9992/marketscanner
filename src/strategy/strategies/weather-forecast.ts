import { price, size } from '../../domain/money.js';
import { bestAsk, bestBid } from '../../domain/market.js';
import type { OrderBook } from '../../domain/market.js';
import type { Fill, OrderRequest } from '../../domain/order.js';
import type { Signal } from '../signal.js';
import type { Strategy } from '../strategy.js';
import type { StrategyContext } from '../context.js';
import {
  parseWeatherQuestion,
  type WeatherQuestion,
} from '../../forecasts/weather/parser.js';
import { lookupCity } from '../../forecasts/weather/cities.js';
import type { WeatherForecastSource } from '../../forecasts/weather/open-meteo.js';
import type { GeocodeCache } from '../../forecasts/weather/geocode.js';
import { probabilityYes } from '../../forecasts/weather/forecast-prob.js';

export type TradeDirection =
  /** Allow both BUY YES and SELL YES (default). */
  | 'both'
  /**
   * Only BUY YES. Use this for the maskache2-style long-shot pattern
   * where the model says YES is wildly underpriced (e.g. market 8c,
   * model 35c).
   */
  | 'buy_only'
  /**
   * Only SELL YES. Use this for the swisstony-style near-certainty
   * pattern where the market overprices YES (e.g. market 99c bid,
   * model 0.5%).
   */
  | 'sell_only';

export interface WeatherForecastParams {
  /** Minimum edge required to place a trade. 0.05 = 5¢ / 5%. */
  readonly minEdge: number;
  /** Notional USD per trade (fixed-fraction sizing). */
  readonly orderUsd: number;
  /** Hard cap on shares per trade. */
  readonly maxOrderSize: number;
  /** Don't trade markets whose YES price is above this. */
  readonly maxYesPrice: number;
  /** Don't trade markets whose YES price is below this. */
  readonly minYesPrice: number;
  /** Per-market cooldown after a trade. */
  readonly perMarketCooldownMs: number;
  /** Restrict to only one side of the trade, or allow both. */
  readonly tradeDirection: TradeDirection;
}

export const DEFAULT_WEATHER_PARAMS: WeatherForecastParams = {
  minEdge: 0.05,
  orderUsd: 20,
  maxOrderSize: 200,
  maxYesPrice: 0.97,
  minYesPrice: 0.03,
  perMarketCooldownMs: 10 * 60_000,
  tradeDirection: 'both',
};

interface ParsedCacheEntry {
  /** Null = parsed but invalid (don't retry). */
  readonly question: WeatherQuestion | null;
}

/**
 * Take a side based on a forecast-probability model.
 *
 * For each tracked market on each book update:
 *   1. Parse the market question (cached after first attempt).
 *   2. Look up the forecast for the question's (city, date) in the
 *      forecast source's cache.
 *      - On cache miss: fire an async fetch (fire-and-forget) so the
 *        next book update has data. No signal this tick.
 *      - On cache hit: compute model P(yes); if |model − market| > minEdge
 *        and price is inside [minYesPrice, maxYesPrice], take the
 *        favorable side at the touch.
 *
 * Phase 1 caveats:
 *   - Hardcoded city dictionary; markets in unsupported cities are no-ops.
 *   - Forecast horizon capped at ~7 days; longer-dated markets are skipped.
 *   - Fixed-fraction sizing (no Kelly, no edge-scaling).
 *   - Conservative stddev profile: overstating uncertainty makes the
 *     strategy stake less. Safe failure mode.
 */
export class WeatherForecastStrategy implements Strategy {
  readonly name = 'weather-forecast';
  private readonly parsed = new Map<string, ParsedCacheEntry>();
  private readonly inFlight = new Set<string>();
  private readonly lastTradeAt = new Map<string, number>();
  private nextClientId = 1;

  constructor(
    private readonly forecasts: WeatherForecastSource,
    private readonly params: WeatherForecastParams = DEFAULT_WEATHER_PARAMS,
    private readonly geocodeCache?: GeocodeCache,
  ) {}

  async onStart(_ctx: StrategyContext): Promise<void> {
    /* nothing */
  }

  async onStop(_ctx: StrategyContext): Promise<void> {
    /* nothing */
  }

  onBookUpdate(book: OrderBook, ctx: StrategyContext): readonly Signal[] {
    const question = this.getQuestion(
      ctx.market.conditionId,
      ctx.market.question,
      ctx.clock.now(),
      ctx.logger,
    );
    if (!question) return [];

    const now = ctx.clock.now();
    const last = this.lastTradeAt.get(book.marketId);
    if (last !== undefined && now.getTime() - last < this.params.perMarketCooldownMs) return [];

    const forecastQuery = {
      latitude: question.city.latitude,
      longitude: question.city.longitude,
      date: question.date,
    };
    const forecast = this.forecasts.forecastCached(forecastQuery);
    if (!forecast) {
      // Cache miss — issue a background fetch so the next book update
      // for this market has data.
      const key = `${forecastQuery.latitude},${forecastQuery.longitude}|${forecastQuery.date}`;
      if (!this.inFlight.has(key)) {
        this.inFlight.add(key);
        ctx.logger.info(
          { city: question.city.displayName, date: question.date },
          'weather-forecast: fetching forecast (cache miss)',
        );
        void this.forecasts
          .forecast(forecastQuery)
          .then(() => {
            ctx.logger.debug({ key }, 'weather-forecast: forecast fetched');
          })
          .catch((err: unknown) => {
            ctx.logger.error({ err, key }, 'weather-forecast: fetch failed');
          })
          .finally(() => {
            this.inFlight.delete(key);
          });
      }
      return [];
    }

    const result = probabilityYes(question, forecast, now);
    if (!result) return [];

    const yesAsk = bestAsk(book);
    const yesBid = bestBid(book);
    if (!yesAsk || !yesBid) return [];

    const marketYesAsk = yesAsk.price as number;
    const marketYesBid = yesBid.price as number;
    if (marketYesAsk > this.params.maxYesPrice) return [];
    if (marketYesBid < this.params.minYesPrice) return [];

    const modelYes = result.probability;
    const out: Signal[] = [];

    const allowBuy =
      this.params.tradeDirection === 'both' || this.params.tradeDirection === 'buy_only';
    const allowSell =
      this.params.tradeDirection === 'both' || this.params.tradeDirection === 'sell_only';

    if (allowBuy && modelYes - marketYesAsk >= this.params.minEdge) {
      const req = this.makeOrder(book, 'BUY', marketYesAsk);
      if (req) {
        out.push({ kind: 'PLACE_ORDER', request: req });
        this.lastTradeAt.set(book.marketId, now.getTime());
        ctx.logger.info(
          {
            modelYes,
            marketYesAsk,
            edge: modelYes - marketYesAsk,
            forecast: { mean: result.forecastC, stddev: result.stddevC, daysOut: result.daysOut },
            question: question.raw,
          },
          'weather-forecast: BUY YES (model thinks YES is underpriced)',
        );
      }
    } else if (allowSell && marketYesBid - modelYes >= this.params.minEdge) {
      const req = this.makeOrder(book, 'SELL', marketYesBid);
      if (req) {
        out.push({ kind: 'PLACE_ORDER', request: req });
        this.lastTradeAt.set(book.marketId, now.getTime());
        ctx.logger.info(
          {
            modelYes,
            marketYesBid,
            edge: marketYesBid - modelYes,
            forecast: { mean: result.forecastC, stddev: result.stddevC, daysOut: result.daysOut },
            question: question.raw,
          },
          'weather-forecast: SELL YES (model thinks YES is overpriced)',
        );
      }
    }
    return out;
  }

  onFill(_fill: Fill, _ctx: StrategyContext): void {
    /* nothing */
  }

  private getQuestion(
    marketId: string,
    title: string,
    refDate: Date,
    logger: import('../../logging/logger.js').Logger,
  ): WeatherQuestion | null {
    const cached = this.parsed.get(marketId);
    if (cached) return cached.question;

    // Track whether the resolver was called and what it returned so we
    // can distinguish format-mismatch (regex never called the resolver)
    // from city-miss (resolver called but returned null).
    let attemptedCity: string | undefined;
    let cityResolved = false;
    const resolver = (name: string): import('../../forecasts/weather/parser.js').CityCoords | null => {
      attemptedCity = name;
      // GeocodeCache.get already checks the hardcoded dict first; when no
      // cache is injected, fall back to the hardcoded dict directly.
      const coords = this.geocodeCache ? this.geocodeCache.get(name) : lookupCity(name);
      cityResolved = coords !== null;
      return coords;
    };

    const question = parseWeatherQuestion(title, refDate, resolver);

    if (question !== null) {
      this.parsed.set(marketId, { question });
      logger.info(
        {
          marketId,
          city: question.city.displayName,
          variable: question.variable,
          comparison: question.comparison,
          thresholdC: question.thresholdC,
          date: question.date,
        },
        'weather-forecast: parsed market',
      );
      return question;
    }

    // Parsing failed. Determine whether it's permanent or retriable.

    if (cityResolved) {
      // The city was found but something else in the question didn't parse
      // (e.g. unrecognisable date format). Permanent skip.
      this.parsed.set(marketId, { question: null });
      logger.debug({ marketId, title }, 'weather-forecast: title did not match weather pattern; skipping');
      return null;
    }

    if (!this.geocodeCache || attemptedCity === undefined) {
      // No geocoder available, or the regex didn't even extract a city
      // name (format mismatch). Permanent skip.
      this.parsed.set(marketId, { question: null });
      logger.debug({ marketId, title }, 'weather-forecast: title did not match weather pattern; skipping');
      return null;
    }

    // The regex extracted a city name but it isn't in our dict yet.
    const cityName = attemptedCity;
    if (this.geocodeCache.isKnownMissing(cityName)) {
      this.parsed.set(marketId, { question: null });
      logger.debug({ marketId, cityName }, 'weather-forecast: city not found via geocoding; skipping');
      return null;
    }

    // City is unknown but geocodable — fire a background request and
    // retry on the next book update (don't cache null yet).
    if (!this.geocodeCache.isPending(cityName)) {
      this.geocodeCache.prefetch(cityName);
      logger.info({ marketId, cityName }, 'weather-forecast: unknown city; geocoding in background');
    }
    return null;
  }

  private makeOrder(book: OrderBook, side: 'BUY' | 'SELL', touchPrice: number): OrderRequest | null {
    const desiredShares = this.params.orderUsd / Math.max(touchPrice, 1e-6);
    const shares = Math.min(desiredShares, this.params.maxOrderSize);
    if (shares <= 0) return null;
    return {
      marketId: book.marketId,
      tokenId: book.tokenId,
      side,
      type: 'LIMIT',
      size: size(shares),
      limitPrice: price(touchPrice),
      clientOrderId: `wf-${this.nextClientId++}`,
    };
  }
}
