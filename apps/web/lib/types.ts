// View types shared by server (lib/data.ts, route handlers) and client components.
// Type-only module: safe to import from client code.
import type {
  Agent,
  AgentStatus,
  BudgetTier,
  ExecutionMode,
  FlashOrderType,
  MarketSnapshot,
  PerformanceStats,
  RiskLevel,
  StrategyConfig,
  TemplateId,
} from "@arena/shared";
import type { RiskReason } from "@arena/shared";
import type { Timeframe } from "@/lib/templates";

export interface LeaderboardQuery {
  kind?: "agent" | "human" | "all";
  template?: TemplateId | "all";
  timeframe?: Timeframe;
  mode?: ExecutionMode | "all";
}

export interface ZgBudget {
  tier: BudgetTier;
  /** 0G credit remaining, USD-equivalent. */
  balanceUsd: number;
  dailyCapUsd: number;
  spentTodayUsd: number;
  dailySpendUsd: number;
  runwayDays: number;
}

export interface TopUp {
  id: string;
  ts: number;
  usdcAmount: number;
  /** 0G tokens credited to the agent's 0G wallet. */
  zgAmount: number;
  basePayTx: `0x${string}`;
  zgTransferTx: `0x${string}` | null;
  depositTx: `0x${string}` | null;
  status: "pending" | "credited";
}

export interface AgentTreasury {
  agentId: string;
  balanceUsd: number;
  reserveUsd: number;
  withdrawableUsd: number;
  commissionOwedUsd: number;
  commissionPaidUsd: number;
  commissionBps: number;
  /** "chain" when balances were read from AgentTreasury, "derived" when estimated from stats. */
  source: "chain" | "derived";
  zg: ZgBudget;
  topUps: TopUp[];
}

export interface RiskStatus {
  level: RiskLevel;
  reasonCode: RiskReason;
  asOf: number;
  reportTx: `0x${string}`;
}

/** What the nav shows. UNKNOWN means the risk oracle could not be read (DB down, timeout). */
export type RiskDisplay = RiskLevel | "UNKNOWN";

export interface OwnedAgent extends Agent {
  stats: PerformanceStats | null;
  allocationUsd: number;
  budgetTier: BudgetTier;
  withdrawableUsd: number;
}

/**
 * Public agent record (PRD 6.1, stats-only). Carries no config, sources, lessons or limits, and not the full
 * owner address. Full config is returned only by GET /api/agents/[id] to the owner or a fork licensee.
 */
export interface PublicAgent {
  id: string;
  name: string;
  template: TemplateId;
  mode: ExecutionMode;
  status: AgentStatus;
  /** Shortened owner address for display (0xabcd…ef12). */
  ownerShort: string;
  forkable: boolean;
  forkPriceUsd: number;
  forkedFrom: string | null;
  configVersion: number;
  createdAt: number;
}

/** GET /api/agents/[id]. `config` is present only when `viewer` is "owner" or "licensee". */
export interface AgentView extends PublicAgent {
  viewer: "owner" | "licensee" | "public";
  config?: StrategyConfig;
}

/** Live market for /trade: Coinbase Exchange candles (ascending) with 24h stats. */
export interface MarketResponse extends MarketSnapshot {
  granularity: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  source: "coinbase";
}

export interface HumansPrefs {
  address: `0x${string}`;
  humansBoardOptIn: boolean;
}

export interface EquityPoint {
  t: number;
  equityUsd: number;
  pnlUsd: number;
}

/** One open position in a paper (or live) book, marked to market. Mirrors @arena/db PortfolioPosition. */
export interface PortfolioPosition {
  asset: string;
  qty: number;
  avgPriceUsd: number;
  markPriceUsd: number;
  valueUsd: number;
  unrealizedPnlUsd: number;
}

/** Mark-to-market snapshot written by the worker. Mirrors @arena/db PortfolioSnapshot. */
export interface PortfolioSnapshot {
  cashUsd: number;
  positions: PortfolioPosition[];
  equityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  asOf: number;
}

/** Worker-written runtime status (agents.runtime). Mirrors @arena/db AgentRuntimeState. */
export interface AgentRuntimeState {
  lastTickAt?: number;
  nextTickAt?: number;
  lastOutcome?: string;
  lastError?: string | null;
  lastRequestId?: string | null;
  portfolio?: PortfolioSnapshot;
  updatedAt?: number;
}

/** Provisioning progress the status panel reads. Mirrors the walletAt fields of @arena/db ProvisioningState. */
export interface ProvisioningStatus {
  walletAt?: number | null;
  zgWalletAt?: number | null;
}

/**
 * GET /api/agents/[id]/runtime. Everyone gets the status fields. `portfolio`, `lastError`, `lastRequestId`,
 * `tickQueued` and `tickIntervalSec` are present only when `viewer` is "owner" (the key is absent otherwise).
 */
export interface AgentRuntimeView {
  viewer: "owner" | "public";
  /** Server clock (unix ms) when the response was built. Used to correct countdowns for client clock skew. */
  serverNow: number;
  walletProvisioned: boolean;
  lastTickAt: number | null;
  nextTickAt: number | null;
  lastOutcome: string | null;
  updatedAt: number | null;
  /** True when updatedAt is missing or older than 2 x the agent's tick interval. Computed on the server. */
  workerOffline: boolean;
  lastError?: string | null;
  lastRequestId?: string | null;
  portfolio?: PortfolioSnapshot | null;
  tickQueued?: boolean;
  tickIntervalSec?: number;
}

