/**
 * Branded numeric types. Use these everywhere instead of raw `number` so
 * the type system catches mistakes like passing a price where a size is
 * expected.
 */

export type Price = number & { readonly __brand: 'Price' };
export type Size = number & { readonly __brand: 'Size' };
export type Usd = number & { readonly __brand: 'Usd' };

export function price(n: number): Price {
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`Invalid price: ${n} (must be finite in [0, 1])`);
  }
  return n as Price;
}

export function size(n: number): Size {
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid size: ${n} (must be finite and >= 0)`);
  }
  return n as Size;
}

export function usd(n: number): Usd {
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid usd: ${n} (must be finite)`);
  }
  return n as Usd;
}

export function addUsd(a: Usd, b: Usd): Usd {
  return usd(a + b);
}

export function subUsd(a: Usd, b: Usd): Usd {
  return usd(a - b);
}

export function addSize(a: Size, b: Size): Size {
  return size(a + b);
}

export function subSize(a: Size, b: Size): Size {
  return size(a - b);
}

export function mulPriceSize(p: Price, s: Size): Usd {
  return usd(p * s);
}

/**
 * Returns true if `n` is a non-negative multiple of `tick` (within a small
 * tolerance to absorb floating-point error).
 */
export function isPriceOnTick(p: Price, tick: Price): boolean {
  if (tick <= 0) return false;
  const ratio = p / tick;
  return Math.abs(ratio - Math.round(ratio)) < 1e-9;
}
