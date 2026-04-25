import type { OrderId, OrderRequest } from '../domain/order.js';

export type Signal =
  | { readonly kind: 'PLACE_ORDER'; readonly request: OrderRequest }
  | { readonly kind: 'CANCEL_ORDER'; readonly orderId: OrderId };
