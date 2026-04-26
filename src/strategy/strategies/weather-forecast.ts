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
import type { WeatherForecastSource } from '../../forecasts/weather/open-meteo.js';
import { probabilityYes } from '../../forecasts/weather/forecast-prob.js';

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
}

export const DEFAULT_WEATHER_PARAMS: WeatherForecastParams = {
  minEdge: 0.05,
  orderUsd: 20,
  maxOrderSize: 200,
  maxYesPrice: 0.97,
  minYesPrice: 0.03,
  perMarketCooldownMs: 10 * 60_000,
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
        void this.forecasts
          .forecast(forecastQuery)
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

    if (modelYes - marketYesAsk >= this.params.minEdge) {
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
    } else if (marketYesBid - modelYes >= this.params.minEdge) {
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
  ): WeatherQuestion | null {
    const cached = this.parsed.get(marketId);
    if (cached) return cached.question;
    const question = parseWeatherQuestion(title, refDate);
    this.parsed.set(marketId, { question });
    return question;
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
