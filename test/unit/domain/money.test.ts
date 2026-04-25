import { describe, it, expect } from 'vitest';
import {
  price,
  size,
  usd,
  addUsd,
  subUsd,
  addSize,
  subSize,
  mulPriceSize,
  isPriceOnTick,
} from '../../../src/domain/money.js';

describe('price()', () => {
  it('accepts values in [0, 1]', () => {
    expect(price(0)).toBe(0);
    expect(price(0.5)).toBe(0.5);
    expect(price(1)).toBe(1);
  });

  it('rejects negative values', () => {
    expect(() => price(-0.01)).toThrow(/Invalid price/);
  });

  it('rejects values > 1', () => {
    expect(() => price(1.01)).toThrow(/Invalid price/);
  });

  it('rejects NaN', () => {
    expect(() => price(NaN)).toThrow(/Invalid price/);
  });

  it('rejects Infinity', () => {
    expect(() => price(Infinity)).toThrow(/Invalid price/);
  });
});

describe('size()', () => {
  it('accepts non-negative finite values', () => {
    expect(size(0)).toBe(0);
    expect(size(100)).toBe(100);
    expect(size(0.001)).toBe(0.001);
  });

  it('rejects negative values', () => {
    expect(() => size(-1)).toThrow(/Invalid size/);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => size(NaN)).toThrow();
    expect(() => size(Infinity)).toThrow();
  });
});

describe('usd()', () => {
  it('accepts negative values (PnL can be negative)', () => {
    expect(usd(-50)).toBe(-50);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => usd(NaN)).toThrow();
    expect(() => usd(Infinity)).toThrow();
    expect(() => usd(-Infinity)).toThrow();
  });
});

describe('arithmetic helpers', () => {
  it('adds and subtracts USD', () => {
    expect(addUsd(usd(10), usd(5))).toBe(15);
    expect(subUsd(usd(10), usd(15))).toBe(-5);
  });

  it('adds and subtracts sizes', () => {
    expect(addSize(size(10), size(5))).toBe(15);
    expect(subSize(size(10), size(5))).toBe(5);
  });

  it('rejects subtracting to a negative size', () => {
    expect(() => subSize(size(5), size(10))).toThrow(/Invalid size/);
  });

  it('multiplies price * size into USD', () => {
    expect(mulPriceSize(price(0.5), size(100))).toBe(50);
  });
});

describe('isPriceOnTick()', () => {
  it('accepts exact multiples', () => {
    expect(isPriceOnTick(price(0.5), price(0.01))).toBe(true);
    expect(isPriceOnTick(price(0.123), price(0.001))).toBe(true);
  });

  it('rejects non-multiples', () => {
    expect(isPriceOnTick(price(0.505), price(0.01))).toBe(false);
  });

  it('absorbs small floating-point error', () => {
    // 0.1 + 0.2 != 0.3 in IEEE 754, but is "on tick" of 0.01.
    expect(isPriceOnTick(price(0.1 + 0.2), price(0.01))).toBe(true);
  });

  it('returns false for tick <= 0', () => {
    expect(isPriceOnTick(price(0.5), price(0))).toBe(false);
  });
});
