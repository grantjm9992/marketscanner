import { describe, it, expect } from 'vitest';
import {
  OpenMeteoForecastSource,
  type Fetcher,
} from '../../../../src/forecasts/weather/open-meteo.js';
import { createLogger } from '../../../../src/logging/logger.js';

const logger = createLogger({ level: 'silent' });

function jsonFetcher(payload: unknown): Fetcher {
  return async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

const SAMPLE = {
  daily: {
    time: ['2026-04-26', '2026-04-27', '2026-04-28'],
    temperature_2m_max: [22.5, 23.1, 19.8],
    temperature_2m_min: [11.0, 12.4, 9.5],
  },
};

describe('OpenMeteoForecastSource', () => {
  it('returns the forecast for the requested date', async () => {
    const src = new OpenMeteoForecastSource({ fetcher: jsonFetcher(SAMPLE), logger });
    const f = await src.forecast({ latitude: 37.5, longitude: 127, date: '2026-04-27' });
    expect(f?.highC).toBeCloseTo(23.1);
    expect(f?.lowC).toBeCloseTo(12.4);
  });

  it('returns null for dates outside the forecast horizon', async () => {
    const src = new OpenMeteoForecastSource({ fetcher: jsonFetcher(SAMPLE), logger });
    const f = await src.forecast({ latitude: 37.5, longitude: 127, date: '2030-01-01' });
    expect(f).toBeNull();
  });

  it('caches per-(lat,lon) within ttl', async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    };
    const src = new OpenMeteoForecastSource({ fetcher, logger, cacheTtlMs: 60_000 });
    await src.forecast({ latitude: 37.5, longitude: 127, date: '2026-04-26' });
    await src.forecast({ latitude: 37.5, longitude: 127, date: '2026-04-27' });
    await src.forecast({ latitude: 37.5, longitude: 127, date: '2026-04-28' });
    expect(calls).toBe(1);
  });

  it('forecastCached returns null on miss and the value on hit', async () => {
    const src = new OpenMeteoForecastSource({ fetcher: jsonFetcher(SAMPLE), logger });
    expect(
      src.forecastCached({ latitude: 37.5, longitude: 127, date: '2026-04-26' }),
    ).toBeNull();
    await src.forecast({ latitude: 37.5, longitude: 127, date: '2026-04-26' });
    const cached = src.forecastCached({
      latitude: 37.5,
      longitude: 127,
      date: '2026-04-26',
    });
    expect(cached?.highC).toBeCloseTo(22.5);
  });

  it('throws on non-OK responses', async () => {
    const fetcher: Fetcher = async () => new Response('boom', { status: 500 });
    const src = new OpenMeteoForecastSource({ fetcher, logger });
    await expect(
      src.forecast({ latitude: 0, longitude: 0, date: '2026-04-26' }),
    ).rejects.toThrow(/OpenMeteo 500/);
  });
});
