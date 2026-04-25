import type { Price, Size, Usd } from './money.js';

export type OrderId = string & { readonly __brand: 'OrderId' };

export function orderId(s: string): OrderId {
  if (s.length === 0) throw new Error('OrderId must be non-empty');
  return s as OrderId;
}

export type Side = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET';

export type OrderStatus = 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'REJECTED';

export interface OrderRequest {
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: Side;
  readonly type: OrderType;
  readonly size: Size;
  readonly limitPrice?: Price;
  readonly clientOrderId: string;
}

export interface Order extends OrderRequest {
  readonly id: OrderId;
  readonly status: OrderStatus;
  readonly filledSize: Size;
  readonly avgFillPrice: Price | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Fill {
  readonly orderId: OrderId;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: Side;
  readonly price: Price;
  readonly size: Size;
  readonly feeUsd: Usd;
  readonly timestamp: Date;
}
