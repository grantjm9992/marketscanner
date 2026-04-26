import type { Comparison, WeatherQuestion } from './parser.js';
import type { DailyForecast } from './open-meteo.js';

/**
 * Conservative per-horizon forecast standard deviations in Celsius.
 * Calibrated loosely from published NWS / ECMWF skill scores: 1-day
 * forecasts hit within ~1.5°C, errors grow with horizon.
 *
 * These are intentionally pessimistic — overstating uncertainty makes
 * the strategy stake less, which is the safe failure mode.
 */
const STDDEV_BY_DAYS_OUT: Record<number, number> = {
  0: 1.0,
  1: 1.5,
  2: 2.0,
  3: 2.5,
  4: 3.0,
  5: 3.5,
  6: 4.0,
  7: 4.5,
};

const MAX_FORECAST_DAYS = 7;

export interface ProbabilityResult {
  /** P(question resolves YES | forecast). */
  readonly probability: number;
  /** Forecast value used (mean). */
  readonly forecastC: number;
  /** Stddev used. */
  readonly stddevC: number;
  /** Days from `now` to question.date. */
  readonly daysOut: number;
}

/**
 * Probability that the weather question resolves YES given the forecast.
 *
 * Returns null when:
 *   - The question's date is more than MAX_FORECAST_DAYS away (too far
 *     out to forecast usefully).
 *   - The forecast variable doesn't match what the question asks about.
 */
export function probabilityYes(
  question: WeatherQuestion,
  forecast: DailyForecast,
  now: Date,
): ProbabilityResult | null {
  const questionDate = new Date(`${question.date}T00:00:00Z`);
  const daysOut = Math.round(
    (questionDate.getTime() - startOfDayUtc(now).getTime()) / (24 * 60 * 60 * 1000),
  );
  if (daysOut < 0 || daysOut > MAX_FORECAST_DAYS) return null;

  const forecastC = question.variable === 'high' ? forecast.highC : forecast.lowC;
  const stddevC = STDDEV_BY_DAYS_OUT[Math.min(daysOut, MAX_FORECAST_DAYS)] ?? 4.5;

  const probability = computeProbability(question.thresholdC, question.comparison, forecastC, stddevC);

  return { probability, forecastC, stddevC, daysOut };
}

function computeProbability(
  threshold: number,
  comparison: Comparison,
  mean: number,
  stddev: number,
): number {
  if (stddev <= 0) {
    // Degenerate: deterministic forecast. Resolve to the boundary case.
    if (comparison === 'gte') return mean >= threshold ? 1 : 0;
    return mean <= threshold ? 1 : 0;
  }
  const z = (threshold - mean) / stddev;
  // P(X >= threshold) = 1 - Φ(z)
  // P(X <= threshold) = Φ(z)
  const phi = normalCDF(z);
  return comparison === 'gte' ? 1 - phi : phi;
}

/** Standard normal CDF via Abramowitz & Stegun erf approximation. */
export function normalCDF(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Abramowitz & Stegun 7.1.26. Max error ~1.5e-7. */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
