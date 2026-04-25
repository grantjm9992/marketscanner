import type { Usd } from '../domain/money.js';

export interface RiskLimits {
  readonly maxPositionSizeUsd: Usd;
  readonly maxTotalDeployedUsd: Usd;
  readonly maxDailyLossUsd: Usd;
  readonly maxOrdersPerMinute: number;
  readonly perMarketCooldownMs: number;
  readonly maxOpenOrdersPerMarket: number;
}
