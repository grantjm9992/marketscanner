import { price, size } from '../domain/money.js';
import type { Logger } from '../logging/logger.js';
import type { WalletTrade, WalletTradeFeed } from './wallet-trade-feed.js';

export type Fetcher = (url: string) => Promise<Response>;

export interface PolymarketWalletTradeFeedOptions {
  /**
   * Polymarket Data API host. Default is the public endpoint.
   * Override for tests / staging.
   */
  readonly dataApiHost?: string;
  /** Initial watchlist (lowercased Polygon addresses). */
  readonly wallets: readonly string[];
  /** Poll interval per wallet in milliseconds. Default 5000ms. */
  readonly pollIntervalMs?: number;
  /** Trades older than this are dropped on the first poll for a wallet. */
  readonly initialLookbackMs?: number;
  readonly logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetcher?: Fetcher;
}

interface RawTrade {
  // Defensive: the public Data API mixes shapes across endpoints / versions.
  // Try several keys before giving up.
  transactionHash?: string;
  transaction_hash?: string;
  proxyWallet?: string;
  proxy_wallet?: string;
  bot?: string;
  pseudonym?: string;
  market?: string;
  conditionId?: string;
  condition_id?: string;
  asset?: string;
  asset_id?: string;
  asset_address?: string;
  side?: 'BUY' | 'SELL' | 'buy' | 'sell';
  price?: string | number;
  size?: string | number;
  timestamp?: string | number;
  match_time?: string | number;
}

/**
 * Polls Polymarket's public Data API once per `pollIntervalMs` per
 * watched wallet. Tracks the most recent timestamp seen per wallet so
 * follow-up polls only return new trades. Per-trade dedup uses the tx
 * hash (or whatever `tradeId` shape the API returns).
 *
 * No automated tests against the live API — the fetcher is injected for
 * tests; production uses global fetch.
 */
export class PolymarketWalletTradeFeed implements WalletTradeFeed {
  private readonly host: string;
  private readonly intervalMs: number;
  private readonly initialLookbackMs: number;
  private readonly fetcher: Fetcher;
  private readonly logger: Logger;
  private readonly handlers: Array<(t: WalletTrade) => void> = [];
  private readonly errorHandlers: Array<(e: Error) => void> = [];
  private readonly watchlist = new Set<string>();
  private readonly seenTradeIds = new Set<string>();
  private readonly lastSeenTsByWallet = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(opts: PolymarketWalletTradeFeedOptions) {
    this.host = (opts.dataApiHost ?? 'https://data-api.polymarket.com').replace(/\/$/, '');
    this.intervalMs = opts.pollIntervalMs ?? 5_000;
    this.initialLookbackMs = opts.initialLookbackMs ?? 60_000;
    this.fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
    this.logger = opts.logger;
    for (const w of opts.wallets) this.watchlist.add(w.toLowerCase());
  }

  async watch(addresses: readonly string[]): Promise<void> {
    for (const a of addresses) this.watchlist.add(a.toLowerCase());
  }

  async unwatch(addresses: readonly string[]): Promise<void> {
    for (const a of addresses) this.watchlist.delete(a.toLowerCase());
  }

  onTrade(handler: (trade: WalletTrade) => void): void {
    this.handlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    // Seed lastSeen so the first poll only emits trades after now - lookback.
    const seedTs = Date.now() - this.initialLookbackMs;
    for (const w of this.watchlist) this.lastSeenTsByWallet.set(w, seedTs);
    // Tick immediately, then on interval.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Single poll cycle. Public for testing; production callers use start().
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    for (const wallet of this.watchlist) {
      try {
        await this.pollOne(wallet);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.logger.error({ err: e, wallet }, 'wallet-trade-feed: poll failed');
        for (const h of this.errorHandlers) h(e);
      }
    }
  }

  private async pollOne(wallet: string): Promise<void> {
    const url = `${this.host}/trades?user=${wallet}&limit=100`;
    const res = await this.fetcher(url);
    if (!res.ok) {
      throw new Error(`Data API ${res.status} for ${wallet}: ${await safeText(res)}`);
    }
    const body = (await res.json()) as unknown;
    const arr = Array.isArray(body) ? (body as RawTrade[]) : [];
    if (arr.length === 0) return;

    const lastSeen = this.lastSeenTsByWallet.get(wallet) ?? 0;
    let maxTs = lastSeen;

    // The Data API typically returns newest-first; iterate oldest-first
    // so handlers see trades in chronological order.
    const sorted = [...arr].sort((a, b) => extractTs(a) - extractTs(b));
    for (const raw of sorted) {
      const trade = normalize(raw, wallet);
      if (!trade) continue;
      if (trade.timestamp.getTime() <= lastSeen) continue;
      if (this.seenTradeIds.has(trade.tradeId)) continue;
      this.seenTradeIds.add(trade.tradeId);
      maxTs = Math.max(maxTs, trade.timestamp.getTime());
      for (const h of this.handlers) h(trade);
    }
    this.lastSeenTsByWallet.set(wallet, maxTs);
  }
}

function extractTs(raw: RawTrade): number {
  const t = raw.timestamp ?? raw.match_time;
  if (typeof t === 'number') return t > 1e12 ? t : t * 1000;
  if (typeof t === 'string') {
    const n = Number(t);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  return 0;
}

function normalize(raw: RawTrade, wallet: string): WalletTrade | null {
  const marketId = raw.market ?? raw.conditionId ?? raw.condition_id;
  const tokenId = raw.asset ?? raw.asset_id ?? raw.asset_address;
  const sideRaw = raw.side;
  const sizeRaw = typeof raw.size === 'string' ? Number(raw.size) : raw.size;
  const priceRaw = typeof raw.price === 'string' ? Number(raw.price) : raw.price;
  const tradeId = raw.transactionHash ?? raw.transaction_hash ?? null;

  if (
    !marketId ||
    !tokenId ||
    !sideRaw ||
    typeof sizeRaw !== 'number' ||
    typeof priceRaw !== 'number' ||
    !tradeId
  ) {
    return null;
  }

  const ts = extractTs(raw);
  if (ts === 0) return null;

  const side = sideRaw.toUpperCase() === 'BUY' ? 'BUY' : 'SELL';

  // Gentle price clamp — the API has been seen returning prices fractionally
  // outside [0,1] from rounding. Skip rather than throw.
  if (priceRaw < 0 || priceRaw > 1) return null;
  if (sizeRaw <= 0) return null;

  return {
    walletAddress: wallet,
    marketId,
    tokenId,
    side,
    price: price(priceRaw),
    size: size(sizeRaw),
    timestamp: new Date(ts),
    tradeId,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '<unreadable body>';
  }
}
