import { usd } from './money.js';
import type { Price, Size, Usd } from './money.js';

export interface Position {
  readonly marketId: string;
  readonly tokenId: string;
  readonly size: Size;
  readonly avgEntryPrice: Price;
  readonly realizedPnlUsd: Usd;
}

export interface Portfolio {
  readonly cashUsd: Usd;
  readonly positions: readonly Position[];
}

/**
 * Mark-to-market equity = cash + sum(position.size * mark) where `marks` is
 * a tokenId -> mid-price map. Positions whose tokenId is missing from
 * `marks` are valued at avgEntryPrice (best we can do without a fresh book).
 */
export function totalEquityUsd(p: Portfolio, marks: ReadonlyMap<string, Price>): Usd {
  let total = p.cashUsd as number;
  for (const pos of p.positions) {
    const mark = marks.get(pos.tokenId) ?? pos.avgEntryPrice;
    total += pos.size * mark;
  }
  return usd(total);
}