export interface PaperLedgerEntry {
  id: string;
  agentId: string;
  kind: "commission" | "topup";
  amountUsd: number;
  amount0g: number | null;
  note: string | null;
  ts: number;
}

export interface PaperLedgerTotals {
  commissionUsd: number;
  topupUsd: number;
  topup0g: number;
  balanceUsd: number;
}

/** GET /api/agents/[id]/ledger (owner only). */
export interface PaperLedgerView {
  entries: PaperLedgerEntry[];
  totals: PaperLedgerTotals;
}

export interface OpenOrder {
  id: string;
  ts: number;
  asset: string;
  side: "buy" | "sell";
  orderType: FlashOrderType;
  sizeUsd: number;
  priceUsd: number;
  status: "open" | "partially_filled";
}

export interface Fill {
  id: string;
  ts: number;
  asset: string;
  side: "buy" | "sell";
  sizeUsd: number;
  priceUsd: number;
  feeUsd: number;
  /** Null for simulated (paper) fills. */
  txHash: `0x${string}` | null;
  /** True for paper-mode fills that were never sent to Flash. */
  simulated?: boolean;
}

export interface Balance {
  symbol: string;
  amount: number;
  valueUsd: number;
}

export interface TradingActivity {
  openOrders: OpenOrder[];
  fills: Fill[];
  balances: Balance[];
  /** "demo" = mock data, "flash" = live Flash API, "none" = nothing to show until a wallet connects. */
  source: "demo" | "flash" | "none";
}

// ---------------------------------------------------------------------------
// API contracts (client <-> route handlers)
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "BAD_REQUEST"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "NOT_DEPLOYED"
  | "UPSTREAM"
  | "INTERNAL";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: string[] };
}

export interface SessionInfo {
  address: `0x${string}` | null;
  expiresAt: number | null;
}

/** Public platform settings (no secrets). */
export interface PlatformInfo {
  executionMode: ExecutionMode;
  network: "mainnet" | "testnet";
  /** Flash submission is possible: EXECUTION_MODE=live and DEFINITIVE_API_KEY set. */
  flashLive: boolean;
  /** Platform 0G key is configured (AI features work without a user key). */
  platformZgKey: boolean;
  /** DEMO_CONTROLS=true on the server: the nav Demo menu may call POST /api/demo/risk (still session-checked). */
  demoControls: boolean;
  dbEnabled: boolean;
  sessionEnabled: boolean;
  caps: {
    maxTradeUsd: number;
    maxAgentAllocationUsd: number;
    maxDailyLossUsd: number;
    maxOpenPositions: number;
    flashIntegratorFeeBps: number;
  };
}

/** Manual-trade ticket as entered in the order ticket (UI order-type names). */
export interface TicketInput {
  side: "buy" | "sell";
  asset: string;
  orderType: "market" | "limit" | "twap" | "stop" | "trailing" | "bracket";
  sizeUsd: number;
  limitPrice?: number;
  triggerPrice?: number;
  trailPct?: number;
  twap?: { durationMin: number; buckets: number };
  takeProfitPrice?: number;
  stopLossPrice?: number;
}

/** A typed-data payload as returned by Flash, with bigints still as strings (client converts before signing). */
export interface TypedDataJson {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export type OnchainStep =
  | { kind: "approve" | "bracket-approve" | "wrap"; to: `0x${string}`; data: `0x${string}`; value: string }
  | { kind: "setup"; raw: string };

export type TradeQuote =
  | {
      mode: "paper";
      notionalUsd: number;
      priceUsd: number;
      feeUsd: number;
      note: string;
    }
  | {
      mode: "live";
      quoteId: string;
      receive: { amount: string; asset: string };
      feeUsd: number;
      priceImpact: string | null;
      recommendedSlippage: string | null;
      steps: OnchainStep[];
      sign: {
        order: TypedDataJson;
        permit: TypedDataJson | null;
        bracket: { order: TypedDataJson; permit: TypedDataJson | null } | null;
      };
    };

export interface OrderSignatures {
  order: string;
  permit?: string;
  bracketOrder?: string;
  bracketPermit?: string;
}

/**
 * Cancel plan from POST /api/flash/cancel. Paper: nothing is sent anywhere. Live: `message` is the exact text the
 * funder wallet must sign (EIP-191) before POST /api/flash/cancel/submit.
 */
export type CancelPlan = { mode: "paper"; orderIds: string[] } | { mode: "live"; orderIds: string[]; message: string };

/** One order's outcome. `errorCode` is set when ok is false (a Flash batch error code, or an HTTP-derived code). */
export interface CancelResult {
  orderId: string;
  ok: boolean;
  errorCode: string | null;
}

export interface ChartReadResult {
  trend: "bullish" | "bearish" | "range";
  keyLevels: number[];
  suggestedTemplate: TemplateId;
  suggestedSliders: Record<string, number>;
  summary: string;
  requestId: string;
  payer: "user" | "platform";
  teeVerified: boolean | null;
}

export interface ShareCardResult {
  /** data:image/...;base64,... or https URL. */
  image: string;
  requestId: string;
  payer: "user" | "platform";
}

export interface ForkResult {
  newAgentId: string;
  sourceAgentId: string;
  txHash: `0x${string}`;
}
