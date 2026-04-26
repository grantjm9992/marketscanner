import type { Logger } from '../../logging/logger.js';

export type Fetcher = (url: string) => Promise<Response>;

/**
 * One day of forecast data for a single location.
 */
export interface DailyForecast {
  /** YYYY-MM-DD (UTC). */
  readonly date: string;
  /** Predicted highest temperature in Celsius. */
  readonly highC: number;
  /** Predicted lowest temperature in Celsius. */
  readonly lowC: number;
}

export interface ForecastQuery {
  readonly latitude: number;
  readonly longitude: number;
  /** UTC date the forecast should cover. */
  readonly date: string;
}

export interface WeatherForecastSource {
  /**
   * Fetch the forecast for a (lat, lon, date), populating the cache.
   * Returns null if the date isn't in the available forecast horizon.
   */
  forecast(q: ForecastQuery): Promise<DailyForecast | null>;
  /**
   * Synchronous cache lookup. Returns null on miss; never triggers a
   * network call. Strategies that run from sync `onBookUpdate` use this
   * to read the cache while issuing async `forecast()` calls in the
   * background to populate it.
   */
  forecastCached(q: ForecastQuery): DailyForecast | null;
}

export interface OpenMeteoOptions {
  /** Default https://api.open-meteo.com/v1/forecast — override for tests. */
  readonly host?: string;
  /** Default 16 — OpenMeteo's free tier supports 16 days. */
  readonly forecastDays?: number;
  /** TTL for the in-memory cache. Default 1h. */
  readonly cacheTtlMs?: number;
  /** Injectable for tests. */
  readonly fetcher?: Fetcher;
  readonly logger: Logger;
}

interface ApiResponse {
  daily?: {
    time?: readonly string[];
    temperature_2m_max?: readonly number[];
    temperature_2m_min?: readonly number[];
  };
}

interface CacheEntry {
  readonly fetchedAt: number;
  readonly daily: ReadonlyArray<DailyForecast>;
}

/**
 * Free OpenMeteo forecast adapter. No API key, no auth, no quota at our
 * call rate. Caches per-(lat,lon) for cacheTtlMs to avoid hammering the
 * service when many markets share a city.
 */
export class OpenMeteoForecastSource implements WeatherForecastSource {
  private readonly host: string;
  private readonly forecastDays: number;
  private readonly cacheTtlMs: number;
  private readonly fetcher: Fetcher;
  private readonly logger: Logger;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: OpenMeteoOptions) {
    this.host = (opts.host ?? 'https://api.open-meteo.com/v1/forecast').replace(/\/$/, '');
    this.forecastDays = opts.forecastDays ?? 16;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60 * 60 * 1000;
    this.fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
    this.logger = opts.logger;
  }

  async forecast(q: ForecastQuery): Promise<DailyForecast | null> {
    const key = cacheKey(q.latitude, q.longitude);
    const cached = this.cache.get(key);
    const now = Date.now();
    let daily: ReadonlyArray<DailyForecast>;
    if (cached && now - cached.fetchedAt < this.cacheTtlMs) {
      daily = cached.daily;
    } else {
      daily = await this.fetchForecast(q.latitude, q.longitude);
      this.cache.set(key, { fetchedAt: now, daily });
    }
    return daily.find((d) => d.date === q.date) ?? null;
  }

  forecastCached(q: ForecastQuery): DailyForecast | null {
    const cached = this.cache.get(cacheKey(q.latitude, q.longitude));
    if (!cached) return null;
    if (Date.now() - cached.fetchedAt >= this.cacheTtlMs) return null;
    return cached.daily.find((d) => d.date === q.date) ?? null;
  }

  private async fetchForecast(
    latitude: number,
    longitude: number,
  ): Promise<ReadonlyArray<DailyForecast>> {
    const url =
      `${this.host}?latitude=${latitude}&longitude=${longitude}` +
      `&daily=temperature_2m_max,temperature_2m_min` +
      `&forecast_days=${this.forecastDays}` +
      `&timezone=auto`;
    const res = await this.fetcher(url);
    if (!res.ok) {
      throw new Error(`OpenMeteo ${res.status}: ${await safeText(res)}`);
    }
    const body = (await res.json()) as ApiResponse;
    const time = body.daily?.time ?? [];
    const max = body.daily?.temperature_2m_max ?? [];
    const min = body.daily?.temperature_2m_min ?? [];
    const out: DailyForecast[] = [];
    for (let i = 0; i < time.length; i += 1) {
      const date = time[i];
      const high = max[i];
      const low = min[i];
      if (!date || typeof high !== 'number' || typeof low !== 'number') continue;
      out.push({ date, highC: high, lowC: low });
    }
    this.logger.debug({ latitude, longitude, count: out.length }, 'open-meteo: forecast fetched');
    return out;
  }
}

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '<unreadable>';
  }
}
