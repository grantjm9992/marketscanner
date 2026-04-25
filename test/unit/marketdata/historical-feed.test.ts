import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../../src/persistence/db.js';
import type { Db } from '../../../src/persistence/db.js';
import { MarketSnapshotRepository } from '../../../src/persistence/repositories/market-snapshot.js';
import { HistoricalFeed } from '../../../src/marketdata/historical-feed.js';
import { SnapshotRecorder } from '../../../src/marketdata/snapshot-recorder.js';
import { FakeClock } from '../../../src/engine/clock.js';
import { createLogger } from '../../../src/logging/logger.js';
import { price, size } from '../../../src/domain/money.js';
import type { OrderBook } from '../../../src/domain/market.js';

describe('HistoricalFeed + SnapshotRecorder', () => {
  let db: Db;
  let repo: MarketSnapshotRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new MarketSnapshotRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('replays snapshots in chronological order and advances the clock', async () => {
    const t1 = new Date('2026-01-01T00:00:00Z');
    const t2 = new Date('2026-01-01T00:00:10Z');
    repo.record(snap('m1', 't1', t2));
    repo.record(snap('m1', 't1', t1));

    const clock = new FakeClock(new Date('2025-12-31T00:00:00Z'));
    const feed = new HistoricalFeed({
      repo,
      clock,
      from: t1,
      to: new Date(t2.getTime() + 1),
      logger: createLogger({ level: 'silent' }),
    });

    const seen: OrderBook[] = [];
    feed.onBookUpdate((b) => seen.push(b));

    await feed.start();
    expect(seen.length).toBe(2);
    expect(seen[0]?.timestamp.getTime()).toBe(t1.getTime());
    expect(seen[1]?.timestamp.getTime()).toBe(t2.getTime());
    expect(clock.now().getTime()).toBe(t2.getTime());
  });

  it('SnapshotRecorder writes every book update to the repo', async () => {
    const recorder = new SnapshotRecorder(repo, createLogger({ level: 'silent' }));
    const fakeFeed = {
      _h: null as null | ((b: OrderBook) => void),
      onBookUpdate(h: (b: OrderBook) => void) {
        this._h = h;
      },
      onError() {},
      async subscribe() {},
      async unsubscribe() {},
      async start() {},
      async stop() {},
    };
    recorder.attach(fakeFeed);
    fakeFeed._h?.(snap('m1', 't1', new Date('2026-01-01T00:00:00Z')));
    fakeFeed._h?.(snap('m1', 't1', new Date('2026-01-01T00:00:01Z')));

    const out = repo.range(
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-01T00:00:02Z'),
    );
    expect(out.length).toBe(2);
  });
});

function snap(marketId: string, tokenId: string, ts: Date): OrderBook {
  return {
    marketId,
    tokenId,
    bids: [{ price: price(0.49), size: size(100) }],
    asks: [{ price: price(0.51), size: size(100) }],
    timestamp: ts,
  };
}
