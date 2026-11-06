// Core domain types shared by every package. Changing a type here is a cross-team change.

export type TemplateId = "momentum" | "mean_reversion" | "breakout" | "smart_dca" | "social_sentiment";
export type ModelTier = "strong" | "balanced" | "economical";
export type CrashMode = "tighten_stops" | "flatten";
export type ExecutionMode = "paper" | "live";
export type AgentStatus = "active" | "paused" | "stopped";

/** Mirrors RiskOracle.level (uint8): 0 NORMAL, 1 CAUTION, 2 HALT. */
export type RiskLevel = "NORMAL" | "CAUTION" | "HALT";
export const RISK_LEVELS: readonly RiskLevel[] = ["NORMAL", "CAUTION", "HALT"] as const;

/** Mirrors RiskOracle.reasonCode (uint16). */
export enum RiskReason {
  None = 0,
  PriceDrop = 1,
  Volatility = 2,
  Depeg = 3,
  News = 4,
  ManualSimulation = 5,
}

export type BudgetTier = "healthy" | "low" | "critical" | "empty";

export type FlashOrderType =
  | "market"
  | "limit"
  | "twap"
  | "stop"
  | "stop-loss"
  | "take-profit"
  | "bracket"
  | "trailing-stop"
  | "trailing-stop-limit";

export type InsightSource =
  | { kind: "agent"; agentId: string }
  | { kind: "rss"; url: string }
  | { kind: "web_search" };

export interface AgentLimits {
  maxTradeUsd: number;
  maxOpenPositions: number;
  maxAllocationUsd: number;
  maxDailyLossUsd: number;
  maxDrawdownPct: number;
  cooldownSec: number;
}

export interface StrategyConfig {
  template: TemplateId;
  /** Tickers from the platform allowlist, e.g. ["WETH", "cbBTC"]. */
  assets: string[];
  /** Template-specific slider values; keys/bounds defined in @arena/policy templates. */
  sliders: Record<string, number>;
  limits: AgentLimits;
  tickIntervalSec: number;
  modelTier: ModelTier;
  crashMode: CrashMode;
  /** Performance fee on realized profit above high-water mark, in bps. */
  commissionBps: number;
  autoTune: { enabled: boolean; maxDeltaPct: number };
  publicCommentary: "off" | "delayed";
  insightSources: InsightSource[];
  fork: { forkable: boolean; priceUsd: number };
}

export interface Agent {
  id: string;
  name: string;
  ownerAddress: `0x${string}`;
  tradingWallet: `0x${string}`;
  zgWallet: `0x${string}` | null;
  config: StrategyConfig;
  configVersion: number;
  configHash: `0x${string}`;
  status: AgentStatus;
  mode: ExecutionMode;
  forkedFrom: string | null;
  createdAt: number;
}

export interface Candle {
  t: number; // unix ms, bucket open
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Indicators {
  emaFast: number;
  emaSlow: number;
  rsi14: number;
  atr14: number;
  rocPct: number;
  rangeHigh: number;
  rangeLow: number;
  volatilityPct: number;
}

export interface MarketSnapshot {
  asset: string;
  priceUsd: number;
  ts: number;
  candles: Candle[];
  indicators: Indicators;
}

export interface Forecast {
  asset: string;
  horizonMin: number;
  direction: "up" | "down" | "flat";
  expectedMovePct: number;
  confidence: number; // 0..1
}

/** A forecast persisted for later scoring against the Chainlink feed price. */
export interface StoredForecast extends Forecast {
  id: string;
  agentId: string;
  ts: number;
  priceAtForecast: number;
  resolveAt: number;
  resolvedPrice: number | null;
  hit: boolean | null;
}

export type ProposalAction = "buy" | "sell" | "hold" | "adjust_stops" | "cancel";

/** What the LLM proposes. Never executed directly: always goes through the policy engine. */
export interface Proposal {
  action: ProposalAction;
  asset?: string;
  orderType?: FlashOrderType;
  /** Fraction of the agent's allocation, 0..1. */
  sizePct?: number;
  limitPrice?: number;
  triggerPrice?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  trailPct?: number;
  twapDurationSec?: number;
  twapBuckets?: number;
  rationale: string;
}

export interface DecisionOutput {
  forecast: Forecast | null;
  proposal: Proposal;
}

/** A policy-approved order, ready to be turned into a Flash quote/order. */
export interface OrderIntent {
  side: "buy" | "sell";
  asset: string;
  quoteAsset: "USDC";
  orderType: FlashOrderType;
  notionalUsd: number;
  limitPrice?: number;
  triggerPrice?: number;
  trailPercent?: number;
  twap?: { durationSeconds: number; bucketCount: number };
  attachedBracket?: { takeProfitPrice: number; stopLossPrice: number };
}

export type PolicyVerdict =
  | { kind: "approve"; order: OrderIntent }
  | { kind: "clamp"; order: OrderIntent; reasons: string[] }
  | { kind: "reject"; reasons: string[] }
  | { kind: "noop"; reasons: string[] };

export interface GlobalLimits {
  maxTradeUsd: number;
  maxAgentAllocationUsd: number;
  maxDailyVolumeUsdPerAgent: number;
  maxDailyLossUsdPerAgent: number;
  maxOpenPositions: number;
  allowedTokens: string[];
  killSwitch: boolean;
}

export interface PolicyContext {
  config: StrategyConfig;
  riskLevel: RiskLevel;
  budgetTier: BudgetTier;
  openPositions: number;
  dailyPnlUsd: number;
  dailyVolumeUsd: number;
  drawdownPct: number;
  lastTradeAt: number | null;
  now: number;
  markPrice: number;
  allocationUsd: number;
  global: GlobalLimits;
  /** Forecast from the same decision, used to enforce the template's minConfidence slider. */
  forecast?: Forecast | null;
  /** Current position value in the proposal's asset, used to size sells. */
  positionUsd?: number;
}

export interface InferenceTrace {
  requestId: string;
  model: string;
  provider: string | null;
  /** Billing in neuron/0G as reported by x_0g_trace, kept as string to avoid precision loss. */
  billing: string | null;
  teeVerified: boolean | null;
  latencyMs: number;
  payer: "agent" | "user" | "platform";
}

export interface Episode {
  id: string;
  agentId: string;
  ts: number;
  riskLevel: RiskLevel;
  budgetTier: BudgetTier;
  market: Pick<MarketSnapshot, "asset" | "priceUsd" | "indicators">[];
  decision: DecisionOutput | null;
  inference: InferenceTrace | null;
  verdict: PolicyVerdict;
  flashOrderIds: string[];
  zgStorageRoot: string | null;
  error: string | null;
}

export interface Lesson {
  id: string;
  agentId: string;
  ts: number;
  lesson: string;
  evidenceEpisodeIds: string[];
  confidence: number;
  appliesTo: string[];
  zgStorageRoot: string | null;
}

/** Leaderboard row (stats only, no trades). */
export interface PerformanceStats {
  entityId: string; // agent id or human wallet address
  kind: "agent" | "human";
  name: string;
  template: TemplateId | null;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  volumeUsd: number;
  trades: number;
  winRateBps: number;
  maxDrawdownBps: number;
  forecastHitRateBps: number;
  forkCount: number;
  daysActive: number;
  mode: ExecutionMode;
  verified: { reportTx: `0x${string}`; asOf: number } | null;
  selfFunded: boolean;
}
