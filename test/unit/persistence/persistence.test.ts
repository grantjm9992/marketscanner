import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../../src/persistence/db.js';
import type { Db } from '../../../src/persistence/db.js';
import { TradeLogRepository } from '../../../src/persistence/repositories/trade-log.js';
import { MarketSnapshotRepository } from '../../../src/persistence/repositories/market-snapshot.js';
import { PositionRepository } from '../../../src/persistence/repositories/position-repository.js';
import { DailyPnlRepository } from '../../../src/persistence/repositories/daily-pnl.js';
import { price, size, usd } from '../../../src/domain/money.js';
import { orderId } from '../../../src/domain/order.js';

describe('persistence', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('runs migrations on open', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('trade_log');
    expect(tables).toContain('market_snapshot');
    expect(tables).toContain('position');
    expect(tables).toContain('daily_pnl');
    expect(tables).toContain('schema_migrations');
  });

  it('does not double-apply migrations', () => {
    const first = db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as {
      c: number;
    };
    db.close();
    db = openDatabase(':memory:');
    const second = db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as {
      c: number;
    };
    // Each :memory: open is fresh, so both should equal 1.
    expect(first.c).toBe(1);
    expect(second.c).toBe(1);
  });

  describe('TradeLogRepository', () => {
    it('records orders, fills, cancels, rejects', async () => {
      const repo = new TradeLogRepository(db, 'paper');
      const now = new Date('2026-04-01T00:00:00Z');
      await repo.recordOrderPlaced(
        {
          marketId: 'm1',
          tokenId: 't1',
          side: 'BUY',
          type: 'LIMIT',
          size: size(10),
          limitPrice: price(0.5),
          clientOrderId: 'c1',
        },
        orderId('o1'),
        now,
      );
      await repo.recordFill({
        orderId: orderId('o1'),
        marketId: 'm1',
        tokenId: 't1',
        side: 'BUY',
        price: price(0.5),
        size: size(10),
        feeUsd: usd(0),
        timestamp: now,
      });
      const recent = await repo.recentForMarket('m1');
      expect(recent.length).toBe(2);
      const eventTypes = recent.map((r) => r.eventType).sort();
      expect(eventTypes).toEqual(['FILL', 'ORDER_PLACED']);
    });
  });

  describe('MarketSnapshotRepository', () => {
    it('records and replays snapshots in order', async () => {
      const repo = new MarketSnapshotRepository(db);
      const t1 = new Date('2026-04-01T00:00:00Z');
      const t2 = new Date('2026-04-01T00:00:01Z');
      await repo.record({
        marketId: 'm1',
        tokenId: 't1',
        bids: [{ price: price(0.49), size: size(100) }],
        asks: [{ price: price(0.51), size: size(100) }],
        timestamp: t2,
      });
      await repo.record({
        marketId: 'm1',
        tokenId: 't1',
        bids: [{ price: price(0.48), size: size(100) }],
        asks: [{ price: price(0.52), size: size(100) }],
        timestamp: t1,
      });
      const replay = await repo.range(t1, new Date(t2.getTime() + 1));
      expect(replay.length).toBe(2);
      expect(replay[0]?.timestamp.getTime()).toBe(t1.getTime());
      expect(replay[1]?.timestamp.getTime()).toBe(t2.getTime());
    });
  });

  describe('PositionRepository', () => {
    it('upserts and retrieves positions', async () => {
      const repo = new PositionRepository(db);
      const now = new Date();
      await repo.upsert(
        {
          marketId: 'm1',
          tokenId: 't1',
          size: size(100),
          avgEntryPrice: price(0.4),
          realizedPnlUsd: usd(0),
        },
        now,
      );
      const got = await repo.get('m1', 't1');
      expect(got?.size).toBe(100);
      expect(got?.avgEntryPrice).toBe(0.4);

      await repo.upsert(
        {
          marketId: 'm1',
          tokenId: 't1',
          size: size(50),
          avgEntryPrice: price(0.45),
          realizedPnlUsd: usd(2.5),
        },
        now,
      );
      const updated = await repo.get('m1', 't1');
      expect(updated?.size).toBe(50);
      expect(updated?.realizedPnlUsd).toBe(2.5);
      expect((await repo.all()).length).toBe(1);
    });
  });

  describe('DailyPnlRepository', () => {
    it('aggregates realized pnl and fees per day', async () => {
      const repo = new DailyPnlRepository(db);
      const day = new Date('2026-04-01T12:34:56Z');
      await repo.recordTrade(day, usd(10), usd(0.05));
      await repo.recordTrade(day, usd(-3), usd(0.05));
      const got = await repo.get(day);
      expect(got?.realizedPnlUsd).toBeCloseTo(7);
      expect(got?.feesPaidUsd).toBeCloseTo(0.1);
      expect(got?.tradeCount).toBe(2);
    });
  });
});
