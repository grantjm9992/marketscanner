import type { OrderBook } from '../domain/market.js';
import type { Logger } from '../logging/logger.js';
import type { MarketSnapshotStore } from '../persistence/repositories/types.js';
import type { MarketDataFeed } from './feed.js';

/**
 * Subscribes to the same feed the engine uses and writes every book
 * update to the snapshot store. Side-effecting observer only — does not
 * mutate or interfere with strategy execution. Writes are fire-and-forget.
 *
 * Logs a periodic summary so you can see ingestion is healthy without
 * tailing every event.
 */
export class SnapshotRecorder {
  private attached = false;
  private writesSinceLog = 0;
  private errorsSinceLog = 0;
  private logTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: MarketSnapshotStore,
    private readonly logger: Logger,
    private readonly summaryIntervalMs = 60_000,
  ) {}

  attach(feed: MarketDataFeed): void {
    if (this.attached) return;
    feed.onBookUpdate((book) => this.onBook(book));
    this.attached = true;
    this.logger.info('snapshot-recorder: attached');
    if (this.summaryIntervalMs > 0) {
      this.logTimer = setInterval(() => this.emitSummary(), this.summaryIntervalMs);
    }
  }

  detach(): void {
    if (this.logTimer) {
      clearInterval(this.logTimer);
      this.logTimer = null;
    }
  }

  private onBook(book: OrderBook): void {
    this.store
      .record(book)
      .then(() => {
        this.writesSinceLog += 1;
      })
      .catch((err: unknown) => {
        this.errorsSinceLog += 1;
        this.logger.error({ err }, 'snapshot-recorder: failed to record');
      });
  }

  private emitSummary(): void {
    if (this.writesSinceLog === 0 && this.errorsSinceLog === 0) return;
    this.logger.info(
      {
        writes: this.writesSinceLog,
        errors: this.errorsSinceLog,
        windowMs: this.summaryIntervalMs,
      },
      'snapshot-recorder: summary',
    );
    this.writesSinceLog = 0;
    this.errorsSinceLog = 0;
  }
}
