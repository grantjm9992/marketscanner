import type { OrderBook } from '../domain/market.js';
import type { Logger } from '../logging/logger.js';
import type { FakeClock } from '../engine/clock.js';
import type { MarketSnapshotStore } from '../persistence/repositories/types.js';
import type { MarketDataFeed } from './feed.js';

export interface HistoricalFeedOptions {
  readonly store: MarketSnapshotStore;
  readonly clock: FakeClock;
  readonly from: Date;
  readonly to: Date;
  readonly logger: Logger;
}

/**
 * Replays recorded book snapshots from SQLite. Drives a FakeClock forward
 * to each snapshot's timestamp before emitting it, so any time-dependent
 * code under test sees the snapshot's wall-clock time.
 *
 * Backtest mode only.
 */
export class HistoricalFeed implements MarketDataFeed {
  private readonly bookHandlers: Array<(b: OrderBook) => void> = [];
  private readonly errorHandlers: Array<(e: Error) => void> = [];
  private subscribed = new Set<string>();
  private running = false;

  constructor(private readonly opts: HistoricalFeedOptions) {}

  async subscribe(marketIds: readonly string[]): Promise<void> {
    for (const m of marketIds) this.subscribed.add(m);
  }

  async unsubscribe(marketIds: readonly string[]): Promise<void> {
    for (const m of marketIds) this.subscribed.delete(m);
  }

  onBookUpdate(handler: (book: OrderBook) => void): void {
    this.bookHandlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  async start(): Promise<void> {
    this.running = true;
    try {
      const snaps = await this.opts.store.range(this.opts.from, this.opts.to);
      this.opts.logger.info(
        { from: this.opts.from, to: this.opts.to, count: snaps.length },
        'historical-feed: replaying',
      );
      for (const snap of snaps) {
        if (!this.running) break;
        if (this.subscribed.size > 0 && !this.subscribed.has(snap.marketId)) continue;
        // Advance the clock to (or past) this snapshot.
        const now = this.opts.clock.now().getTime();
        const ts = snap.timestamp.getTime();
        if (ts > now) this.opts.clock.advance(ts - now);
        for (const h of this.bookHandlers) h(snap);
      }
      this.opts.logger.info('historical-feed: replay complete');
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const h of this.errorHandlers) h(e);
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }
}
