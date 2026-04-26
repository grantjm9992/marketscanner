import type { Fetcher } from './open-meteo.js';
import type { Logger } from '../../logging/logger.js';
import type { CityCoords } from './cities.js';
import { lookupCity } from './cities.js';

interface GeoApiResult {
  results?: ReadonlyArray<{ name: string; latitude: number; longitude: number }>;
}

export interface GeocodeOptions {
  /** Default: https://geocoding-api.open-meteo.com/v1 */
  readonly host?: string;
  /** Injectable for tests. */
  readonly fetcher?: Fetcher;
  readonly logger: Logger;
}

/**
 * In-memory geocoding cache backed by the Open-Meteo Geocoding API
 * (free, no API key). Extends the hardcoded city dictionary so the
 * weather strategy can handle any city name that appears in Polymarket
 * market titles.
 *
 * Follows the same sync-read / async-prefetch pattern as
 * OpenMeteoForecastSource:
 *   - get()      → sync, never blocks
 *   - prefetch() → fire-and-forget; result lands in cache for next get()
 */
export class GeocodeCache {
  private readonly resolved = new Map<string, CityCoords | null>();
  private readonly pending = new Set<string>();
  private readonly host: string;
  private readonly fetcher: Fetcher;
  private readonly logger: Logger;

  constructor(opts: GeocodeOptions) {
    this.host = (opts.host ?? 'https://geocoding-api.open-meteo.com/v1').replace(/\/$/, '');
    this.fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
    this.logger = opts.logger;
  }

  /**
   * Synchronous lookup. Checks the hardcoded dict first, then the
   * runtime cache. Returns null when the city hasn't been resolved yet
   * or was confirmed not found.
   */
  get(name: string): CityCoords | null {
    const hardcoded = lookupCity(name);
    if (hardcoded) return hardcoded;
    return this.resolved.get(normKey(name)) ?? null;
  }

  /** True if geocoding was attempted and the API returned no results. */
  isKnownMissing(name: string): boolean {
    const key = normKey(name);
    return this.resolved.has(key) && this.resolved.get(key) === null;
  }

  /** True while a geocoding request is in flight for this city. */
  isPending(name: string): boolean {
    return this.pending.has(normKey(name));
  }

  /**
   * Fire an async geocoding request for `name`. No-op when the city is
   * already in the hardcoded dict, already resolved, or currently in
   * flight. On success, the result is stored and the next call to get()
   * will find it.
   */
  prefetch(name: string): void {
    const key = normKey(name);
    if (lookupCity(name) || this.resolved.has(key) || this.pending.has(key)) return;
    this.pending.add(key);
    const url =
      `${this.host}/search` +
      `?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
    void this.fetcher(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`geocode HTTP ${res.status}`);
        const body = (await res.json()) as GeoApiResult;
        const hit = body.results?.[0];
        if (!hit) {
          this.resolved.set(key, null);
          this.logger.debug({ city: name }, 'geocode: city not found via API');
        } else {
          const coords: CityCoords = {
            latitude: hit.latitude,
            longitude: hit.longitude,
            displayName: hit.name,
          };
          this.resolved.set(key, coords);
          this.logger.info(
            { city: name, lat: coords.latitude, lon: coords.longitude },
            'geocode: city resolved',
          );
        }
      })
      .catch((err: unknown) => {
        this.logger.error({ err, city: name }, 'geocode: request failed');
      })
      .finally(() => {
        this.pending.delete(key);
      });
  }
}

function normKey(name: string): string {
  return name.toLowerCase().trim();
}
