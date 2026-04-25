# Deploying on Railway

This bot is a long-running worker. On Railway:

1. **Service** — the bot process (this repo).
2. **Postgres plugin** — attached to the service so the trade log, snapshots, positions, and daily P&L survive deploys.

No HTTP endpoint, no health check. Railway restarts the process if it exits.

## One-time setup

1. **Create the project.** New project → Deploy from GitHub repo → pick this repo / branch.

2. **Add Postgres.** From the project canvas, "+ New" → Database → PostgreSQL. Wait for it to provision.

3. **Reference the database URL.** Click your bot service → Variables → "+ New Variable" → use the **reference** picker to pull `DATABASE_URL` from the Postgres service. The variable value should look like `${{ Postgres.DATABASE_URL }}` so it's auto-injected at deploy time.

4. **Set the rest of the env vars.** Either paste them one at a time or use the "Raw editor":

```env
MODE=paper
DATABASE_KIND=postgres
DATABASE_URL=${{ Postgres.DATABASE_URL }}
DATABASE_SSL=true

POLYMARKET_CLOB_HOST=https://clob.polymarket.com
POLYMARKET_WS_HOST=wss://ws-subscriptions-clob.polymarket.com/ws/market

RISK_MAX_POSITION_USD=100
RISK_MAX_TOTAL_DEPLOYED_USD=500
RISK_MAX_DAILY_LOSS_USD=50

STRATEGY_NAME=wide-spread-market-maker
STRATEGY_MARKETS=

MARKET_DISCOVERY_ENABLED=true
MARKET_DISCOVERY_MIN_VOLUME_USD=5000
MARKET_DISCOVERY_MIN_SPREAD=0.01
MARKET_DISCOVERY_MAX_SPREAD=0.10
MARKET_DISCOVERY_LIMIT=5

LOG_LEVEL=info
```

For live mode, additionally set `MODE=live` and `POLYMARKET_PRIVATE_KEY=0x...`. Railway treats the latter as a secret if you mark it as one.

5. **Deploy.** First deploy may take 2–3 min (Nixpacks pulls Node 20 + pnpm and compiles `better-sqlite3`'s native module — even though we're not using it, the dep is installed). Subsequent deploys cache.

6. **Verify.** Open the service → Logs. You should see:
   ```
   main: starting             mode=paper strategy=wide-spread-market-maker
   main: stores opened        kind=postgres
   market-discovery: complete totalFetched=500 selected=5 ...
   engine: started
   polymarket-feed: connected
   ```

## Connecting from your laptop to query the DB

The Postgres service exposes a public URL — open the Postgres service in Railway and copy the connection string. Plug it into TablePlus / DataGrip / `psql`:

```bash
psql 'postgres://postgres:PASSWORD@host.railway.app:PORT/railway?sslmode=require'
```

All the queries in [`docs/sql-queries.md`](./sql-queries.md) work against Postgres unmodified. (The Postgres `jsonb` columns let you use the same `json_extract`-style access — though in PG it's `payload_json->>'reason'` instead of `json_extract(payload_json, '$.reason')`. See the Postgres notes in the queries file.)

## Switching back to SQLite locally

`.env` for local dev:

```env
DATABASE_KIND=sqlite
DATABASE_PATH=./data/bot.db
```

Same code path, same store interfaces.

## Cost guidance

For this bot, default Railway tiers are way more than enough:

- Bot service: trivial CPU/RAM (one Node process).
- Postgres: a few MB/day of inserts. The starter Postgres plan is plenty for months.

Watch the snapshot table — it's the largest table by far. After a few months you may want a periodic `DELETE FROM market_snapshot WHERE timestamp < NOW() - INTERVAL '90 days'` cron, or partition by month. Not urgent.

## Known gotchas

- **`POLYMARKET_PRIVATE_KEY` should never appear in plain logs.** The Pino logger redacts it, but if you paste it into a log line yourself you'll leak it. Don't.
- **Railway environment changes don't trigger a rebuild — only a restart.** New env vars take effect on next deploy or after manually restarting the service.
- **`MODE=live` over Railway** needs the `LIVE_CONFIRM` env var. Railway has no TTY, so the interactive `I UNDERSTAND` prompt would hang. Set `LIVE_CONFIRM=I UNDERSTAND` as a separate env var (mark as secret) to satisfy the gate headlessly. The wallet address and risk caps still print to logs at startup, so you can still confirm what the bot's about to do.
