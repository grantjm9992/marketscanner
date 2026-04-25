# SQL queries for the bot's SQLite store

A reference of useful queries against `./data/bot.db` (the path from `DATABASE_PATH` in `.env`). Run these from `sqlite3 ./data/bot.db` or any SQLite browser.

## Setup

Run these once after opening the shell — they make output readable.

```sql
.mode column
.headers on
.timer on
```

---

## Snapshot health

**Per-market snapshot counts and time range.** Stale `MAX(timestamp)` means the market's book hasn't moved (the WS only fires on changes), not that the bot is broken.

```sql
SELECT market_id,
       COUNT(*) AS snapshots,
       MIN(timestamp) AS first_seen,
       MAX(timestamp) AS last_seen
FROM market_snapshot
GROUP BY market_id
ORDER BY snapshots DESC;
```

**Latest snapshot for a single market** (use to spot-check vs the live book on polymarket.com):

```sql
SELECT timestamp, bids_json, asks_json
FROM market_snapshot
WHERE market_id = '0xPASTE_CONDITION_ID_HERE'
ORDER BY timestamp DESC
LIMIT 1;
```

**Snapshot rate per hour, last 24h** (useful to see whether activity is steady):

```sql
SELECT strftime('%Y-%m-%d %H:00', timestamp) AS hour,
       COUNT(*) AS snapshots
FROM market_snapshot
WHERE timestamp >= datetime('now', '-24 hours')
GROUP BY hour
ORDER BY hour;
```

---

## Trade activity

**Recent events of any kind:**

```sql
SELECT timestamp, event_type, side, order_type, size, price, market_id
FROM trade_log
ORDER BY timestamp DESC
LIMIT 50;
```

**Event-type rollup** (quick sanity check — too many CANCELs per PLACE means the strategy is churning):

```sql
SELECT event_type, COUNT(*) AS n
FROM trade_log
GROUP BY event_type
ORDER BY n DESC;
```

**Per-market activity counts:**

```sql
SELECT market_id,
       SUM(event_type = 'ORDER_PLACED') AS placed,
       SUM(event_type = 'CANCEL') AS cancelled,
       SUM(event_type = 'FILL') AS filled,
       SUM(event_type = 'REJECT') AS rejected
FROM trade_log
GROUP BY market_id
ORDER BY placed DESC;
```

**Quote lifetime** — how long quotes live before being cancelled. With `minQuoteLifetimeMs: 5000` the average should be > 5000ms; if it's in the tens of milliseconds, the strategy is thrashing.

```sql
SELECT market_id,
       SUM(event_type = 'ORDER_PLACED') AS placed,
       SUM(event_type = 'CANCEL') AS cancelled,
       SUM(event_type = 'FILL') AS filled,
       ROUND(AVG((julianday((SELECT MIN(timestamp) FROM trade_log t2
                            WHERE t2.event_type = 'CANCEL'
                              AND t2.order_id = t1.order_id))
                 - julianday(t1.timestamp)) * 86400000), 0) AS avg_lifetime_ms
FROM trade_log t1
WHERE event_type = 'ORDER_PLACED'
GROUP BY market_id
ORDER BY placed DESC;
```

---

## Fills

**Every fill, most recent first:**

```sql
SELECT timestamp, side, size, price, fee_usd, market_id
FROM trade_log
WHERE event_type = 'FILL'
ORDER BY timestamp DESC;
```

**Fill notional and fees by day:**

```sql
SELECT date(timestamp) AS day,
       COUNT(*) AS fills,
       ROUND(SUM(size * price), 2) AS notional_usd,
       ROUND(SUM(fee_usd), 4) AS fees_usd
FROM trade_log
WHERE event_type = 'FILL'
GROUP BY day
ORDER BY day DESC;
```

**Buys vs sells, per market:**

```sql
SELECT market_id,
       SUM(side = 'BUY')  AS buy_fills,
       SUM(side = 'SELL') AS sell_fills,
       ROUND(SUM(CASE WHEN side = 'BUY'  THEN size ELSE 0 END), 2) AS bought_shares,
       ROUND(SUM(CASE WHEN side = 'SELL' THEN size ELSE 0 END), 2) AS sold_shares
FROM trade_log
WHERE event_type = 'FILL'
GROUP BY market_id;
```

---

## Positions and P&L

**Currently held positions:**

```sql
SELECT market_id, token_id, size, avg_entry_price, realized_pnl_usd, updated_at
FROM position
WHERE size > 0
ORDER BY updated_at DESC;
```

