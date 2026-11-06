// Injection boundary for the worker. Every module that touches the network, the clock or the database
// receives these interfaces, so the tick can be exercised with fakes and nothing else.

import type { Db } from "@arena/db";
import type { ExecutionMode, GlobalLimits, Agent, BudgetTier, MarketSnapshot, RiskLevel } from "@arena/shared";
import type { FlashExecutor } from "@arena/flash";
import type { ZeroGRouter } from "@arena/zerog";
import type { Logger } from "./logger.ts";
import type { WalletProvider } from "./wallets.ts";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface MarketData {
  /** Candles, indicators and the mark price for one allowlisted asset. Throws when no source answers. */
  getSnapshot(asset: string): Promise<MarketSnapshot>;
  /** Current mark price in USD (Chainlink feed, falling back to the last candle close). */
  getPrice(asset: string): Promise<number>;
}

/** The platform risk level and the time of the report that set it (unix ms, or null when unknown). */
export interface RiskReading {
  level: RiskLevel;
  asOf: number | null;
}

export interface RiskSource {
  current(): Promise<RiskLevel>;
  reading(): Promise<RiskReading>;
}

/**
 * Order management on Flash for live orders: cancel an open order, and move the stop-loss attached to an
 * open order. Each call must be signed by the agent's wallet, so the implementation owns the signing.
 */
export interface EntryOrderControl {
  cancelOrder(orderId: string, funderAddress: string): Promise<void>;
  setStopLoss(orderId: string, funderAddress: string, stopLossPrice: number): Promise<void>;
}

export interface BudgetReading {
  tier: BudgetTier;
  /** 0G balance in the same units as dailyBurn (0G). Null when unknown. */
  balance: number | null;
  /** 0G billed in the last 24 hours. */
  dailyBurn: number;
  source: "account" | "estimate" | "override";
}

export interface BudgetSource {
  forAgent(agent: Agent): Promise<BudgetReading>;
  /** Forces the critical tier for a while, after the 0G Router returned 402 for this agent. */
  markCritical(agentId: string, reason: string): void;
}

/**
 * Refreshes an agent's insight digest when it is stale (PRD 6.8). The tick calls this before reading the
 * digest. A failure is logged by the tick and never stops the decision.
 */
export interface InsightRefresher {
  refreshIfStale(agent: Agent): Promise<void>;
}

export interface Deps {
  db: Db;
  clock: Clock;
  logger: Logger;
  /** Platform EXECUTION_MODE. Live orders also need agent.mode === "live". */
  executionMode: ExecutionMode;
  globalLimits: GlobalLimits;
  market: MarketData;
  risk: RiskSource;
  budget: BudgetSource;
  wallets: WalletProvider;
  executor: Pick<FlashExecutor, "execute">;
  /**
   * Live order management (cancel, stop-loss). Null or omitted when Flash signing for these calls is not
   * configured: live cancel and stop steps then record an error on their episode instead of acting.
   */
  orderControl?: EntryOrderControl | null;
  /** Returns the inference router for an agent. Throws when no decision key is configured. */
  routerFor(agent: Agent): ZeroGRouter;
  /**
   * Inference router for one agent: its own capped 0G key when one is stored, else the platform router.
   * The tick uses this when it is set. Omitted in tests, where routerFor is used directly.
   */
  agentRouterFor?(agent: Agent): Promise<ZeroGRouter>;
  /** Insight digest refresh before a tick. Omitted in tests and when no insight producer is wired. */
  insights?: InsightRefresher | null;
  /** Ids for episodes, requests and orders. Defaults to randomUUID. */
  newId?: () => string;
}
