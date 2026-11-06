-- Runtime migration for @arena/db. Every statement is idempotent (IF NOT EXISTS).
-- MUST stay in sync with src/schema.ts (src/db.test.ts checks column parity).
-- Conventions: timestamps are unix ms BIGINT; money is USD DOUBLE PRECISION; addresses are lowercase text.
-- Statements are split on ";" by migrate(), so do not put semicolons in comments or string literals.

CREATE TABLE IF NOT EXISTS users (
  address TEXT PRIMARY KEY,
  display_name TEXT,
  tg_handle TEXT,
  humans_board_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_address TEXT NOT NULL REFERENCES users (address),
  trading_wallet TEXT NOT NULL,
  zg_wallet TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  mode TEXT NOT NULL DEFAULT 'paper',
  template TEXT NOT NULL,
  config JSONB NOT NULL,
  config_version INTEGER NOT NULL DEFAULT 1,
  config_hash TEXT NOT NULL,
  forked_from TEXT REFERENCES agents (id),
  created_at BIGINT NOT NULL,
  CONSTRAINT agents_status_check CHECK (status IN ('active', 'paused', 'stopped')),
  CONSTRAINT agents_mode_check CHECK (mode IN ('paper', 'live'))
);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents (owner_address);
CREATE INDEX IF NOT EXISTS agents_template_idx ON agents (template);

CREATE TABLE IF NOT EXISTS agent_config_versions (
  agent_id TEXT NOT NULL REFERENCES agents (id),
  version INTEGER NOT NULL,
  config JSONB NOT NULL,
  config_hash TEXT NOT NULL,
  changelog TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (agent_id, version)
);

CREATE TABLE IF NOT EXISTS forks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  buyer TEXT NOT NULL REFERENCES users (address),
  price_usd DOUBLE PRECISION NOT NULL,
  tx_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  new_agent_id TEXT REFERENCES agents (id),
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS forks_agent_idx ON forks (agent_id);
CREATE INDEX IF NOT EXISTS forks_buyer_idx ON forks (buyer);
CREATE UNIQUE INDEX IF NOT EXISTS forks_tx_hash_idx ON forks (tx_hash);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents (id),
  funder_address TEXT NOT NULL,
  side TEXT NOT NULL,
  asset TEXT NOT NULL,
  order_type TEXT NOT NULL,
  notional_usd DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_agent_ts_idx ON orders (agent_id, created_at);
CREATE INDEX IF NOT EXISTS orders_funder_ts_idx ON orders (funder_address, created_at);

CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (id),
  price DOUBLE PRECISION NOT NULL,
  qty DOUBLE PRECISION NOT NULL,
  notional_usd DOUBLE PRECISION NOT NULL,
  fee_usd DOUBLE PRECISION NOT NULL,
  integrator_fee_usd DOUBLE PRECISION NOT NULL,
  tx_id TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS fills_order_idx ON fills (order_id);
CREATE INDEX IF NOT EXISTS fills_ts_idx ON fills (ts);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  ts BIGINT NOT NULL,
  risk_level TEXT NOT NULL,
  budget_tier TEXT NOT NULL,
  market JSONB NOT NULL,
  decision JSONB,
  inference JSONB,
  zg_request_id TEXT,
  verdict JSONB NOT NULL,
  flash_order_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  zg_storage_root TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS episodes_agent_ts_idx ON episodes (agent_id, ts);
CREATE INDEX IF NOT EXISTS episodes_zg_request_idx ON episodes (zg_request_id);

CREATE TABLE IF NOT EXISTS forecasts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  episode_id TEXT REFERENCES episodes (id),
  asset TEXT NOT NULL,
  horizon_min INTEGER NOT NULL,
  direction TEXT NOT NULL,
  expected_move_pct DOUBLE PRECISION NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  price_at_forecast DOUBLE PRECISION NOT NULL,
  resolve_at BIGINT NOT NULL,
  resolved_price DOUBLE PRECISION,
  hit BOOLEAN,
  created_at BIGINT NOT NULL,
  CONSTRAINT forecasts_direction_check CHECK (direction IN ('up', 'down', 'flat'))
);
CREATE INDEX IF NOT EXISTS forecasts_agent_ts_idx ON forecasts (agent_id, created_at);
CREATE INDEX IF NOT EXISTS forecasts_due_idx ON forecasts (resolve_at) WHERE resolved_price IS NULL;

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  ts BIGINT NOT NULL,
  lesson TEXT NOT NULL,
  evidence_episode_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence DOUBLE PRECISION NOT NULL,
  applies_to JSONB NOT NULL DEFAULT '[]'::jsonb,
  zg_storage_root TEXT
);
CREATE INDEX IF NOT EXISTS lessons_agent_ts_idx ON lessons (agent_id, ts);

