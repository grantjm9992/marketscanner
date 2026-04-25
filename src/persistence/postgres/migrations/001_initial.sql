CREATE TABLE IF NOT EXISTS trade_log (
  id            BIGSERIAL PRIMARY KEY,
  timestamp     TIMESTAMPTZ NOT NULL,
  mode          TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  order_id      TEXT,
  market_id     TEXT NOT NULL,
  token_id      TEXT,
  side          TEXT,
  order_type    TEXT,
  size          DOUBLE PRECISION,
  price         DOUBLE PRECISION,
  fee_usd       DOUBLE PRECISION,
  payload_json  JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_log_timestamp ON trade_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_trade_log_market ON trade_log(market_id, timestamp);

CREATE TABLE IF NOT EXISTS market_snapshot (
  id          BIGSERIAL PRIMARY KEY,
  timestamp   TIMESTAMPTZ NOT NULL,
  market_id   TEXT NOT NULL,
  token_id    TEXT NOT NULL,
  bids_json   JSONB NOT NULL,
  asks_json   JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshot_market_ts ON market_snapshot(market_id, timestamp);

CREATE TABLE IF NOT EXISTS position (
  market_id         TEXT NOT NULL,
  token_id          TEXT NOT NULL,
  size              DOUBLE PRECISION NOT NULL,
  avg_entry_price   DOUBLE PRECISION NOT NULL,
  realized_pnl_usd  DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (market_id, token_id)
);

CREATE TABLE IF NOT EXISTS daily_pnl (
  date              DATE PRIMARY KEY,
  realized_pnl_usd  DOUBLE PRECISION NOT NULL DEFAULT 0,
  fees_paid_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  trade_count       INTEGER NOT NULL DEFAULT 0
);
