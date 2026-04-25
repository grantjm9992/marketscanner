import WebSocket from 'ws';
import { price, size } from '../domain/money.js';
import type { OrderBook, PriceLevel } from '../domain/market.js';
import type { Logger } from '../logging/logger.js';
import type { MarketDataFeed } from './feed.js';

export interface PolymarketFeedOptions {
  readonly wsHost: string;
  /** Map of marketId (conditionId) -> tokenIds the feed should track. */
  readonly tokensByMarket: ReadonlyMap<string, readonly string[]>;
  readonly logger: Logger;
  readonly heartbeatMs?: number;
}

interface PolymarketBookMessage {
  event_type: 'book' | 'price_change' | 'tick_size_change' | string;
  asset_id: string;
  market: string;
  bids?: ReadonlyArray<{ price: string; size: string }>;
  asks?: ReadonlyArray<{ price: string; size: string }>;
  changes?: ReadonlyArray<{ price: string; side: 'BUY' | 'SELL'; size: string }>;
  timestamp?: string;
}

/**
 * Live Polymarket CLOB WebSocket feed.
 *
 * - Connects to wsHost/market.
 * - Subscribes to `book` and `price_change` channels for the configured
 *   asset (token) IDs.
 * - Reconnects with exponential backoff: 1s, 2s, 4s, ... cap 30s.
 * - Heartbeat: if no message arrives for `heartbeatMs` (default 30s),
 *   force a reconnect.
 *
 * NOT covered by automated tests — see README. Validate with the rollout
 * plan against the live CLOB.
 */
export class PolymarketFeed implements MarketDataFeed {
  private ws: WebSocket | null = null;
  private readonly bookHandlers: Array<(b: OrderBook) => void> = [];
  private readonly errorHandlers: Array<(e: Error) => void> = [];
  private readonly localBooks = new Map<string, MutableBook>(); // tokenId -> book state
  private readonly tokenToMarket = new Map<string, string>();
  private subscribed = new Set<string>();
  private reconnectAttempt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private stopped = false;

  constructor(private readonly opts: PolymarketFeedOptions) {
    for (const [marketId, tokens] of opts.tokensByMarket) {
      for (const t of tokens) this.tokenToMarket.set(t, marketId);
    }
  }

  onBookUpdate(handler: (book: OrderBook) => void): void {
    this.bookHandlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  async subscribe(marketIds: readonly string[]): Promise<void> {
    for (const m of marketIds) {
      const tokens = this.opts.tokensByMarket.get(m) ?? [];
      for (const t of tokens) this.subscribed.add(t);
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSubscribe();
  }

  async unsubscribe(marketIds: readonly string[]): Promise<void> {
    for (const m of marketIds) {
      const tokens = this.opts.tokensByMarket.get(m) ?? [];
      for (const t of tokens) this.subscribed.delete(t);
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
    this.startHeartbeat();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  // --- internals ---

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.wsHost);
    this.ws = ws;

    ws.on('open', () => {
      this.opts.logger.info('polymarket-feed: connected');
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      this.sendSubscribe();
    });

    ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      try {
        const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
        const parsed = JSON.parse(text) as PolymarketBookMessage | PolymarketBookMessage[];
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const msg of arr) this.handleMessage(msg);
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.on('error', (err: Error) => {
      this.emitError(err);
    });

    ws.on('close', () => {
      this.opts.logger.warn('polymarket-feed: disconnected');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.opts.logger.warn({ delayMs: delay }, 'polymarket-feed: reconnecting');
    setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat(): void {
    const interval = this.opts.heartbeatMs ?? 30_000;
    this.heartbeatTimer = setInterval(() => {
      if (this.lastMessageAt === 0) return;
      if (Date.now() - this.lastMessageAt > interval) {
        this.opts.logger.warn('polymarket-feed: heartbeat timeout, forcing reconnect');
        try {
          this.ws?.close();
        } catch {
          // ignore
        }
      }
    }, Math.max(1000, Math.floor(interval / 2)));
  }

  private sendSubscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const assetIds = [...this.subscribed];
    if (assetIds.length === 0) return;
    const msg = { type: 'market', assets_ids: assetIds };
    this.ws.send(JSON.stringify(msg));
    this.opts.logger.info({ assetIds }, 'polymarket-feed: subscribed');
  }

  private handleMessage(msg: PolymarketBookMessage): void {
    if (msg.event_type === 'book' && msg.bids && msg.asks) {
      this.applySnapshot(msg);
      this.emitBook(msg.asset_id);
      return;
    }
    if (msg.event_type === 'price_change' && msg.changes) {
      this.applyDelta(msg);
      this.emitBook(msg.asset_id);
      return;
    }
    // Other event types (tick_size_change, last_trade_price) are ignored
    // for now. Add handling as needed.
  }

  private applySnapshot(msg: PolymarketBookMessage): void {
    const tokenId = msg.asset_id;
    const marketId = msg.market || this.tokenToMarket.get(tokenId) || 'unknown';
    const book: MutableBook = {
      marketId,
      tokenId,
      bids: new Map(),
      asks: new Map(),
      timestamp: parseTs(msg.timestamp),
    };
    for (const b of msg.bids ?? []) book.bids.set(b.price, Number(b.size));
    for (const a of msg.asks ?? []) book.asks.set(a.price, Number(a.size));
    this.localBooks.set(tokenId, book);
  }

  private applyDelta(msg: PolymarketBookMessage): void {
    const book = this.localBooks.get(msg.asset_id);
    if (!book) {
      // No prior snapshot — wait for one. CLOB sends snapshots first.
      return;
    }
    book.timestamp = parseTs(msg.timestamp);
    for (const c of msg.changes ?? []) {
      const target = c.side === 'BUY' ? book.bids : book.asks;
      const sz = Number(c.size);
      if (sz === 0) target.delete(c.price);
      else target.set(c.price, sz);
    }
  }

  private emitBook(tokenId: string): void {
    const book = this.localBooks.get(tokenId);
    if (!book) return;
    const out: OrderBook = {
      marketId: book.marketId,
      tokenId: book.tokenId,
      bids: levelsFromMap(book.bids, 'desc'),
      asks: levelsFromMap(book.asks, 'asc'),
      timestamp: book.timestamp,
    };
    for (const h of this.bookHandlers) h(out);
  }

  private emitError(err: Error): void {
    this.opts.logger.error({ err }, 'polymarket-feed: error');
    for (const h of this.errorHandlers) h(err);
  }
}

interface MutableBook {
  readonly marketId: string;
  readonly tokenId: string;
  readonly bids: Map<string, number>;
  readonly asks: Map<string, number>;
  timestamp: Date;
}

function parseTs(s: string | undefined): Date {
  if (!s) return new Date();
  const n = Number(s);
  if (Number.isFinite(n)) return new Date(n);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function levelsFromMap(m: Map<string, number>, order: 'asc' | 'desc'): readonly PriceLevel[] {
  const arr = [...m.entries()].map(([p, s]) => ({ price: price(Number(p)), size: size(s) }));
  arr.sort((a, b) =>
    order === 'asc' ? (a.price as number) - (b.price as number) : (b.price as number) - (a.price as number),
  );
  return arr;
}
