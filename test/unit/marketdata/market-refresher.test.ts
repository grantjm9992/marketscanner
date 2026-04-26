import { describe, it, expect, vi } from 'vitest';
import { MarketRefresher } from '../../../src/marketdata/market-refresher.js';
import type { Market } from '../../../src/domain/market.js';
import { price, size } from '../../../src/domain/money.js';
import { FakeClock } from '../../../src/engine/clock.js';
import { createLogger } from '../../../src/logging/logger.js';
import type { Engine } from '../../../src/engine/engine.js';

const logger = createLogger({ level: 'silent' });
const clock = new FakeClock(new Date('2026-04-25T00:00:00Z'));

interface RawShape {
  conditionId: string;
  question?: string;
  endDate?: string;
  volume24hr?: number;
  active?: boolean;
  closed?: boolean;
}

function fetcherFromQueue(pages: ReadonlyArray<readonly RawShape[]>) {
  let i = 0;
  return async () =>
    new Response(JSON.stringify(pages[i++] ?? []), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

function makeMarket(conditionId: string): Market {
  return {
    conditionId,
    question: `Q for ${conditionId}`,
    outcomes: [{ tokenId: `t-${conditionId}`, label: 'Yes' }],
    tickSize: price(0.01),
    minOrderSize: size(5),
    endDate: new Date('2099-01-01'),
    category: 'weather',
  };
}

/**
 * Stub engine. Tracks what was added/removed; lets tests assert on the diff.
 */
function makeStubEngine(initial: readonly string[] = []) {
  const tracked = new Set<string>(initial);
  const added: string[] = [];
  const removed: string[] = [];
  const stub: Pick<Engine, 'addMarket' | 'removeMarket' | 'trackedMarketIds'> = {
    trackedMarketIds: () => [...tracked],
    addMarket: vi.fn(async (market: Market) => {
      tracked.add(market.conditionId);
      added.push(market.conditionId);
    }),
    removeMarket: vi.fn(async (id: string) => {
      tracked.delete(id);
      removed.push(id);
    }),
  };
  return { engine: stub as unknown as Engine, added, removed, tracked };
}

describe('MarketRefresher', () => {
  it('adds newly discovered markets', async () => {
    const { engine, added, removed } = makeStubEngine([]);
    const baseDate = '2026-06-01T00:00:00Z';
    const refresher = new MarketRefresher({
      engine,
      logger,
      clock,
      gammaHost: 'https://example.com',
      filters: { minVolume24hUsd: 0 },
      resolveMarket: async (id) => makeMarket(id),
      intervalMs: 60_000,
    });
    // Inject fetcher via global fetch override would work, but cleaner:
    // use the discoverMarkets fetcher injection via a wrapper. The
    // refresher uses discoverMarkets internally without an injectable
    // fetcher, so we monkey-patch global fetch for this test scope.
    const original = globalThis.fetch;
    globalThis.fetch = fetcherFromQueue([
      [
        {
          conditionId: '0xa',
          question: 'A',
          endDate: baseDate,
          volume24hr: 1,
          active: true,
          closed: false,
        },
        {
          conditionId: '0xb',
          question: 'B',
          endDate: baseDate,
          volume24hr: 1,
          active: true,
          closed: false,
        },
      ],
    ]) as typeof globalThis.fetch;
    try {
      await refresher.runOnce();
    } finally {
      globalThis.fetch = original;
    }
    expect(added.sort()).toEqual(['0xa', '0xb']);
    expect(removed).toEqual([]);
  });

  it('removes markets that disappear from discovery', async () => {
    const { engine, added, removed } = makeStubEngine(['0xstale', '0xkeep']);
    const refresher = new MarketRefresher({
      engine,
      logger,
      clock,
      gammaHost: 'https://example.com',
      filters: { minVolume24hUsd: 0 },
      resolveMarket: async (id) => makeMarket(id),
      intervalMs: 60_000,
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetcherFromQueue([
      [
        {
          conditionId: '0xkeep',
          question: 'K',
          endDate: '2026-06-01T00:00:00Z',
          volume24hr: 1,
          active: true,
          closed: false,
        },
      ],
    ]) as typeof globalThis.fetch;
    try {
      await refresher.runOnce();
    } finally {
      globalThis.fetch = original;
    }
    expect(removed).toEqual(['0xstale']);
    expect(added).toEqual([]);
  });

  it('leaves unchanged markets alone', async () => {
    const { engine, added, removed } = makeStubEngine(['0xa']);
    const refresher = new MarketRefresher({
      engine,
      logger,
      clock,
      gammaHost: 'https://example.com',
      filters: { minVolume24hUsd: 0 },
      resolveMarket: async (id) => makeMarket(id),
      intervalMs: 60_000,
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetcherFromQueue([
      [
        {
          conditionId: '0xa',
          question: 'A',
          endDate: '2026-06-01T00:00:00Z',
          volume24hr: 1,
          active: true,
          closed: false,
        },
      ],
    ]) as typeof globalThis.fetch;
    try {
      await refresher.runOnce();
    } finally {
      globalThis.fetch = original;
    }
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('tolerates a failing resolve and keeps going on the rest', async () => {
    const { engine, added } = makeStubEngine([]);
    const refresher = new MarketRefresher({
      engine,
      logger,
      clock,
      gammaHost: 'https://example.com',
      filters: { minVolume24hUsd: 0 },
      resolveMarket: async (id) => (id === '0xbad' ? null : makeMarket(id)),
      intervalMs: 60_000,
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetcherFromQueue([
      [
        {
          conditionId: '0xgood',
          question: 'G',
          endDate: '2026-06-01T00:00:00Z',
          volume24hr: 1,
          active: true,
          closed: false,
        },
        {
          conditionId: '0xbad',
          question: 'B',
          endDate: '2026-06-01T00:00:00Z',
          volume24hr: 1,
          active: true,
          closed: false,
        },
      ],
    ]) as typeof globalThis.fetch;
    try {
      await refresher.runOnce();
    } finally {
      globalThis.fetch = original;
    }
    expect(added).toEqual(['0xgood']);
  });
});
