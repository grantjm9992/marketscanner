import { usd } from '../domain/money.js';
import type { Usd } from '../domain/money.js';
import type { Fill, Order } from '../domain/order.js';
import type { Position } from '../domain/portfolio.js';
import type { Clock } from '../engine/clock.js';
import type { Logger } from '../logging/logger.js';
import type { Signal } from '../strategy/signal.js';
import type { RiskLimits } from './limits.js';

export type RiskDecision =
  | { readonly approved: true }
  | { readonly approved: false; readonly reason: string };

export interface RiskContext {
  readonly positions: readonly Position[];
  readonly openOrders: readonly Order[];
}

export interface RiskManager {
  approve(signal: Signal, ctx: RiskContext): RiskDecision;
  onFill(fill: Fill): void;
  isHalted(): boolean;
  halt(reason: string): void;
  haltReason(): string | null;
}

export interface RiskManagerOptions {
  readonly limits: RiskLimits;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Runs every PLACE_ORDER signal through configured limits before it reaches
 * the venue. Tracks daily realized PnL and trips a sticky kill switch when
 * losses exceed `maxDailyLossUsd`. Once halted, only a process restart
 * clears the halt — by design.
 */
export class DefaultRiskManager implements RiskManager {
  private halted = false;
  private haltedReason: string | null = null;
  private dailyRealizedPnl: Usd = usd(0);
  private dailyKey: string;
  private readonly recentOrderTimestamps: number[] = [];
  private readonly cooldownUntilByMarket = new Map<string, number>();

  constructor(private readonly opts: RiskManagerOptions) {
    this.dailyKey = toDateKey(opts.clock.now());
  }

  approve(signal: Signal, ctx: RiskContext): RiskDecision {
    // Cancels are always allowed — the engine cancels open orders on halt
    // shutdown, so blocking cancels would defeat the kill switch.
    if (signal.kind === 'CANCEL_ORDER') return { approved: true };

    if (this.halted) {
      return { approved: false, reason: `halted: ${this.haltedReason ?? 'unknown'}` };
    }

    const req = signal.request;
    const now = this.opts.clock.now();

    // Per-market cooldown after a loss.
    const cooldownUntil = this.cooldownUntilByMarket.get(req.marketId);
    if (cooldownUntil !== undefined && now.getTime() < cooldownUntil) {
      return {
        approved: false,
        reason: `market ${req.marketId} in cooldown until ${new Date(cooldownUntil).toISOString()}`,
      };
    }

    // Order-rate limit.
    this.pruneOrderTimestamps(now);
    if (this.recentOrderTimestamps.length >= this.opts.limits.maxOrdersPerMinute) {
      return {
        approved: false,
        reason: `order rate limit: ${this.opts.limits.maxOrdersPerMinute}/min`,
      };
    }

    // Open-orders-per-market limit.
    const openForMarket = ctx.openOrders.filter((o) => o.marketId === req.marketId).length;
    if (openForMarket >= this.opts.limits.maxOpenOrdersPerMarket) {
      return {
        approved: false,
        reason: `max open orders for market ${req.marketId} reached (${openForMarket})`,
      };
    }

    // Position-size limit (per market). Estimate notional at limit price
    // for LIMIT, or at 1.0 for MARKET BUY (worst case for binary outcomes).
    const reservationPrice = req.limitPrice ?? 1;
    const orderNotional = (req.size as number) * reservationPrice;
    const existingPositionUsd = ctx.positions
      .filter((p) => p.marketId === req.marketId)
      .reduce((acc, p) => acc + (p.size as number) * (p.avgEntryPrice as number), 0);
    const projectedMarketUsd =
      req.side === 'BUY' ? existingPositionUsd + orderNotional : existingPositionUsd;
    if (projectedMarketUsd > (this.opts.limits.maxPositionSizeUsd as number)) {
      return {
        approved: false,
        reason: `would exceed maxPositionSizeUsd ${this.opts.limits.maxPositionSizeUsd} for market ${req.marketId} (projected ${projectedMarketUsd})`,
      };
    }

    // Total-deployed limit (across markets).
    const totalDeployedUsd = ctx.positions.reduce(
      (acc, p) => acc + (p.size as number) * (p.avgEntryPrice as number),
      0,
    );
    const projectedTotalUsd =
      req.side === 'BUY' ? totalDeployedUsd + orderNotional : totalDeployedUsd;
    if (projectedTotalUsd > (this.opts.limits.maxTotalDeployedUsd as number)) {
      return {
        approved: false,
        reason: `would exceed maxTotalDeployedUsd ${this.opts.limits.maxTotalDeployedUsd} (projected ${projectedTotalUsd})`,
      };
    }

    // Approved — record this attempt for the rate limit.
    this.recentOrderTimestamps.push(now.getTime());
    return { approved: true };
  }

  onFill(fill: Fill): void {
    // Roll daily key if we crossed midnight.
    const todayKey = toDateKey(this.opts.clock.now());
    if (todayKey !== this.dailyKey) {
      this.dailyKey = todayKey;
      this.dailyRealizedPnl = usd(0);
    }

    // Fees always reduce PnL.
    this.dailyRealizedPnl = usd((this.dailyRealizedPnl as number) - (fill.feeUsd as number));

    // Note: the venue is the source of truth for realized P&L on closing
    // trades. We approximate here via fees only; the engine should call
    // recordRealizedPnl() with the venue-computed delta if it wants
    // accurate tracking. For now, fee accumulation is enough to trip the
    // kill switch on aggressive overtrading.
    this.checkKillSwitch();
  }

  /**
   * Engine calls this with the realized-PnL delta of a closing fill (the
   * venue computes this; we only track aggregates). Negative values
   * represent losses.
   */
  recordRealizedPnl(deltaUsd: Usd, marketId: string): void {
    const todayKey = toDateKey(this.opts.clock.now());
    if (todayKey !== this.dailyKey) {
      this.dailyKey = todayKey;
      this.dailyRealizedPnl = usd(0);
    }
    this.dailyRealizedPnl = usd((this.dailyRealizedPnl as number) + (deltaUsd as number));

    if ((deltaUsd as number) < 0) {
      const cooldownEnd = this.opts.clock.now().getTime() + this.opts.limits.perMarketCooldownMs;
      this.cooldownUntilByMarket.set(marketId, cooldownEnd);
    }

    this.checkKillSwitch();
  }

  isHalted(): boolean {
    return this.halted;
  }

  haltReason(): string | null {
    return this.haltedReason;
  }

  halt(reason: string): void {
    if (this.halted) return;
    this.halted = true;
    this.haltedReason = reason;
    this.opts.logger.error({ reason }, 'risk-manager: HALTED');
  }

  // --- internals ---

  private checkKillSwitch(): void {
    if (this.halted) return;
    const lossUsd = -(this.dailyRealizedPnl as number);
    if (lossUsd >= (this.opts.limits.maxDailyLossUsd as number)) {
      this.halt(
        `daily loss ${lossUsd.toFixed(2)} >= max ${(this.opts.limits.maxDailyLossUsd as number).toFixed(2)}`,
      );
    }
  }

  private pruneOrderTimestamps(now: Date): void {
    const cutoff = now.getTime() - 60_000;
    while (this.recentOrderTimestamps.length > 0 && this.recentOrderTimestamps[0]! < cutoff) {
      this.recentOrderTimestamps.shift();
    }
  }
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
