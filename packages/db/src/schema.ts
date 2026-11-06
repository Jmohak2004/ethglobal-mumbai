// Drizzle (pg-core) schema for the arena Postgres database.
//
// src/schema.sql is the runtime migration and MUST be kept in sync with this file.
// src/db.test.ts checks column parity between the two.
//
// Conventions
// - ids: text. UUIDs are generated in repo code; external ids (Flash order ids, 0G request ids) are stored as-is.
// - timestamps: bigint unix milliseconds (matches the `number` timestamps in @arena/shared). Columns named
//   created_at, updated_at, ts, as_of, resolve_at, etc. are all unix ms.
// - money: double precision USD (matches the `number` fields in @arena/shared).
// - addresses: lowercase 0x-prefixed text.
// - structured blobs: jsonb.
// - Demo/seed rows use ids prefixed with "demo-" (see src/seed.ts).

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type {
  DecisionOutput,
  Episode,
  InferenceTrace,
  PolicyVerdict,
  StrategyConfig,
} from "@arena/shared";

const ms = (name: string) => bigint(name, { mode: "number" });

// ---------------------------------------------------------------------------
// Identity and agents
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  address: text("address").primaryKey(),
  displayName: text("display_name"),
  tgHandle: text("tg_handle"),
  humansBoardOptIn: boolean("humans_board_opt_in").notNull().default(false),
  createdAt: ms("created_at").notNull(),
});

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ownerAddress: text("owner_address")
      .notNull()
      .references(() => users.address),
    tradingWallet: text("trading_wallet").notNull(),
    zgWallet: text("zg_wallet"),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("paper"),
    /** Denormalized from config.template so the leaderboard can filter without JSON access. */
    template: text("template").notNull(),
    config: jsonb("config").$type<StrategyConfig>().notNull(),
    configVersion: integer("config_version").notNull().default(1),
    configHash: text("config_hash").notNull(),
    forkedFrom: text("forked_from").references((): AnyPgColumn => agents.id),
    createdAt: ms("created_at").notNull(),
  },
  (t) => [
    index("agents_owner_idx").on(t.ownerAddress),
    index("agents_template_idx").on(t.template),
    check("agents_status_check", sql`${t.status} in ('active', 'paused', 'stopped')`),
    check("agents_mode_check", sql`${t.mode} in ('paper', 'live')`),
  ],
);

export const agentConfigVersions = pgTable(
  "agent_config_versions",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    version: integer("version").notNull(),
    config: jsonb("config").$type<StrategyConfig>().notNull(),
    configHash: text("config_hash").notNull(),
    changelog: text("changelog"),
    createdAt: ms("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.version] })],
);

export const forks = pgTable(
  "forks",
  {
    id: text("id").primaryKey(),
    /** Source agent that was forked. */
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    buyer: text("buyer")
      .notNull()
      .references(() => users.address),
    priceUsd: doublePrecision("price_usd").notNull(),
    txHash: text("tx_hash").notNull(),
    configHash: text("config_hash").notNull(),
    /** The agent created for the buyer. */
    newAgentId: text("new_agent_id").references(() => agents.id),
    createdAt: ms("created_at").notNull(),
  },
  (t) => [
    index("forks_agent_idx").on(t.agentId),
    index("forks_buyer_idx").on(t.buyer),
    uniqueIndex("forks_tx_hash_idx").on(t.txHash),
  ],
);

// ---------------------------------------------------------------------------
// Trading: Flash orders and fills
// ---------------------------------------------------------------------------

export const orders = pgTable(
  "orders",
  {
    /** Flash order id. */
    id: text("id").primaryKey(),
    /** Null for manual trades from the terminal (§6.13). */
    agentId: text("agent_id").references(() => agents.id),
    funderAddress: text("funder_address").notNull(),
    side: text("side").notNull(),
    asset: text("asset").notNull(),
    orderType: text("order_type").notNull(),
    notionalUsd: doublePrecision("notional_usd").notNull(),
    status: text("status").notNull(),
    raw: jsonb("raw")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: ms("created_at").notNull(),
    updatedAt: ms("updated_at").notNull(),
  },
  (t) => [
    index("orders_agent_ts_idx").on(t.agentId, t.createdAt),
    index("orders_funder_ts_idx").on(t.funderAddress, t.createdAt),
  ],
);

export const fills = pgTable(
  "fills",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    price: doublePrecision("price").notNull(),
    qty: doublePrecision("qty").notNull(),
    notionalUsd: doublePrecision("notional_usd").notNull(),
    feeUsd: doublePrecision("fee_usd").notNull(),
    integratorFeeUsd: doublePrecision("integrator_fee_usd").notNull(),
    txId: text("tx_id"),
    ts: ms("ts").notNull(),
  },
  (t) => [index("fills_order_idx").on(t.orderId), index("fills_ts_idx").on(t.ts)],
);

// ---------------------------------------------------------------------------
// Decision loop: episodes, forecasts, lessons, inference
// ---------------------------------------------------------------------------

