import type { Clock } from '../engine/clock.js';
import type { Logger } from '../logging/logger.js';

export interface DiscoveryFilters {
  /** Match if market.category is in this set (case-insensitive). Empty = any. */
  readonly categories?: readonly string[];
  /** Minimum 24h notional in USD. */
  readonly minVolume24hUsd?: number;
  /** Minimum days from now until market end. */
  readonly minDaysToResolution?: number;
  /** Minimum spread in dollars (e.g. 0.02 = 2¢). */
  readonly minSpread?: number;
  /** Maximum spread in dollars (filters out illiquid markets). */
  readonly maxSpread?: number;
  /** Cap the number of markets returned. Default 10. */
  readonly limit?: number;
  /** Number of markets fetched per Gamma request. Default 100. */
  readonly pageSize?: number;
  /** Hard cap on Gamma pages walked, regardless of `limit`. Default 5. */
  readonly maxPages?: number;
}

export interface DiscoveredMarket {
  readonly conditionId: string;
  readonly question: string;
  readonly category: string;
  readonly endDate: Date;
  readonly volume24hUsd: number;
  readonly spread: number | null;
}

export type Fetcher = (url: string) => Promise<Response>;

export interface MarketDiscoveryOptions {
  /** Gamma host, e.g. https://gamma-api.polymarket.com */
  readonly gammaHost: string;
  readonly filters: DiscoveryFilters;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetcher?: Fetcher;
}

/**
 * Raw shape returned by Gamma's /markets endpoint. Defensive — the API
 * mixes camelCase and snake_case across versions.
 */
interface GammaMarketRaw {
  conditionId?: string;
  condition_id?: string;
  question?: string;
  category?: string;
  endDate?: string;
  end_date_iso?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  acceptingOrders?: boolean;
  accepting_orders?: boolean;
  volumeNum?: number;
  volume24hr?: number;
  volume_24hr?: number;
  bestBid?: number;
  bestAsk?: number;
  best_bid?: number;
  best_ask?: number;
  spread?: number;
}

/**
 * Query Polymarket's Gamma API for markets that match the given filters.
 * Returns a list of `DiscoveredMarket`s sorted by 24h volume descending,
 * truncated to `filters.limit`.
 *
 * Discovery is best-effort and read-only; failures here should not crash
 * the bot — caller can fall back to explicitly configured STRATEGY_MARKETS.
 */
export async function discoverMarkets(
  opts: MarketDiscoveryOptions,
): Promise<readonly DiscoveredMarket[]> {
  const limit = opts.filters.limit ?? 10;
  const pageSize = opts.filters.pageSize ?? 100;
  const maxPages = opts.filters.maxPages ?? 5;
  const fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = opts.clock.now();

  const out: DiscoveredMarket[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageSize;
    const url = `${opts.gammaHost.replace(/\/$/, '')}/markets?active=true&closed=false&limit=${pageSize}&offset=${offset}`;
    const res = await fetcher(url);
    if (!res.ok) {
      throw new Error(`Gamma API ${res.status}: ${await safeText(res)}`);
    }
    const body = (await res.json()) as unknown;
    const arr = Array.isArray(body) ? (body as GammaMarketRaw[]) : [];
    if (arr.length === 0) break;

    for (const raw of arr) {
      const m = normalize(raw);
      if (!m) continue;
      if (!matches(m, opts.filters, now)) continue;
      out.push(m);
    }

    // Stop when the page came back short — no more data.
    if (arr.length < pageSize) break;
  }

  out.sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  const truncated = out.slice(0, limit);

  opts.logger.info(
    {
      candidatesScanned: out.length,
      selected: truncated.length,
      filters: opts.filters,
    },
    'market-discovery: complete',
  );
  return truncated;
}

function normalize(raw: GammaMarketRaw): DiscoveredMarket | null {
  const conditionId = raw.conditionId ?? raw.condition_id;
  if (!conditionId) return null;
  if (raw.closed === true || raw.archived === true) return null;
  if (raw.active === false) return null;
  // `acceptingOrders === false` means the market is paused; skip it.
  if (raw.acceptingOrders === false || raw.accepting_orders === false) return null;

  const volume24hUsd = raw.volume24hr ?? raw.volume_24hr ?? 0;
  const endIso = raw.endDate ?? raw.end_date_iso;
  if (!endIso) return null;
  const endDate = new Date(endIso);
  if (Number.isNaN(endDate.getTime())) return null;

  const bestBid = raw.bestBid ?? raw.best_bid;
  const bestAsk = raw.bestAsk ?? raw.best_ask;
  const spread =
    typeof raw.spread === 'number'
      ? raw.spread
      : typeof bestBid === 'number' && typeof bestAsk === 'number'
        ? bestAsk - bestBid
        : null;

  return {
    conditionId,
    question: raw.question ?? '',
    category: raw.category ?? 'other',
    endDate,
    volume24hUsd,
    spread,
  };
}

function matches(m: DiscoveredMarket, f: DiscoveryFilters, now: Date): boolean {
  if (f.categories && f.categories.length > 0) {
    const wantedLower = f.categories.map((c) => c.toLowerCase());
    if (!wantedLower.includes(m.category.toLowerCase())) return false;
  }
  if (typeof f.minVolume24hUsd === 'number' && m.volume24hUsd < f.minVolume24hUsd) {
    return false;
  }
  if (typeof f.minDaysToResolution === 'number') {
    const daysOut = (m.endDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    if (daysOut < f.minDaysToResolution) return false;
  }
  if (typeof f.minSpread === 'number') {
    if (m.spread === null || m.spread < f.minSpread) return false;
  }
  if (typeof f.maxSpread === 'number') {
    if (m.spread === null || m.spread > f.maxSpread) return false;
  }
  return true;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '<unreadable body>';
  }
}
