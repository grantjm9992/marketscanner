/**
 * Smoke test for the Postgres backend. Skipped unless TEST_PG_URL is set
 * to a connection string for a disposable Postgres database.
 *
 * Local example:
 *   docker run -d --rm --name pg-test -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:16
 *   TEST_PG_URL=postgres://postgres:test@localhost:5432/postgres pnpm test
 *
 * On CI: set TEST_PG_URL as a secret pointing at a service container.
 */
import { describe, it, expect } from 'vitest';
import { openStores } from '../../../src/persistence/stores.js';
import { price, size, usd } from '../../../src/domain/money.js';
import { orderId } from '../../../src/domain/order.js';

const PG_URL = process.env.TEST_PG_URL;
const d = PG_URL ? describe : describe.skip;

d('Postgres backend (smoke)', () => {
  it('round-trips trade-log, snapshot, position, daily PnL', async () => {
    const stores = await openStores({
      kind: 'postgres',
      mode: 'paper',
      pgConnectionString: PG_URL!,
      pgSsl: false,
    });

    try {
      // trade log
      const now = new Date();
      await stores.tradeLog.recordOrderPlaced(
        {
          marketId: 'm-pg-smoke',
          tokenId: 't1',
          side: 'BUY',
          type: 'LIMIT',
          size: size(10),
          limitPrice: price(0.5),
          clientOrderId: 'c1',
        },
        orderId('pg-1'),
        now,
      );
      await stores.tradeLog.recordFill({
        orderId: orderId('pg-1'),
        marketId: 'm-pg-smoke',
        tokenId: 't1',
        side: 'BUY',
        price: price(0.5),
        size: size(10),
        feeUsd: usd(0),
        timestamp: now,
      });
      const recent = await stores.tradeLog.recentForMarket('m-pg-smoke');
      expect(recent.length).toBeGreaterThanOrEqual(2);

      // snapshot
      const t = new Date();
      await stores.marketSnapshot.record({
        marketId: 'm-pg-smoke',
        tokenId: 't1',
        bids: [{ price: price(0.49), size: size(100) }],
        asks: [{ price: price(0.51), size: size(100) }],
        timestamp: t,
      });
      const range = await stores.marketSnapshot.range(
        new Date(t.getTime() - 1000),
        new Date(t.getTime() + 1000),
      );
      expect(range.length).toBeGreaterThanOrEqual(1);

      // position
      await stores.position.upsert(
        {
          marketId: 'm-pg-smoke',
          tokenId: 't1',
          size: size(10),
          avgEntryPrice: price(0.5),
          realizedPnlUsd: usd(0),
        },
        now,
      );
      const got = await stores.position.get('m-pg-smoke', 't1');
      expect(got?.size).toBe(10);

      // daily PnL
      await stores.dailyPnl.recordTrade(now, usd(1.5), usd(0.05));
      await stores.dailyPnl.recordTrade(now, usd(-0.5), usd(0.05));
      const summary = await stores.dailyPnl.get(now);
      expect(summary?.tradeCount).toBeGreaterThanOrEqual(2);

      // cleanup test rows so re-runs don't accumulate
      await stores.position.remove('m-pg-smoke', 't1');
    } finally {
      await stores.close();
    }
  });
});