export const episodes = pgTable(
  "episodes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    ts: ms("ts").notNull(),
    riskLevel: text("risk_level").notNull(),
    budgetTier: text("budget_tier").notNull(),
    market: jsonb("market").$type<Episode["market"]>().notNull(),
    decision: jsonb("decision").$type<DecisionOutput | null>(),
    /** Full InferenceTrace. zgRequestId below is the indexed copy of inference.requestId. */
    inference: jsonb("inference").$type<InferenceTrace | null>(),
    zgRequestId: text("zg_request_id"),
    verdict: jsonb("verdict").$type<PolicyVerdict>().notNull(),
    flashOrderIds: jsonb("flash_order_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    zgStorageRoot: text("zg_storage_root"),
    error: text("error"),
  },
  (t) => [
    index("episodes_agent_ts_idx").on(t.agentId, t.ts),
    index("episodes_zg_request_idx").on(t.zgRequestId),
  ],
);

export const forecasts = pgTable(
  "forecasts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    episodeId: text("episode_id").references(() => episodes.id),
    asset: text("asset").notNull(),
    horizonMin: integer("horizon_min").notNull(),
    direction: text("direction").notNull(),
    expectedMovePct: doublePrecision("expected_move_pct").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    priceAtForecast: doublePrecision("price_at_forecast").notNull(),
    resolveAt: ms("resolve_at").notNull(),
    resolvedPrice: doublePrecision("resolved_price"),
    hit: boolean("hit"),
    createdAt: ms("created_at").notNull(),
  },
  (t) => [
    index("forecasts_agent_ts_idx").on(t.agentId, t.createdAt),
    index("forecasts_due_idx")
      .on(t.resolveAt)
      .where(sql`${t.resolvedPrice} is null`),
    check("forecasts_direction_check", sql`${t.direction} in ('up', 'down', 'flat')`),
  ],
);

export const lessons = pgTable(
  "lessons",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    ts: ms("ts").notNull(),
    lesson: text("lesson").notNull(),
    evidenceEpisodeIds: jsonb("evidence_episode_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    confidence: doublePrecision("confidence").notNull(),
    appliesTo: jsonb("applies_to")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    zgStorageRoot: text("zg_storage_root"),
  },
  (t) => [index("lessons_agent_ts_idx").on(t.agentId, t.ts)],
);

export const inferenceCalls = pgTable(
  "inference_calls",
  {
    requestId: text("request_id").primaryKey(),
    agentId: text("agent_id").references(() => agents.id),
    userAddress: text("user_address"),
    model: text("model").notNull(),
    provider: text("provider"),
    /** 0G billing as a decimal string (x_0g_trace.billing), kept as text to avoid precision loss. */
    billing: text("billing"),
    teeVerified: boolean("tee_verified"),
    latencyMs: integer("latency_ms").notNull(),
    payer: text("payer").notNull(),
    purpose: text("purpose").notNull().default("decision"),
    ts: ms("ts").notNull(),
  },
  (t) => [
    index("inference_agent_ts_idx").on(t.agentId, t.ts),
    index("inference_user_ts_idx").on(t.userAddress, t.ts),
    check("inference_payer_check", sql`${t.payer} in ('agent', 'user', 'platform')`),
  ],
);

export const zgKeys = pgTable(
  "zg_keys",
  {
    /** Public key id only. The sk- secret is never stored. */
    keyId: text("key_id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    creditLimit: doublePrecision("credit_limit").notNull(),
    resetPeriod: text("reset_period").notNull().default("daily"),
    createdAt: ms("created_at").notNull(),
  },
  (t) => [index("zg_keys_agent_idx").on(t.agentId)],
);

// ---------------------------------------------------------------------------
// Economics: top-ups and treasury
// ---------------------------------------------------------------------------

export const topups = pgTable(
  "topups",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    /** AgentTreasury TopUpRequested nonce, as decimal text (uint256). Unique per agent when set. */
    nonce: text("nonce"),
    usdcAmount: doublePrecision("usdc_amount").notNull(),
    baseTx: text("base_tx"),
    zgTransferTx: text("zg_transfer_tx"),
    depositTx: text("deposit_tx"),
    firstPaidRequestId: text("first_paid_request_id"),
    status: text("status").notNull().default("pending"),
    ts: ms("ts").notNull(),
    updatedAt: ms("updated_at").notNull(),
  },
  (t) => [
    index("topups_agent_ts_idx").on(t.agentId, t.ts),
    uniqueIndex("topups_agent_nonce_idx").on(t.agentId, t.nonce),
  ],
);

export const treasuryEvents = pgTable(
  "treasury_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    kind: text("kind").notNull(),
    amountUsd: doublePrecision("amount_usd").notNull(),
    txHash: text("tx_hash"),
    meta: jsonb("meta")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ts: ms("ts").notNull(),
  },
  (t) => [index("treasury_agent_ts_idx").on(t.agentId, t.ts)],
);

// ---------------------------------------------------------------------------
// Verification and risk (CRE)
// ---------------------------------------------------------------------------

export const attestations = pgTable(
  "attestations",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    txHash: text("tx_hash"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    asOf: ms("as_of").notNull(),
  },
  (t) => [
    index("attestations_kind_as_of_idx").on(t.kind, t.asOf),
    check("attestations_kind_check", sql`${t.kind} in ('perf', 'risk')`),
  ],
);

