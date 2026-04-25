CREATE TABLE IF NOT EXISTS trade_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  mode TEXT NOT NULL,
  event_type TEXT NOT NULL,
  order_id TEXT,
  market_id TEXT NOT NULL,
  token_id TEXT,
  side TEXT,
  order_type TEXT,
  size REAL,
  price REAL,
  fee_usd REAL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_log_timestamp ON trade_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_trade_log_market ON trade_log(market_id, timestamp);

CREATE TABLE IF NOT EXISTS market_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  market_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  bids_json TEXT NOT NULL,
  asks_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshot_market_ts ON market_snapshot(market_id, timestamp);

CREATE TABLE IF NOT EXISTS position (
  market_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  size REAL NOT NULL,
  avg_entry_price REAL NOT NULL,
  realized_pnl_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (market_id, token_id)
);

CREATE TABLE IF NOT EXISTS daily_pnl (
  date TEXT PRIMARY KEY,
  realized_pnl_usd REAL NOT NULL DEFAULT 0,
  fees_paid_usd REAL NOT NULL DEFAULT 0,
  trade_count INTEGER NOT NULL DEFAULT 0
);
