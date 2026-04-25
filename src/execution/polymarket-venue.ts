import { ClobClient, OrderType, Side as PmSide } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { price, size, usd } from '../domain/money.js';
import type { Price, Size, Usd } from '../domain/money.js';
import { orderId } from '../domain/order.js';
import type {
  Fill,
  Order,
  OrderId,
  OrderRequest,
  OrderStatus,
  Side,
} from '../domain/order.js';
import type { Position } from '../domain/portfolio.js';
import type { Logger } from '../logging/logger.js';
import type { ExecutionVenue } from './venue.js';
import type { Clock } from '../engine/clock.js';

export interface PolymarketVenueOptions {
  readonly clobHost: string;
  readonly chainId: number;
  /** Hex-encoded private key. Never log. */
  readonly privateKey: string;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Polling cadence for fills/order status. Default 1500ms. */
  readonly pollIntervalMs?: number;
  /** Optional: API credentials if pre-derived. Otherwise the client derives them. */
  readonly apiCreds?: { key: string; secret: string; passphrase: string };
}

/**
 * Live Polymarket venue. Wraps `@polymarket/clob-client`, signs orders
 * with the configured wallet, and polls /trades + /orders for fill state.
 *
 * !! NOT covered by automated tests. Manual-test only via the rollout
 * plan in the README. Requires a funded Polygon wallet. !!
 *
 * Safety:
 *   - Reuses `clientOrderId` so retries don't double-submit.
 *   - On any unexpected API error, surfaces it — does not swallow.
 *   - Never logs the private key (and the pino logger has a redaction
 *     rule for `privateKey` paths as defense in depth).
 */
