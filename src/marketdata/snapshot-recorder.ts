import type { OrderBook } from '../domain/market.js';
import type { Logger } from '../logging/logger.js';
import type { MarketSnapshotRepository } from '../persistence/repositories/market-snapshot.js';
import type { MarketDataFeed } from './feed.js';

/**
 * Subscribes to the same feed the engine uses and writes every book
 * update to the `market_snapshot` table. Side-effecting observer only —
 * does not mutate or interfere with strategy execution.
 *
 * Enable via config (`recordSnapshots: true`). Recommended to leave on for
 * weeks before trusting any backtest result.
 */
export class SnapshotRecorder {
  private attached = false;

  constructor(
    private readonly repo: MarketSnapshotRepository,
    private readonly logger: Logger,
  ) {}

  attach(feed: MarketDataFeed): void {
    if (this.attached) return;
    feed.onBookUpdate((book) => this.onBook(book));
    this.attached = true;
    this.logger.info('snapshot-recorder: attached');
  }

  private onBook(book: OrderBook): void {
    try {
      this.repo.record(book);
    } catch (err) {
      this.logger.error({ err }, 'snapshot-recorder: failed to record');
    }
  }
}
