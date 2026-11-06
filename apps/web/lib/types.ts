// View types shared by server (lib/data.ts, route handlers) and client components.
// Type-only module: safe to import from client code.
import type { Agent, BudgetTier, ExecutionMode, FlashOrderType, PerformanceStats, RiskLevel, TemplateId } from "@arena/shared";
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

export interface OwnedAgent extends Agent {
  stats: PerformanceStats | null;
  allocationUsd: number;
  budgetTier: BudgetTier;
  withdrawableUsd: number;
}

export interface EquityPoint {
  t: number;
  equityUsd: number;
  pnlUsd: number;
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