CREATE TABLE IF NOT EXISTS inference_calls (
  request_id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents (id),
  user_address TEXT,
  model TEXT NOT NULL,
  provider TEXT,
  billing TEXT,
  tee_verified BOOLEAN,
  latency_ms INTEGER NOT NULL,
  payer TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'decision',
  ts BIGINT NOT NULL,
  CONSTRAINT inference_payer_check CHECK (payer IN ('agent', 'user', 'platform'))
);
CREATE INDEX IF NOT EXISTS inference_agent_ts_idx ON inference_calls (agent_id, ts);
CREATE INDEX IF NOT EXISTS inference_user_ts_idx ON inference_calls (user_address, ts);

CREATE TABLE IF NOT EXISTS zg_keys (
  key_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  credit_limit DOUBLE PRECISION NOT NULL,
  reset_period TEXT NOT NULL DEFAULT 'daily',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS zg_keys_agent_idx ON zg_keys (agent_id);

CREATE TABLE IF NOT EXISTS topups (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  usdc_amount DOUBLE PRECISION NOT NULL,
  base_tx TEXT,
  zg_transfer_tx TEXT,
  deposit_tx TEXT,
  first_paid_request_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS topups_agent_ts_idx ON topups (agent_id, ts);

CREATE TABLE IF NOT EXISTS treasury_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  kind TEXT NOT NULL,
  amount_usd DOUBLE PRECISION NOT NULL,
  tx_hash TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS treasury_agent_ts_idx ON treasury_events (agent_id, ts);

CREATE TABLE IF NOT EXISTS attestations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  tx_hash TEXT,
  payload JSONB NOT NULL,
  as_of BIGINT NOT NULL,
  CONSTRAINT attestations_kind_check CHECK (kind IN ('perf', 'risk'))
);
CREATE INDEX IF NOT EXISTS attestations_kind_as_of_idx ON attestations (kind, as_of);

CREATE TABLE IF NOT EXISTS risk_states (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  reason_code INTEGER NOT NULL,
  as_of BIGINT NOT NULL,
  tx_hash TEXT,
  CONSTRAINT risk_states_level_check CHECK (level IN ('NORMAL', 'CAUTION', 'HALT'))
);
CREATE INDEX IF NOT EXISTS risk_states_as_of_idx ON risk_states (as_of);

CREATE TABLE IF NOT EXISTS insight_items (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  asset TEXT,
  body TEXT NOT NULL,
  url TEXT,
  ts BIGINT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS insight_items_asset_ts_idx ON insight_items (asset, ts);

CREATE TABLE IF NOT EXISTS insight_digests (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL,
  stance TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  source_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  zg_request_id TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS insight_digests_asset_ts_idx ON insight_digests (asset, ts);

CREATE TABLE IF NOT EXISTS share_cards (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents (id),
  user_address TEXT,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  image_url TEXT,
  zg_request_id TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS share_cards_agent_ts_idx ON share_cards (agent_id, created_at);

CREATE TABLE IF NOT EXISTS tg_subscriptions (
  chat_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  level TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (chat_id, agent_id)
);
CREATE INDEX IF NOT EXISTS tg_subscriptions_agent_idx ON tg_subscriptions (agent_id);

CREATE TABLE IF NOT EXISTS guardrail_blocks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  episode_id TEXT REFERENCES episodes (id),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS guardrail_agent_ts_idx ON guardrail_blocks (agent_id, ts);

CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  template TEXT,
  mode TEXT,
  timeframe TEXT NOT NULL,
  payload JSONB NOT NULL,
  as_of BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS leaderboard_snapshots_kind_as_of_idx ON leaderboard_snapshots (kind, as_of);

CREATE TABLE IF NOT EXISTS agent_stats (
  entity_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  template TEXT,
  mode TEXT NOT NULL,
  realized_pnl_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  pnl_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  volume_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  trades INTEGER NOT NULL DEFAULT 0,
  win_rate_bps INTEGER NOT NULL DEFAULT 0,
  max_drawdown_bps INTEGER NOT NULL DEFAULT 0,
  forecast_hit_rate_bps INTEGER NOT NULL DEFAULT 0,
  days_active INTEGER NOT NULL DEFAULT 0,
  verified_tx TEXT,
  verified_as_of BIGINT,
  self_funded BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at BIGINT NOT NULL,
  CONSTRAINT agent_stats_kind_check CHECK (kind IN ('agent', 'human')),
  CONSTRAINT agent_stats_mode_check CHECK (mode IN ('paper', 'live'))
);
CREATE INDEX IF NOT EXISTS agent_stats_pnl_idx ON agent_stats (realized_pnl_usd);
