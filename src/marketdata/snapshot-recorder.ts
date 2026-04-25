import type { OrderBook } from '../domain/market.js';
import type { Logger } from '../logging/logger.js';
import type { MarketSnapshotStore } from '../persistence/repositories/types.js';
import type { MarketDataFeed } from './feed.js';

/**
 * Subscribes to the same feed the engine uses and writes every book
 * update to the snapshot store. Side-effecting observer only — does not
 * mutate or interfere with strategy execution. Writes are fire-and-forget.
 *
 * Enable via config (`recordSnapshots: true`).
 */
export class SnapshotRecorder {
  private attached = false;

  constructor(
    private readonly store: MarketSnapshotStore,
    private readonly logger: Logger,
  ) {}

  attach(feed: MarketDataFeed): void {
    if (this.attached) return;
    feed.onBookUpdate((book) => this.onBook(book));
    this.attached = true;
    this.logger.info('snapshot-recorder: attached');
  }

  private onBook(book: OrderBook): void {
    this.store.record(book).catch((err: unknown) => {
      this.logger.error({ err }, 'snapshot-recorder: failed to record');
    });
  }
}
