import { describe, it, expect } from 'vitest';
import { FakeClock, SystemClock } from '../../../src/engine/clock.js';

describe('SystemClock', () => {
  it('returns roughly now', () => {
    const c = new SystemClock();
    const before = Date.now();
    const t = c.now().getTime();
    const after = Date.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});

describe('FakeClock', () => {
  it('returns the initial time', () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const c = new FakeClock(t0);
    expect(c.now().getTime()).toBe(t0.getTime());
  });

  it('advances by ms', () => {
    const c = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    c.advance(1000);
    expect(c.now().toISOString()).toBe('2026-01-01T00:00:01.000Z');
  });

  it('rejects negative advance', () => {
    const c = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    expect(() => c.advance(-1)).toThrow();
  });

  it('set() refuses backwards moves', () => {
    const c = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    expect(() => c.set(new Date('2025-12-31T23:59:59Z'))).toThrow();
  });

  it('returns a defensive copy from now()', () => {
    const c = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    const a = c.now();
    a.setFullYear(2099);
    expect(c.now().getFullYear()).toBe(2026);
  });
});