**All positions including flat (with realized PnL):**

```sql
SELECT market_id, token_id, size, avg_entry_price, realized_pnl_usd, updated_at
FROM position
ORDER BY realized_pnl_usd ASC;
```

**Daily P&L roll-up:**

```sql
SELECT date, realized_pnl_usd, fees_paid_usd, trade_count
FROM daily_pnl
ORDER BY date DESC;
```

---

## Rejections (risk manager + venue)

**Why orders were rejected** — full payload contains the reason string:

```sql
SELECT timestamp, market_id, side, size, price,
       json_extract(payload_json, '$.reason') AS reason
FROM trade_log
WHERE event_type = 'REJECT'
ORDER BY timestamp DESC
LIMIT 50;
```

**Rejection counts by reason:**

```sql
SELECT json_extract(payload_json, '$.reason') AS reason,
       COUNT(*) AS n
FROM trade_log
WHERE event_type = 'REJECT'
GROUP BY reason
ORDER BY n DESC;
```

---

## Simulator sanity checks

**Did any fill happen at a price better than the book had?** A simulator
bug — every match should respect the book at fill time. If this query
ever returns rows, the simulator is lying and any "profit" is fake.

```sql
SELECT
  f.timestamp,
  f.side,
  f.price AS fill_price,
  json_extract(s.bids_json, '$[0].price') AS best_bid,
  json_extract(s.asks_json, '$[0].price') AS best_ask,
  CASE
    WHEN f.side = 'BUY'  AND f.price < json_extract(s.asks_json, '$[0].price') THEN 'BUY filled below ask'
    WHEN f.side = 'SELL' AND f.price > json_extract(s.bids_json, '$[0].price') THEN 'SELL filled above bid'
  END AS suspicious_reason
FROM trade_log f
JOIN market_snapshot s
  ON s.market_id = f.market_id
  AND s.token_id = f.token_id
  AND ABS(strftime('%s', s.timestamp) - strftime('%s', f.timestamp)) < 1
WHERE f.event_type = 'FILL'
  AND (
    (f.side = 'BUY'  AND f.price < json_extract(s.asks_json, '$[0].price'))
    OR
    (f.side = 'SELL' AND f.price > json_extract(s.bids_json, '$[0].price'))
  )
ORDER BY f.timestamp DESC;
```

**Average slippage per fill** (positive = paid worse than touch — expected for market orders walking the book):

```sql
SELECT f.side,
       COUNT(*) AS fills,
       ROUND(AVG(
         CASE WHEN f.side = 'BUY'
           THEN f.price - json_extract(s.asks_json, '$[0].price')
           ELSE json_extract(s.bids_json, '$[0].price') - f.price
         END
       ), 5) AS avg_slippage
FROM trade_log f
JOIN market_snapshot s
  ON s.market_id = f.market_id
  AND s.token_id = f.token_id
  AND ABS(strftime('%s', s.timestamp) - strftime('%s', f.timestamp)) < 1
WHERE f.event_type = 'FILL'
GROUP BY f.side;
```

---

## Live watch loops (run in another terminal)

**Headline stats every 5s:**

```bash
watch -n 5 'sqlite3 -header -column ./data/bot.db "
SELECT
  (SELECT COUNT(*) FROM market_snapshot) AS snapshots,
  (SELECT COUNT(*) FROM trade_log WHERE event_type=\"ORDER_PLACED\") AS orders,
  (SELECT COUNT(*) FROM trade_log WHERE event_type=\"FILL\") AS fills,
  (SELECT COUNT(*) FROM trade_log WHERE event_type=\"CANCEL\") AS cancels,
  (SELECT COUNT(*) FROM trade_log WHERE event_type=\"REJECT\") AS rejects"'
```

**Latest 5 events every 2s** (for live tailing while developing):

```bash
watch -n 2 'sqlite3 -header -column ./data/bot.db "
SELECT timestamp, event_type, side, size, price, substr(market_id,1,16) AS market
FROM trade_log
ORDER BY timestamp DESC
LIMIT 5"'
```

---

## Maintenance

**Database size on disk:**

```bash
du -h ./data/bot.db ./data/bot.db-wal ./data/bot.db-shm 2>/dev/null
```

**Vacuum** (reclaim space after large deletes — rarely needed, but here for completeness):

```sql
VACUUM;
```

**Reset everything** (destructive — only use between strategy iterations on a development machine):

```sql
DELETE FROM trade_log;
DELETE FROM market_snapshot;
DELETE FROM position;
DELETE FROM daily_pnl;
VACUUM;
```
