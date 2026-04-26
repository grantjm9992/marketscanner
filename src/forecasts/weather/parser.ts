import { lookupCity, type CityCoords } from './cities.js';

export type Comparison = 'gte' | 'lte';

export interface WeatherQuestion {
  readonly city: CityCoords;
  /** 'high' = highest temperature on the date; 'low' = lowest. */
  readonly variable: 'high' | 'low';
  readonly comparison: Comparison;
  /** Threshold in Celsius (Fahrenheit converted at parse time). */
  readonly thresholdC: number;
  /** YYYY-MM-DD (UTC date). */
  readonly date: string;
  /** Original threshold + unit, kept for logging. */
  readonly raw: { value: number; unit: 'C' | 'F'; cityName: string };
}

const RX = new RegExp(
  [
    'will\\s+the\\s+',
    '(highest|high|max(?:imum)?|lowest|low|min(?:imum)?)\\s+temperature\\s+',
    'in\\s+([A-Za-z .\']+?)\\s+',
    '(be|reach|exceed|hit|go\\s+above|go\\s+below|go\\s+under|fall\\s+below|stay\\s+above|stay\\s+below)\\s+',
    '(-?\\d+(?:\\.\\d+)?)\\s*°?\\s*(c|f|celsius|fahrenheit)?',
    '(?:.*?\\bon\\s+(\\d{4}-\\d{2}-\\d{2}|[A-Za-z]+\\s+\\d{1,2}(?:,?\\s*\\d{4})?))?',
  ].join(''),
  'i',
);

/**
 * Parse a Polymarket weather market title into a structured question.
 * Returns null when the title doesn't match the expected templates or
 * the city isn't in our coords dictionary.
 *
 * Designed to be conservative — parsing failures are silent skips, not
 * errors. The strategy ignores any market the parser can't handle.
 *
 * `referenceDate` is needed to interpret natural-language dates like
 * "today" / "tomorrow" / "April 30" without a year.
 */
export function parseWeatherQuestion(
  title: string,
  referenceDate: Date = new Date(),
): WeatherQuestion | null {
  // Quick keyword tests (today / tomorrow) before the regex, since the
  // regex requires a literal date or month-day.
  const datedTitle = inlineRelativeDate(title, referenceDate);

  const m = RX.exec(datedTitle);
  if (!m) return null;

  const [, varRaw, cityRaw, opRaw, valueRaw, unitRaw, dateRaw] = m;
  if (!varRaw || !cityRaw || !opRaw || !valueRaw) return null;

  const varLower = varRaw.toLowerCase();
  const variable: 'high' | 'low' =
    varLower.startsWith('h') || varLower.startsWith('max') ? 'high' : 'low';

  const comparison: Comparison = inferComparison(opRaw.toLowerCase());

  const value = Number(valueRaw);
  const unit = (unitRaw ?? 'c').toLowerCase().startsWith('f') ? 'F' : 'C';
  const thresholdC = unit === 'F' ? ((value - 32) * 5) / 9 : value;

  const city = lookupCity(cityRaw);
  if (!city) return null;

  const date = normalizeDate(dateRaw, referenceDate);
  if (!date) return null;

  return {
    city,
    variable,
    comparison,
    thresholdC,
    date,
    raw: { value, unit: unit as 'C' | 'F', cityName: cityRaw.trim() },
  };
}

function inferComparison(op: string): Comparison {
  if (
    op.includes('above') ||
    op.includes('exceed') ||
    op.includes('reach') ||
    op.includes('hit') ||
    op === 'be' ||
    op === 'stay above'
  ) {
    return 'gte';
  }
  return 'lte';
}

function normalizeDate(raw: string | undefined, ref: Date): string | null {
  if (!raw) return ymdUtc(ref);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // Try parsing free-form like "April 30" or "April 30, 2026"
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  // If no year given, JS picks 2001; correct it to ref's year (or next
  // year if the parsed month/day is in the past).
  let year = parsed.getUTCFullYear();
  if (year < 2020) {
    year = ref.getUTCFullYear();
    parsed.setUTCFullYear(year);
    if (parsed.getTime() < ref.getTime() - 12 * 60 * 60 * 1000) {
      parsed.setUTCFullYear(year + 1);
    }
  }
  return ymdUtc(parsed);
}

function inlineRelativeDate(title: string, ref: Date): string {
  return title
    .replace(/\btoday\b/i, `on ${ymdUtc(ref)}`)
    .replace(/\btomorrow\b/i, `on ${ymdUtc(addDays(ref, 1))}`)
    .replace(/\byesterday\b/i, `on ${ymdUtc(addDays(ref, -1))}`);
}

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}
