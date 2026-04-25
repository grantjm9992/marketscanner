# polymarket-bot

A TypeScript prediction-market trading bot for Polymarket. Runs in three modes — `backtest`, `paper`, `live` — behind the same strategy code. Safety rails first, live trading last.

## What this is

- **Paper mode** with an honest fill simulator (latency, partial fills, walking the book, fees).
- **Live mode** that signs and submits real orders against the Polymarket CLOB.
- **Backtest mode** that replays previously recorded order-book snapshots.
- A SQLite-backed snapshot recorder so future backtests have data to replay.
- Hard risk limits (per-market size, total deployed, daily-loss kill switch) enforced outside strategy code.

## What this is not

- Not low-latency. We are not colocated and will not win races against pros.
- Not a full historical backtester — Polymarket doesn't expose deep historical book data. We record going forward.
- Not a UI. CLI + `pino` JSON logs + SQLite is all you get.

## Stack

- Node.js 20+, TypeScript strict (with `noUncheckedIndexedAccess`)
- pnpm
- `better-sqlite3` for storage (single file, sync API)
- `@polymarket/clob-client` for live execution
- `ws` for the market-data feed
- `zod` for env validation, `pino` for logs, `vitest` for tests

## Setup

```bash
pnpm install
cp .env.example .env
# Edit .env. For paper mode the defaults are fine. For live mode you must
# set POLYMARKET_PRIVATE_KEY.

mkdir -p data
```

### Choosing markets

Two paths — they compose, so you can use both at once.

**1. Hand-curated condition IDs** via `STRATEGY_MARKETS`:

```bash
STRATEGY_MARKETS=0x1234...,0x5678...
```

Find condition IDs at the Gamma API:

```bash
curl 'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20' \
  | jq '.[] | {conditionId, question, volume24hr, endDate}'
```

**2. Auto-discovery** via the Gamma filters (recommended for paper/live):

```bash
MARKET_DISCOVERY_ENABLED=true
MARKET_DISCOVERY_CATEGORIES=Sports,Politics
MARKET_DISCOVERY_MIN_VOLUME_USD=50000
MARKET_DISCOVERY_MIN_DAYS_TO_RESOLUTION=7
MARKET_DISCOVERY_MIN_SPREAD=0.02
MARKET_DISCOVERY_MAX_SPREAD=0.08
MARKET_DISCOVERY_LIMIT=5
```

At startup the bot queries Gamma, drops closed/archived/non-accepting
markets, applies the filters, sorts by 24h volume desc, and takes the
top `LIMIT`. Discovered IDs are merged with `STRATEGY_MARKETS` (no
duplicates), so you can pin a few favorites and let discovery fill the
rest.

## Running

### Paper mode (default — start here)

```bash
pnpm dev --mode paper --strategy wide-spread-market-maker
```

### Backtest

Replays `market_snapshot` rows from SQLite over a date range:

```bash
pnpm dev --mode backtest --from 2026-01-01 --to 2026-02-01
```

### Live mode

Requires a funded Polygon wallet with USDC and the private key in `POLYMARKET_PRIVATE_KEY`. The bot will print a config summary and force you to type `I UNDERSTAND` before it touches real money. This friction is deliberate.

```bash
pnpm dev --mode live --strategy wide-spread-market-maker
```

## Project layout

```
src/
  domain/         Pure types: money, market, order, portfolio. No I/O.
  strategy/       Strategy interface + concrete strategies.
  execution/      ExecutionVenue interface; simulated + Polymarket impls.
  marketdata/     MarketDataFeed interface; live + historical impls; snapshot recorder.
  risk/           RiskManager + RiskLimits. Kill switch lives here.
  persistence/    SQLite, migrations, repositories.
  engine/         Engine wiring; Clock abstraction.
  config/         Zod-validated config from env.
  logging/        Pino logger.
  main.ts         Composition root + CLI.
test/
  unit/           Per-module unit tests.
  integration/    End-to-end engine smoke tests.
```

## Design principles

1. **Strategies depend on interfaces, not implementations.** Mode is selected at the composition root in `main.ts`. Strategies don't know whether they're paper or live.
2. **Money is branded.** `Price`, `Size`, `Usd` are all `number` with brands. You cannot accidentally add a price to a size.
3. **Time is injected.** Every module that needs `now()` takes a `Clock`. Backtests use a `FakeClock` driven by replay events.
4. **No hidden I/O in domain types.** `domain/` is pure.
5. **Fail loud.** Unknown CLOB responses, risk-limit breaches, and bad config halt the engine instead of being swallowed.
6. **The kill switch is sticky.** Once tripped, only a restart clears it.

## The simulator

`src/execution/simulated-venue.ts` is the single most important file in this repo. The rules it enforces:

- Market orders cross the spread; they walk the book if size exceeds top-level depth.
- Limit orders only fill when the opposite book crosses them.
- Partial fills are the default.
- A configurable latency (default 250ms) is added between `placeOrder()` and fill eligibility.
- Fees come from `fees.ts` — even when zero, they go through the abstraction.
- `avgFillPrice` is the size-weighted average across walked levels.

If a strategy looks like it's printing money in paper mode, **the default assumption is that there's a bug here**, not that you've found alpha.

## Rollout plan (do not skip)

1. Build and run in paper mode until the simulator has been clean for days.
2. Enable `RECORD_SNAPSHOTS=true` and let it run for at least two weeks before trusting any backtest result.
3. First live run: $20 USDC, one market, one hour, watched. You're testing auth + signing + the order pipeline, not the strategy.
4. Scale to $100 overnight. Audit the trade log in the morning.
5. Only then consider scaling. If live PnL diverges meaningfully from paper under the same conditions, **stop and find out why**.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run the bot via `tsx`. |
| `pnpm build` | Compile TS to `dist/`. |
| `pnpm start` | Run the compiled output. |
| `pnpm test` | Run vitest. |
| `pnpm lint` | ESLint. |
| `pnpm typecheck` | `tsc --noEmit`. |

## Manual-test-only modules

- `src/execution/polymarket-venue.ts` — talks to the real CLOB. No automated tests because they require credentials and live markets. Test with the rollout plan above.
- `src/marketdata/polymarket-feed.ts` — same.

Everything else has unit or integration coverage.
