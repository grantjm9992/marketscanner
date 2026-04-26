import type { Logger } from '../logging/logger.js';
import type { Clock } from '../engine/clock.js';
import type { Market, MarketRewards } from '../domain/market.js';
import type { Engine } from '../engine/engine.js';
import {
  discoverMarkets,
  type DiscoveredMarket,
  type DiscoveryFilters,
} from './market-discovery.js';
import { price, size } from '../domain/money.js';

/**
 * Resolves a Polymarket condition ID to a fully-populated `Market`. Used
 * by MarketRefresher to fetch CLOB metadata for each newly discovered
 * market. Defined as an injectable function so it can be tested without
 * hitting the live CLOB.
 */
export type MarketResolver = (
  conditionId: string,
  rewards?: MarketRewards,
) => Promise<Market | null>;

export interface MarketRefresherOptions {
  readonly engine: Engine;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly gammaHost: string;
  readonly filters: DiscoveryFilters;
  readonly resolveMarket: MarketResolver;
  /** How often to re-run discovery, in ms. */
  readonly intervalMs: number;
}

/**
 * Periodically re-runs market discovery and applies the diff against the
 * engine's currently-tracked market set:
 *
 *   - New markets        -> engine.addMarket()
 *   - Markets that drop  -> engine.removeMarket()
 *   - Markets in both    -> left alone (no churn for unchanged markets)
 *
 * Eliminates the need to restart the bot to pick up newly created markets
 * or evict resolved ones.
 *
 * Resilient: a failed discovery cycle logs and keeps going. The engine's
 * current market set is only mutated when the new discovery completes
 * successfully.
 */
export class MarketRefresher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: MarketRefresherOptions) {}

  start(): void {
    if (this.timer) return;
    this.opts.logger.info(
      { intervalMs: this.opts.intervalMs },
      'market-refresher: started',
    );
    // Don't tick immediately on start — engine.start() already ran the
    // initial discovery via main.loadMarkets. First refresh fires after
    // intervalMs.
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Public for testing; production callers use `start()`. */
  async runOnce(): Promise<void> {
    if (this.running) {
      this.opts.logger.warn('market-refresher: previous cycle still running, skipping');
      return;
    }
    this.running = true;
    try {
      await this.cycle();
    } catch (err) {
      this.opts.logger.error({ err }, 'market-refresher: cycle failed');
    } finally {
      this.running = false;
    }
  }

  private async cycle(): Promise<void> {
    const discovered = await discoverMarkets({
      gammaHost: this.opts.gammaHost,
      filters: this.opts.filters,
      clock: this.opts.clock,
      logger: this.opts.logger,
    });

    const desiredIds = new Set(discovered.map((d) => d.conditionId));
    const currentIds = new Set(this.opts.engine.trackedMarketIds());

    const toAdd: DiscoveredMarket[] = discovered.filter((d) => !currentIds.has(d.conditionId));
    const toRemove: string[] = [...currentIds].filter((id) => !desiredIds.has(id));

    this.opts.logger.info(
      {
        current: currentIds.size,
        discovered: discovered.length,
        toAdd: toAdd.length,
        toRemove: toRemove.length,
      },
      'market-refresher: cycle complete; applying diff',
    );

    for (const id of toRemove) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.opts.engine.removeMarket(id);
      } catch (err) {
        this.opts.logger.error({ err, marketId: id }, 'market-refresher: removeMarket failed');
      }
    }

    for (const d of toAdd) {
      const rewards =
        d.rewardsDailyRateUsd > 0 && d.rewardsMaxSpread !== null && d.rewardsMinSize !== null
          ? {
              dailyRateUsd: d.rewardsDailyRateUsd,
              maxSpread: price(d.rewardsMaxSpread),
              minSize: size(d.rewardsMinSize),
            }
          : undefined;
      try {
        // eslint-disable-next-line no-await-in-loop
        const market = await this.opts.resolveMarket(d.conditionId, rewards);
        if (!market) {
          this.opts.logger.warn(
            { conditionId: d.conditionId },
            'market-refresher: resolver returned null; skipping',
          );
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await this.opts.engine.addMarket(market);
      } catch (err) {
        this.opts.logger.error(
          { err, conditionId: d.conditionId },
          'market-refresher: addMarket failed',
        );
      }
    }
  }
}
