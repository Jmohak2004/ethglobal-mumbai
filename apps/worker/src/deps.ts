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

export interface RiskSource {
  current(): Promise<RiskLevel>;
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
  /** Returns the inference router for an agent. Throws when no decision key is configured. */
  routerFor(agent: Agent): ZeroGRouter;
  /** Ids for episodes, requests and orders. Defaults to randomUUID. */
  newId?: () => string;
}
