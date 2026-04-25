import type { Order, OrderId, OrderRequest, Fill } from '../domain/order.js';
import type { Position } from '../domain/portfolio.js';

export interface ExecutionVenue {
  placeOrder(req: OrderRequest): Promise<Order>;
  cancelOrder(id: OrderId): Promise<void>;
  cancelAll(): Promise<void>;
  getOpenOrders(): Promise<readonly Order[]>;
  getPositions(): Promise<readonly Position[]>;
  onFill(handler: (fill: Fill) => void): void;
  onOrderUpdate(handler: (order: Order) => void): void;
}
