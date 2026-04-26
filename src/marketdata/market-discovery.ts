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
  /** If true, only return markets with positive CLOB maker-rewards rate. */
  readonly requireRewards?: boolean;
  /**
   * Optional regex applied case-insensitively to the market question.
   * Markets whose question doesn't match are dropped. Useful for
   * scoping discovery to a topic the strategy understands (e.g.
   * `temperature|weather|rain|snow` for the weather-forecast strategy).
   */
  readonly questionRegex?: RegExp;
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
  /** Sum of all rewardsDailyRate across the market's reward streams. 0 if none. */
  readonly rewardsDailyRateUsd: number;
  /**
   * Maximum spread (in dollars / price units) at which a maker quote
   * still qualifies for rewards. Polymarket exposes this in cents
   * (e.g. 3.5 = 3.5¢); we normalize to the same unit as everything
   * else (0.035). Null when not set.
   */
  readonly rewardsMaxSpread: number | null;
  /** Minimum quote size (shares) to qualify for rewards. Null when not set. */
  readonly rewardsMinSize: number | null;
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
 *
 * Note: there is no top-level `category` field. Markets sit under an
 * `events[]` entry that has `ticker` / `title` / `slug`; we use the
 * event slug as a poor-man's category label.
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
  events?: ReadonlyArray<{ slug?: string; ticker?: string; title?: string }>;
  // Rewards fields (per CLOB rewards program). Markets without an active
  // rewards program omit these or set rewardsDailyRate to 0.
  clobRewards?: ReadonlyArray<{
    rewardsDailyRate?: number;
    rewards_daily_rate?: number;
  }>;
  rewardsMinSize?: number;
  rewards_min_size?: number;
  rewardsMaxSpread?: number;
  rewards_max_spread?: number;
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
  let totalFetched = 0;
  let droppedNormalize = 0;
  const droppedBy: Record<string, number> = {
    category: 0,
    minVolume: 0,
    minDays: 0,
    minSpread: 0,
    maxSpread: 0,
    requireRewards: 0,
    questionRegex: 0,
  };

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
    totalFetched += arr.length;

    for (const raw of arr) {
      const m = normalize(raw);
      if (!m) {
        droppedNormalize += 1;
        continue;
      }
      const reason = firstFailingFilter(m, opts.filters, now);
      if (reason) {
        droppedBy[reason] = (droppedBy[reason] ?? 0) + 1;
        continue;
      }
      out.push(m);
    }

    if (arr.length < pageSize) break;
  }

  out.sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  const truncated = out.slice(0, limit);

  opts.logger.info(
    {
      totalFetched,
      droppedNormalize,
      droppedBy,
      passedFilters: out.length,
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

  // /markets has no `category` field. Use the parent event's slug or
  // ticker as a coarse label so users can still filter (e.g. include
  // "what-will-happen-before-gta-vi", exclude "us-recession-2026").
  const category =
    raw.category ??
    raw.events?.[0]?.slug ??
    raw.events?.[0]?.ticker ??
    'other';

  // Sum across reward streams. Each stream may be denominated differently
  // (e.g., one for YES token rewards, one for NO). For our purposes,
  // total daily $ at stake is what matters.
  let rewardsDailyRateUsd = 0;
  for (const r of raw.clobRewards ?? []) {
    const rate = r.rewardsDailyRate ?? r.rewards_daily_rate ?? 0;
    if (typeof rate === 'number' && Number.isFinite(rate)) rewardsDailyRateUsd += rate;
  }

  // Polymarket exposes rewardsMaxSpread in cents (e.g. 3.5). Normalize
  // to price units (0.035) to match everything else in the codebase.
  const maxSpreadCents = raw.rewardsMaxSpread ?? raw.rewards_max_spread;
  const rewardsMaxSpread =
    typeof maxSpreadCents === 'number' && Number.isFinite(maxSpreadCents)
      ? maxSpreadCents / 100
      : null;

  const minSizeRaw = raw.rewardsMinSize ?? raw.rewards_min_size;
  const rewardsMinSize =
    typeof minSizeRaw === 'number' && Number.isFinite(minSizeRaw) ? minSizeRaw : null;

  return {
    conditionId,
    question: raw.question ?? '',
    category,
    endDate,
    volume24hUsd,
    spread,
    rewardsDailyRateUsd,
    rewardsMaxSpread,
    rewardsMinSize,
  };
}

/**
 * Returns the name of the first filter the market fails, or null if it
 * passes everything. Used both for filtering and for reject-reason
 * counters in the discovery summary log.
 */
type FilterReason =
  | 'category'
  | 'minVolume'
  | 'minDays'
  | 'minSpread'
  | 'maxSpread'
  | 'requireRewards'
  | 'questionRegex';

function firstFailingFilter(
  m: DiscoveredMarket,
  f: DiscoveryFilters,
  now: Date,
): FilterReason | null {
  if (f.categories && f.categories.length > 0) {
    const wantedLower = f.categories.map((c) => c.toLowerCase());
    if (!wantedLower.includes(m.category.toLowerCase())) return 'category';
  }
  if (typeof f.minVolume24hUsd === 'number' && m.volume24hUsd < f.minVolume24hUsd) {
    return 'minVolume';
  }
  if (typeof f.minDaysToResolution === 'number') {
    const daysOut = (m.endDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    if (daysOut < f.minDaysToResolution) return 'minDays';
  }
  if (typeof f.minSpread === 'number') {
    if (m.spread === null || m.spread < f.minSpread) return 'minSpread';
  }
  if (typeof f.maxSpread === 'number') {
    if (m.spread === null || m.spread > f.maxSpread) return 'maxSpread';
  }
  if (f.requireRewards === true && m.rewardsDailyRateUsd <= 0) {
    return 'requireRewards';
  }
  if (f.questionRegex && !f.questionRegex.test(m.question)) {
    return 'questionRegex';
  }
  return null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '<unreadable body>';
  }
}
