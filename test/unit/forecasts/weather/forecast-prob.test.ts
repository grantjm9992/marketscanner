import { describe, it, expect } from 'vitest';
import {
  probabilityYes,
  normalCDF,
} from '../../../../src/forecasts/weather/forecast-prob.js';
import type { WeatherQuestion } from '../../../../src/forecasts/weather/parser.js';
import type { DailyForecast } from '../../../../src/forecasts/weather/open-meteo.js';

function q(overrides: Partial<WeatherQuestion> = {}): WeatherQuestion {
  return {
    city: { latitude: 0, longitude: 0, displayName: 'Test' },
    variable: 'high',
    comparison: 'gte',
    thresholdC: 25,
    date: '2026-04-26',
    raw: { value: 25, unit: 'C', cityName: 'Test' },
    ...overrides,
  };
}

const NOW = new Date('2026-04-25T00:00:00Z');

describe('normalCDF', () => {
  it('matches known values within approximation error', () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 4);
    expect(normalCDF(1)).toBeCloseTo(0.8413, 3);
    expect(normalCDF(-1)).toBeCloseTo(0.1587, 3);
    expect(normalCDF(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCDF(2.5)).toBeCloseTo(0.9938, 3);
  });
});

describe('probabilityYes', () => {
  const forecast: DailyForecast = { date: '2026-04-26', highC: 22, lowC: 12 };

  it('forecast well below threshold → low YES probability for "high >= T"', () => {
    // Forecast 22°C, threshold 30°C, 1 day out (stddev ~1.5).
    const r = probabilityYes(q({ thresholdC: 30 }), forecast, NOW);
    expect(r).not.toBeNull();
    expect(r!.probability).toBeLessThan(0.001); // ~5σ away
  });

  it('forecast at threshold → ~50% YES probability', () => {
    const r = probabilityYes(q({ thresholdC: 22 }), forecast, NOW);
    expect(r!.probability).toBeCloseTo(0.5, 2);
  });

  it('forecast well above threshold → high YES probability for "high >= T"', () => {
    const r = probabilityYes(q({ thresholdC: 15 }), forecast, NOW);
    expect(r!.probability).toBeGreaterThan(0.999);
  });

  it('"low <= T" comparison flips direction', () => {
    // Forecast low 12°C, threshold 5°C — very unlikely to fall below.
    const r = probabilityYes(
      q({ variable: 'low', comparison: 'lte', thresholdC: 5 }),
      forecast,
      NOW,
    );
    expect(r!.probability).toBeLessThan(0.001);
  });

  it('returns null when date is past', () => {
    const r = probabilityYes(q({ date: '2026-04-20' }), forecast, NOW);
    expect(r).toBeNull();
  });

  it('returns null when date is beyond max forecast horizon', () => {
    const r = probabilityYes(q({ date: '2026-05-15' }), forecast, NOW);
    expect(r).toBeNull();
  });

  it('further-out forecasts have higher stddev (so more uncertainty)', () => {
    const oneDayOut = probabilityYes(
      q({ thresholdC: 25, date: '2026-04-26' }),
      forecast,
      NOW,
    );
    const sixDaysOut = probabilityYes(
      q({ thresholdC: 25, date: '2026-05-01' }),
      { date: '2026-05-01', highC: 22, lowC: 12 },
      NOW,
    );
    expect(sixDaysOut!.stddevC).toBeGreaterThan(oneDayOut!.stddevC);
    // Same forecast mean and threshold, but wider stddev ⇒ probability
    // is closer to 0.5.
    expect(Math.abs(sixDaysOut!.probability - 0.5)).toBeLessThan(
      Math.abs(oneDayOut!.probability - 0.5),
    );
  });
});
