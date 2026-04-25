import { describe, it, expect } from 'vitest';
import {
  discoverMarkets,
  type Fetcher,
} from '../../../src/marketdata/market-discovery.js';
import { FakeClock } from '../../../src/engine/clock.js';
import { createLogger } from '../../../src/logging/logger.js';

const logger = createLogger({ level: 'silent' });

interface RawShape {
  conditionId?: string;
  question?: string;
  category?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  acceptingOrders?: boolean;
  volume24hr?: number;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
}

function fakeFetcher(pages: ReadonlyArray<readonly RawShape[]>): Fetcher {
  let pageIdx = 0;
  return async (_url: string) => {
    const body = pages[pageIdx] ?? [];
    pageIdx += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const now = new Date('2026-04-25T00:00:00Z');

function clock() {
  return new FakeClock(now);
}

describe('discoverMarkets', () => {
  it('returns markets that pass all filters', async () => {
    const pages: RawShape[][] = [
      [
        {
          conditionId: '0xa',
          question: 'A',
          category: 'Sports',
          endDate: '2026-06-01T00:00:00Z',
          active: true,
          closed: false,
          acceptingOrders: true,
          volume24hr: 100_000,
          bestBid: 0.49,
          bestAsk: 0.52, // spread 3¢
        },
      ],
    ];
    const out = await discoverMarkets({
      gammaHost: 'https://example.com',
      filters: { minVolume24hUsd: 50_000, minSpread: 0.02, maxSpread: 0.05 },
      clock: clock(),
      logger,
      fetcher: fakeFetcher(pages),
    });
    expect(out.length).toBe(1);
    expect(out[0]?.conditionId).toBe('0xa');
    expect(out[0]?.spread).toBeCloseTo(0.03);
  });

  it('drops closed/archived/inactive/non-accepting markets', async () => {
    const pages: RawShape[][] = [
      [
        { conditionId: '0xa', endDate: '2026-06-01T00:00:00Z', active: true, closed: true, volume24hr: 100_000 },
        { conditionId: '0xb', endDate: '2026-06-01T00:00:00Z', active: true, archived: true, volume24hr: 100_000 },
        { conditionId: '0xc', endDate: '2026-06-01T00:00:00Z', active: false, volume24hr: 100_000 },
        { conditionId: '0xd', endDate: '2026-06-01T00:00:00Z', active: true, acceptingOrders: false, volume24hr: 100_000 },
      ],
    ];
    const out = await discoverMarkets({
      gammaHost: 'https://example.com',
      filters: {},
      clock: clock(),
      logger,
      fetcher: fakeFetcher(pages),
    });
    expect(out.length).toBe(0);
  });

  it('filters by categories case-insensitively', async () => {
    const pages: RawShape[][] = [
      [
        {
          conditionId: '0xa',
          category: 'sports', // lowercase in source
          endDate: '2026-06-01T00:00:00Z',
          volume24hr: 1,
        },
        {
          conditionId: '0xb',
          category: 'Crypto',
          endDate: '2026-06-01T00:00:00Z',
          volume24hr: 1,
        },
      ],
    ];
    const out = await discoverMarkets({
      gammaHost: 'https://example.com',
      filters: { categories: ['Sports', 'Politics'] },
      clock: clock(),
      logger,
      fetcher: fakeFetcher(pages),
    });
    expect(out.map((m) => m.conditionId)).toEqual(['0xa']);
  });

  it('filters by minDaysToResolution against the injected clock', async () => {
    const tooSoon = new Date(now.getTime() + 2 * 86_400_000).toISOString();
    const farEnough = new Date(now.getTime() + 14 * 86_400_000).toISOString();
    const pages: RawShape[][] = [
      [
        { conditionId: '0xa', endDate: tooSoon, volume24hr: 1 },
        { conditionId: '0xb', endDate: farEnough, volume24hr: 1 },
      ],
    ];
    const out = await discoverMarkets({
      gammaHost: 'https://example.com',
      filters: { minDaysToResolution: 7 },
      clock: clock(),
      logger,
      fetcher: fakeFetcher(pages),
    });
    expect(out.map((m) => m.conditionId)).toEqual(['0xb']);
  });

  it('drops markets without computable spread when minSpread is set', async () => {
    const pages: RawShape[][] = [
      [
        // Only one side available — spread is unknowable.
        { conditionId: '0xa', endDate: '2026-06-01T00:00:00Z', volume24hr: 1, bestBid: 0.49 },
      ],
    ];
    const out = await discoverMarkets({
      gammaHost: 'https://example.com',
      filters: { minSpread: 0.01 },
      clock: clock(),
      logger,
      fetcher: fakeFetcher(pages),
    });
    expect(out.length).toBe(0);
  });

  it('sorts by 24h volume desc and respects limit', async () => {
    const pages: RawShape[][] = [
      [
        { conditionId: '0xa', endDate: '2026-06-01T00:00:00Z', volume24hr: 100 },
        { conditionId: '0xb', endDate: '2026-06-01T00:00:00Z', volume24hr: 1_000 },
        { conditionId: '0xc', endDate: '2026-06-01T00:00:00Z', volume24hr: 500 },
      ],
    ];
    const out = await discoverMarkets({
      gammaHost: 'https://example.com',
      filters: { limit: 2 },
      clock: clock(),
      logger,
      fetcher: fakeFetcher(pages),
    });
    expect(out.map((m) => m.conditionId)).toEqual(['0xb', '0xc']);
  });

  it('paginates through multiple pages until short page', async () => {
    const fullPage = (idStart: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        conditionId: `0x${idStart + i}`,
        endDate: '2026-06-01T00:00:00Z',
        volume24hr: idStart + i,
      }));
    const pages = [fullPage(0), fullPage(100), [{ conditionId: '0x200', endDate: '2026-06-01T00:00:00Z', volume24hr: 999_999 }]];
    const out = await discoverMarkets({
      gammaHost: 'https://example.com',
      filters: { pageSize: 100, limit: 5 },
      clock: clock(),
      logger,
      fetcher: fakeFetcher(pages),
    });
    expect(out[0]?.conditionId).toBe('0x200');
    expect(out.length).toBe(5);
  });

  it('throws on non-OK responses', async () => {
    const fetcher: Fetcher = async () =>
      new Response('rate limited', { status: 429 });
    await expect(
      discoverMarkets({
        gammaHost: 'https://example.com',
        filters: {},
        clock: clock(),
        logger,
        fetcher,
      }),
    ).rejects.toThrow(/Gamma API 429/);
  });

  it('handles snake_case fields from the API', async () => {
    const pages = [
      [
        {
          condition_id: '0xa',
          end_date_iso: '2026-06-01T00:00:00Z',
          volume_24hr: 100_000,
          best_bid: 0.49,
          best_ask: 0.51,
          accepting_orders: true,
        } as unknown as RawShape,
      ],
    ];
    const out = await discoverMarkets({
      gammaHost: 'https://example.com',
      filters: { minSpread: 0.01 },
      clock: clock(),
      logger,
      fetcher: fakeFetcher(pages),
    });
    expect(out[0]?.conditionId).toBe('0xa');
    expect(out[0]?.spread).toBeCloseTo(0.02);
  });
});
