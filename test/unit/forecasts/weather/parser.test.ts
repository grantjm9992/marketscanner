import { describe, it, expect } from 'vitest';
import { parseWeatherQuestion } from '../../../../src/forecasts/weather/parser.js';

const REF = new Date('2026-04-25T00:00:00Z');

describe('parseWeatherQuestion', () => {
  it('parses a typical "highest temperature in X exceed Y on date" market', () => {
    const q = parseWeatherQuestion(
      'Will the highest temperature in Seoul exceed 25°C on 2026-04-30?',
      REF,
    );
    expect(q).not.toBeNull();
    expect(q?.city.displayName).toBe('Seoul');
    expect(q?.variable).toBe('high');
    expect(q?.comparison).toBe('gte');
    expect(q?.thresholdC).toBe(25);
    expect(q?.date).toBe('2026-04-30');
  });

  it('handles "lowest temperature go below" form', () => {
    const q = parseWeatherQuestion(
      'Will the lowest temperature in Tokyo go below 5°C on 2026-04-26?',
      REF,
    );
    expect(q?.variable).toBe('low');
    expect(q?.comparison).toBe('lte');
    expect(q?.thresholdC).toBe(5);
  });

  it('converts Fahrenheit to Celsius', () => {
    const q = parseWeatherQuestion(
      'Will the highest temperature in NYC reach 80°F on 2026-04-30?',
      REF,
    );
    // (80 - 32) * 5/9 = 26.67
    expect(q?.thresholdC).toBeCloseTo(26.67, 1);
    expect(q?.raw.unit).toBe('F');
  });

  it('handles "today" / "tomorrow" relative dates', () => {
    const q1 = parseWeatherQuestion(
      'Will the highest temperature in London exceed 18°C today?',
      REF,
    );
    expect(q1?.date).toBe('2026-04-25');

    const q2 = parseWeatherQuestion(
      'Will the highest temperature in London exceed 18°C tomorrow?',
      REF,
    );
    expect(q2?.date).toBe('2026-04-26');
  });

  it('returns null for unsupported cities', () => {
    expect(
      parseWeatherQuestion(
        'Will the highest temperature in Atlantis exceed 25°C on 2026-04-30?',
        REF,
      ),
    ).toBeNull();
  });

  it('returns null when not a weather question', () => {
    expect(
      parseWeatherQuestion('Will Rihanna release an album before GTA VI?', REF),
    ).toBeNull();
  });

  it('case-insensitive on city names', () => {
    const q = parseWeatherQuestion(
      'Will the highest temperature in SEOUL exceed 25°C on 2026-04-30?',
      REF,
    );
    expect(q?.city.displayName).toBe('Seoul');
  });

  it('handles missing degree sign', () => {
    const q = parseWeatherQuestion(
      'Will the highest temperature in Seoul exceed 25 C on 2026-04-30?',
      REF,
    );
    expect(q?.thresholdC).toBe(25);
  });
});
