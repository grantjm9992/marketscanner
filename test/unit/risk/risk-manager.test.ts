import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultRiskManager } from '../../../src/risk/risk-manager.js';
import type { RiskContext } from '../../../src/risk/risk-manager.js';
import type { RiskLimits } from '../../../src/risk/limits.js';
import { price, size, usd } from '../../../src/domain/money.js';
import { FakeClock } from '../../../src/engine/clock.js';
import { createLogger } from '../../../src/logging/logger.js';
import type { Signal } from '../../../src/strategy/signal.js';
import { orderId } from '../../../src/domain/order.js';
import type { Fill, Order } from '../../../src/domain/order.js';
import type { Position } from '../../../src/domain/portfolio.js';

const limits: RiskLimits = {
  maxPositionSizeUsd: usd(100),
  maxTotalDeployedUsd: usd(200),
  maxDailyLossUsd: usd(50),
  maxOrdersPerMinute: 5,
  perMarketCooldownMs: 60_000,
  maxOpenOrdersPerMarket: 2,
};

function makeManager() {
  const clock = new FakeClock(new Date('2026-01-01T12:00:00Z'));
  const logger = createLogger({ level: 'silent' });
  return { mgr: new DefaultRiskManager({ limits, clock, logger }), clock };
}

const placeBuy = (s: number, p = 0.5, marketId = 'm1'): Signal => ({
  kind: 'PLACE_ORDER',
  request: {
    marketId,
    tokenId: 't1',
    side: 'BUY',
    type: 'LIMIT',
    size: size(s),
    limitPrice: price(p),
    clientOrderId: `c${Math.random()}`,
  },
});

const emptyCtx: RiskContext = { positions: [], openOrders: [] };

describe('DefaultRiskManager', () => {
  let h: ReturnType<typeof makeManager>;
  beforeEach(() => {
    h = makeManager();
  });

  it('approves a normal order', () => {
    const d = h.mgr.approve(placeBuy(50), emptyCtx);
    expect(d.approved).toBe(true);
  });

  it('always approves cancels (even when halted)', () => {
    h.mgr.halt('test');
    const d = h.mgr.approve(
      { kind: 'CANCEL_ORDER', orderId: orderId('o1') },
      emptyCtx,
    );
    expect(d.approved).toBe(true);
  });

  it('rejects when halted', () => {
    h.mgr.halt('manual');
    const d = h.mgr.approve(placeBuy(10), emptyCtx);
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toMatch(/halted/);
  });

  it('rejects when projected market notional exceeds maxPositionSizeUsd', () => {
    // 250 shares * 0.5 = 125 > 100
    const d = h.mgr.approve(placeBuy(250), emptyCtx);
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toMatch(/maxPositionSizeUsd/);
  });

  it('rejects when projected total exceeds maxTotalDeployedUsd', () => {
    // Existing m2 position: 350 shares * 0.5 = $175. Per-market m1 check
    // sees 0 existing on m1 + new $50 = $50 (under the $100 cap), so the
    // only thing that can fail is the total cap of $200: 175 + 50 = 225.
    const positions: Position[] = [
      {
        marketId: 'm2',
        tokenId: 't2',
        size: size(350),
        avgEntryPrice: price(0.5),
        realizedPnlUsd: usd(0),
      },
    ];
    const d = h.mgr.approve(placeBuy(100, 0.5, 'm1'), { positions, openOrders: [] });
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toMatch(/maxTotalDeployedUsd/);
  });

  it('rejects when too many open orders for a market', () => {
    const orders: Order[] = [
      makeOpenOrder('a', 'm1'),
      makeOpenOrder('b', 'm1'),
    ];
    const d = h.mgr.approve(placeBuy(10), { positions: [], openOrders: orders });
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toMatch(/max open orders/);
  });

  it('enforces order-rate limit per minute', () => {
    for (let i = 0; i < 5; i++) {
      expect(h.mgr.approve(placeBuy(10), emptyCtx).approved).toBe(true);
    }
    const sixth = h.mgr.approve(placeBuy(10), emptyCtx);
    expect(sixth.approved).toBe(false);
    if (!sixth.approved) expect(sixth.reason).toMatch(/rate limit/);
  });

  it('order-rate window slides', () => {
    for (let i = 0; i < 5; i++) {
      h.mgr.approve(placeBuy(10), emptyCtx);
    }
    h.clock.advance(60_001);
    expect(h.mgr.approve(placeBuy(10), emptyCtx).approved).toBe(true);
  });

  it('per-market cooldown after a loss blocks new orders', () => {
    h.mgr.recordRealizedPnl(usd(-5), 'm1');
    const d = h.mgr.approve(placeBuy(10), emptyCtx);
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toMatch(/cooldown/);

    // Other markets still fine.
    expect(h.mgr.approve(placeBuy(10, 0.5, 'm2'), emptyCtx).approved).toBe(true);

    h.clock.advance(60_001);
    expect(h.mgr.approve(placeBuy(10), emptyCtx).approved).toBe(true);
  });

  it('trips kill switch when daily loss exceeds max', () => {
    h.mgr.recordRealizedPnl(usd(-30), 'm1');
    expect(h.mgr.isHalted()).toBe(false);
    h.mgr.recordRealizedPnl(usd(-25), 'm2');
    expect(h.mgr.isHalted()).toBe(true);
    expect(h.mgr.haltReason()).toMatch(/daily loss/);
  });

  it('kill switch is sticky — stays tripped even after profits', () => {
    h.mgr.recordRealizedPnl(usd(-60), 'm1');
    expect(h.mgr.isHalted()).toBe(true);
    h.mgr.recordRealizedPnl(usd(1000), 'm1');
    expect(h.mgr.isHalted()).toBe(true);
    expect(h.mgr.approve(placeBuy(10, 0.5, 'm2'), emptyCtx).approved).toBe(false);
  });

  it('halt() with reason is captured and reported', () => {
    h.mgr.halt('manual stop');
    expect(h.mgr.isHalted()).toBe(true);
    expect(h.mgr.haltReason()).toBe('manual stop');
    // Calling halt again is a no-op on the reason.
    h.mgr.halt('another');
    expect(h.mgr.haltReason()).toBe('manual stop');
  });

  it('fees alone do not normally trip the switch', () => {
    h.mgr.onFill({
      orderId: orderId('o1'),
      marketId: 'm1',
      tokenId: 't1',
      side: 'BUY',
      price: price(0.5),
      size: size(10),
      feeUsd: usd(0.05),
      timestamp: new Date(),
    });
    expect(h.mgr.isHalted()).toBe(false);
  });

  it('daily key rolls over at midnight UTC', () => {
    h.mgr.recordRealizedPnl(usd(-40), 'm1');
    expect(h.mgr.isHalted()).toBe(false);
    h.clock.set(new Date('2026-01-02T00:00:01Z'));
    // Next loss is on the new day; kill switch only trips when *today's*
    // loss exceeds the limit.
    h.mgr.recordRealizedPnl(usd(-30), 'm1');
    expect(h.mgr.isHalted()).toBe(false);
  });
});

function makeOpenOrder(id: string, marketId: string): Order {
  return {
    id: orderId(id),
    marketId,
    tokenId: 't1',
    side: 'BUY',
    type: 'LIMIT',
    size: size(10),
    limitPrice: price(0.5),
    clientOrderId: id,
    status: 'OPEN',
    filledSize: size(0),
    avgFillPrice: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function _unused(_f: Fill): void {
  // Keep Fill imported for type-checking even if not used in every test.
}