export const riskStates = pgTable(
  "risk_states",
  {
    id: text("id").primaryKey(),
    level: text("level").notNull(),
    reasonCode: integer("reason_code").notNull(),
    asOf: ms("as_of").notNull(),
    txHash: text("tx_hash"),
  },
  (t) => [
    index("risk_states_as_of_idx").on(t.asOf),
    check("risk_states_level_check", sql`${t.level} in ('NORMAL', 'CAUTION', 'HALT')`),
  ],
);

// ---------------------------------------------------------------------------
// Insights and sharing (repo: repo/insights.ts)
// ---------------------------------------------------------------------------

export const insightItems = pgTable(
  "insight_items",
  {
    id: text("id").primaryKey(),
    sourceKind: text("source_kind").notNull(),
    sourceRef: text("source_ref"),
    asset: text("asset"),
    body: text("body").notNull(),
    url: text("url"),
    ts: ms("ts"),
    raw: jsonb("raw")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    index("insight_items_asset_ts_idx").on(t.asset, t.ts),
    index("insight_items_source_idx").on(t.sourceKind, t.sourceRef, t.ts),
  ],
);

export const insightDigests = pgTable(
  "insight_digests",
  {
    id: text("id").primaryKey(),
    /** The agent the digest was produced for. Null for platform-wide digests. */
    agentId: text("agent_id").references(() => agents.id),
    asset: text("asset").notNull(),
    stance: text("stance").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    sourceIds: jsonb("source_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    zgRequestId: text("zg_request_id"),
    ts: ms("ts").notNull(),
  },
  (t) => [
    index("insight_digests_asset_ts_idx").on(t.asset, t.ts),
    index("insight_digests_agent_ts_idx").on(t.agentId, t.ts),
  ],
);

/** Last fully processed block for a named chain scanner (e.g. the PerformanceReported sync). */
export const chainCursors = pgTable("chain_cursors", {
  name: text("name").primaryKey(),
  block: ms("block").notNull(),
  updatedAt: ms("updated_at").notNull(),
});

export const shareCards = pgTable(
  "share_cards",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").references(() => agents.id),
    userAddress: text("user_address"),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    imageUrl: text("image_url"),
    zgRequestId: text("zg_request_id"),
    createdAt: ms("created_at").notNull(),
  },
  (t) => [index("share_cards_agent_ts_idx").on(t.agentId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Telegram, guardrails, leaderboard
// ---------------------------------------------------------------------------

export const tgSubscriptions = pgTable(
  "tg_subscriptions",
  {
    /** Telegram chat ids can be negative, so text. */
    chatId: text("chat_id").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    /** Subscription level (e.g. "digest" for /follow, "alerts" for owner DMs). Not constrained in SQL. */
    level: text("level").notNull(),
    createdAt: ms("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.agentId] }),
    index("tg_subscriptions_agent_idx").on(t.agentId),
  ],
);

export const guardrailBlocks = pgTable(
  "guardrail_blocks",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    episodeId: text("episode_id").references(() => episodes.id),
    reasons: jsonb("reasons")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    ts: ms("ts").notNull(),
  },
  (t) => [index("guardrail_agent_ts_idx").on(t.agentId, t.ts)],
);

export const leaderboardSnapshots = pgTable(
  "leaderboard_snapshots",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    template: text("template"),
    mode: text("mode"),
    timeframe: text("timeframe").notNull(),
    payload: jsonb("payload").$type<unknown[]>().notNull(),
    asOf: ms("as_of").notNull(),
  },
  (t) => [index("leaderboard_snapshots_kind_as_of_idx").on(t.kind, t.asOf)],
);

/**
 * One row per leaderboard entity (agent id or human wallet). All-time stats only; timeframe
 * windows would need a per-window table. name/template/mode are denormalized display fields.
 */
export const agentStats = pgTable(
  "agent_stats",
  {
    entityId: text("entity_id").primaryKey(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    template: text("template"),
    mode: text("mode").notNull(),
    realizedPnlUsd: doublePrecision("realized_pnl_usd").notNull().default(0),
    pnlPct: doublePrecision("pnl_pct").notNull().default(0),
    volumeUsd: doublePrecision("volume_usd").notNull().default(0),
    trades: integer("trades").notNull().default(0),
    winRateBps: integer("win_rate_bps").notNull().default(0),
    maxDrawdownBps: integer("max_drawdown_bps").notNull().default(0),
    forecastHitRateBps: integer("forecast_hit_rate_bps").notNull().default(0),
    daysActive: integer("days_active").notNull().default(0),
    verifiedTx: text("verified_tx"),
    verifiedAsOf: ms("verified_as_of"),
    selfFunded: boolean("self_funded").notNull().default(false),
    updatedAt: ms("updated_at").notNull(),
  },
  (t) => [
    index("agent_stats_pnl_idx").on(t.realizedPnlUsd),
    check("agent_stats_kind_check", sql`${t.kind} in ('agent', 'human')`),
    check("agent_stats_mode_check", sql`${t.mode} in ('paper', 'live')`),
  ],
);
