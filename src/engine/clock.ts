export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Test/backtest clock. Time only moves when explicitly advanced.
 */
export class FakeClock implements Clock {
  private current: Date;

  constructor(initial: Date) {
    this.current = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error('FakeClock.advance: ms must be non-negative');
    this.current = new Date(this.current.getTime() + ms);
  }

  set(d: Date): void {
    if (d.getTime() < this.current.getTime()) {
      throw new Error('FakeClock.set: cannot move time backwards');
    }
    this.current = new Date(d.getTime());
  }
}