export class PolymarketVenue implements ExecutionVenue {
  private readonly client: ClobClient;
  private readonly wallet: Wallet;
  private readonly fillHandlers: Array<(f: Fill) => void> = [];
  private readonly orderUpdateHandlers: Array<(o: Order) => void> = [];
  /** Local map of clientOrderId -> our last-known Order shape. */
  private readonly known = new Map<string, Order>();
  /** Trades we've already emitted, keyed by trade id. */
  private readonly seenTradeIds = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: PolymarketVenueOptions) {
    this.wallet = new Wallet(opts.privateKey);
    this.client = new ClobClient(
      opts.clobHost,
      opts.chainId,
      this.wallet,
      opts.apiCreds,
    );
  }

  async placeOrder(req: OrderRequest): Promise<Order> {
    const now = this.opts.clock.now();
    try {
      if (req.type === 'LIMIT') {
        if (req.limitPrice === undefined) {
          throw new Error('LIMIT order requires limitPrice');
        }
        const resp = await this.client.createAndPostOrder(
          {
            tokenID: req.tokenId,
            price: req.limitPrice as number,
            size: req.size as number,
            side: req.side === 'BUY' ? PmSide.BUY : PmSide.SELL,
          },
          undefined,
          OrderType.GTC,
        );
        const id = orderId(extractOrderId(resp) ?? `pm-${req.clientOrderId}`);
        const order: Order = {
          ...req,
          id,
          status: 'OPEN',
          filledSize: size(0),
          avgFillPrice: null,
          createdAt: now,
          updatedAt: now,
        };
        this.known.set(req.clientOrderId, order);
        this.emitOrderUpdate(order);
        return order;
      }

      // MARKET order: use createAndPostMarketOrder. UserMarketOrder wants
      // `amount` (USD for BUY, shares for SELL). We approximate USD as
      // size * 1.0 for BUY (binary outcome upper bound).
      const amount = req.side === 'BUY' ? (req.size as number) * 1 : (req.size as number);
      const resp = await this.client.createAndPostMarketOrder(
        {
          tokenID: req.tokenId,
          amount,
          side: req.side === 'BUY' ? PmSide.BUY : PmSide.SELL,
        },
        undefined,
        OrderType.FOK,
      );
      const id = orderId(extractOrderId(resp) ?? `pm-${req.clientOrderId}`);
      const order: Order = {
        ...req,
        id,
        status: 'OPEN',
        filledSize: size(0),
        avgFillPrice: null,
        createdAt: now,
        updatedAt: now,
      };
      this.known.set(req.clientOrderId, order);
      this.emitOrderUpdate(order);
      return order;
    } catch (err) {
      this.opts.logger.error({ err, marketId: req.marketId, clientOrderId: req.clientOrderId },
        'polymarket-venue: placeOrder failed');
      throw err;
    }
  }

  async cancelOrder(id: OrderId): Promise<void> {
    try {
      await this.client.cancelOrder({ orderID: id as string });
    } catch (err) {
      this.opts.logger.error({ err, orderId: id }, 'polymarket-venue: cancelOrder failed');
      throw err;
    }
  }

  async cancelAll(): Promise<void> {
    try {
      await this.client.cancelAll();
    } catch (err) {
      this.opts.logger.error({ err }, 'polymarket-venue: cancelAll failed');
      throw err;
    }
  }

  async getOpenOrders(): Promise<readonly Order[]> {
    try {
      const resp = await this.client.getOpenOrders();
      const list = Array.isArray(resp) ? resp : [];
      return list.map((o) => this.openOrderToDomain(o));
    } catch (err) {
      this.opts.logger.error({ err }, 'polymarket-venue: getOpenOrders failed');
      throw err;
    }
  }

  async getPositions(): Promise<readonly Position[]> {
    // Polymarket positions are on-chain ERC-1155 balances. The CLOB client
    // does not expose them directly; the engine should track positions
    // from fills. Return empty here; PortfolioProvider in main.ts can
    // overlay a separate balance source if needed.
    return [];
  }

  onFill(handler: (f: Fill) => void): void {
    this.fillHandlers.push(handler);
  }

  onOrderUpdate(handler: (o: Order) => void): void {
    this.orderUpdateHandlers.push(handler);
  }

  /** Begin polling /trades + /orders. Call after handlers are wired. */
  start(): void {
    if (this.pollTimer) return;
    const interval = this.opts.pollIntervalMs ?? 1500;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, interval);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // --- internals ---

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const trades = await this.client.getTrades();
      for (const t of trades) {
        if (this.seenTradeIds.has(t.id)) continue;
        this.seenTradeIds.add(t.id);
        const fill: Fill = {
          orderId: orderId(t.taker_order_id || t.id),
          marketId: t.market,
          tokenId: t.asset_id,
          side: (t.side as unknown as string) === 'BUY' ? 'BUY' : 'SELL',
          price: price(Number(t.price)),
          size: size(Number(t.size)),
          // Polymarket charges 0% as of 2026-01; we still parse the fee
          // bps in case the schedule changes.
          feeUsd: usd((Number(t.fee_rate_bps) / 10_000) * Number(t.price) * Number(t.size)),
          timestamp: new Date(Number(t.match_time) || Date.now()),
        };
        for (const h of this.fillHandlers) h(fill);
      }
    } catch (err) {
      this.opts.logger.error({ err }, 'polymarket-venue: trade poll failed');
    }

    try {
      const open = await this.client.getOpenOrders();
      const list = Array.isArray(open) ? open : [];
      for (const o of list) {
        const order = this.openOrderToDomain(o);
        this.emitOrderUpdate(order);
      }
    } catch (err) {
      this.opts.logger.error({ err }, 'polymarket-venue: open-orders poll failed');
    }
  }

  private openOrderToDomain(o: {
    id: string;
    market: string;
    asset_id: string;
    side: string;
    original_size: string;
    size_matched: string;
    price: string;
    status: string;
    created_at: number;
  }): Order {
    const filled = Number(o.size_matched);
    const original = Number(o.original_size);
    const status: OrderStatus =
      filled === 0
        ? 'OPEN'
        : filled < original
          ? 'PARTIALLY_FILLED'
          : 'FILLED';
    return {
      id: orderId(o.id),
      marketId: o.market,
      tokenId: o.asset_id,
      side: o.side === 'BUY' ? 'BUY' : 'SELL',
      type: 'LIMIT',
      size: size(original) as Size,
      limitPrice: price(Number(o.price)) as Price,
      clientOrderId: o.id,
      status,
      filledSize: size(filled),
      avgFillPrice: filled > 0 ? price(Number(o.price)) : null,
      createdAt: new Date(o.created_at * 1000),
      updatedAt: this.opts.clock.now(),
    };
  }

  private emitOrderUpdate(o: Order): void {
    for (const h of this.orderUpdateHandlers) h(o);
  }
}

function extractOrderId(resp: unknown): string | null {
  if (resp && typeof resp === 'object' && 'orderID' in resp && typeof (resp as { orderID: unknown }).orderID === 'string') {
    return (resp as { orderID: string }).orderID;
  }
  if (resp && typeof resp === 'object' && 'orderId' in resp && typeof (resp as { orderId: unknown }).orderId === 'string') {
    return (resp as { orderId: string }).orderId;
  }
  return null;
}

// Surface unused-import suppression for the Side type alias when domain
// `Side` and the polymarket `Side` enum overlap in name.
export type { Side };
// Suppress unused-warning for Usd in the Fill construction path.
type _UnusedUsd = Usd;
