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

## Strategies

Three are bundled. Pick one via `STRATEGY_NAME` in `.env`.

### `wide-spread-market-maker` (default)

A passive maker. Posts BUY at `bestBid+tick` and SELL at `bestAsk-tick`, sized at `quoteSize`. Uses hysteresis + minimum quote lifetime to avoid millisecond-scale churn. Doesn't hunt edges; provides liquidity and tries to earn the spread. Useful as a pipeline validator and as a baseline.

### `smart-money-follower`

An aggressive taker. Subscribes to a curated watchlist of Polygon wallet addresses via Polymarket's public Data API. When a watched wallet places a trade above `SMART_MONEY_MIN_SOURCE_USD` notional, the strategy buffers the signal, then on the next book update for that market emits a same-side LIMIT (or MARKET) for `SMART_MONEY_COPY_USD`, gated by:

- **freshness** — drops signals older than `SMART_MONEY_MAX_AGE_MS`,
- **drift** — skips if the book has moved more than `SMART_MONEY_MAX_DRIFT_CENTS` from the source price,
- **per-(wallet × market) cooldown** so one chatty wallet doesn't dominate the order rate.

Critical caveats:

1. **Wallet selection is the entire edge.** Don't paste the leaderboard. Filter by *realized* PnL on closed positions, not by rank. The Hermes-style trap (`rn1`) shows that $2.68M of unrealized losses can sit behind a top-7 ranking.
2. **This is conviction stacking, not latency arbitrage.** By the time the Data API surfaces a trade you're 5–30s behind. Don't expect to get the same fill price the smart wallet got.
3. **PnL must be tracked separately** from any maker strategy — they have opposite risk profiles. Don't blend their numbers.

Run with both, in parallel, in two separate processes pointing at the same Postgres if you want side-by-side comparison.

### `rewarded-market-maker`

A maker tuned to qualify for Polymarket's CLOB rewards program. Same shape as WSMM but with two key differences:

1. **Quotes near mid, not at the touch.** Posts BUY at `max(bestBid+tick, mid - rewardsMaxSpread + safety)` and the symmetric SELL. The goal is to sit inside the `rewardsMaxSpread` band so the daily rewards subsidy applies.
2. **Quote size = `max(fallbackQuoteSize, market.rewards.minSize)`.** Polymarket only counts qualifying makers above `minSize`.

Edge model: `rewards $/day × your share of qualifying volume − adverse-selection cost`. The first term is structurally positive — you're paid to post quotes regardless of fill PnL. The second term is the same predator that eats every maker. Whether the net is positive depends on how crowded the rewarded markets are with other makers.

Two non-obvious things to know:
- This strategy **does nothing on markets without rewards data**. Always pair with `MARKET_DISCOVERY_REQUIRE_REWARDS=true` so discovery only surfaces qualifying markets.
- It quotes near-mid, which is *more* adversely-selected than WSMM. Don't be surprised if fill PnL is worse than WSMM on the same markets — the rewards drip is supposed to make up the difference. Track both PnL and accumulated rewards separately to know if it's working.

## Inspecting the running bot

The trade log, snapshots, positions, and daily P&L go into either SQLite (default, single file at `./data/bot.db`) or Postgres (set `DATABASE_KIND=postgres` and `DATABASE_URL=...`). Same store interface either way; same queries work against both.

See [`docs/sql-queries.md`](./docs/sql-queries.md) for a reference of useful queries — health checks, fills, P&L, slippage sanity checks, and live watch loops. See [`docs/deployment.md`](./docs/deployment.md) for Railway deployment with managed Postgres.

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
