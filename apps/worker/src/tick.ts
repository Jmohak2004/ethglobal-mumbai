// One decision tick for one agent (PRD 6.3). Order of operations:
//   pre-checks -> market data -> context -> 0G decision -> policy engine -> execution -> persistence.
// The LLM can only ever reach the venue through evaluate(). runTick never throws: every failure is
// recorded on the episode, and the returned TickResult says what happened.

import { isPlaceholderWallet, latestInsightDigest, newId, topForAgent, type Db, type InsertForecastInput } from "@arena/db";
import { evaluate, TEMPLATES } from "@arena/policy";
import type {
  Agent,
  BudgetTier,
  DecisionOutput,
  Episode,
  ExecutionMode,
  InferenceTrace,
  MarketSnapshot,
  PolicyContext,
  PolicyVerdict,
} from "@arena/shared";
import { decide, InsufficientBalanceError, type AssetInsight, type InsightDigest } from "@arena/zerog";
import { cancelPendingEntries } from "./crash.ts";
import type { Deps } from "./deps.ts";
import { loadAgentState, modeFor, persistTick, placeOrder, type Persistence } from "./execution.ts";

export {
  liveSignerFor,
  loadAgentState,
  orderRows,
  paperSigner,
  persistTick,
  tradesFrom,
  type AgentState,
  type Persistence,
} from "./execution.ts";

const LESSON_LIMIT = 5;

export interface TickResult {
  agentId: string;
  requestId: string;
  episode: Episode | null;
  /**
   * Set when the tick did not run: "agent is <status>" (no episode written), or "not provisioned"
   * (a noop episode is written so the skip shows on the agent's timeline).
   */
  skipped: string | null;
  orderId: string | null;
  /** Mode the order was sent in. Null when no order was attempted. */
  mode: ExecutionMode | null;
  budgetTier: BudgetTier | null;
  /** True when a sell was executed, so the caller can reflect on a closed position. */
  sold: boolean;
  /** Unexpected failure outside the normal error recording (the episode is still written when possible). */
  error: string | null;
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const hold = (...reasons: string[]): PolicyVerdict => ({ kind: "noop", reasons });

/** True once the agent has a trading wallet. Agents without one (the zero address) do not trade. */
export function isTradingWalletProvisioned(agent: Pick<Agent, "tradingWallet">): boolean {
  return !isPlaceholderWallet(agent.tradingWallet);
}

/**
 * The newest insight digest per configured asset for this agent, shaped for decide(). Returns undefined when
 * no asset has a digest. The digest repo returns one row per (agent, asset), so this makes one query per asset.
 */
export async function latestInsight(db: Db, agentId: string, assets: string[]): Promise<InsightDigest | undefined> {
  const perAsset: Record<string, AssetInsight> = {};
  let newest: { zgRequestId: string | null; ts: number } | null = null;
  for (const asset of assets) {
    const digest = await latestInsightDigest(db, agentId, { asset });
    if (!digest) continue;
    perAsset[asset] = { stance: digest.stance, confidence: digest.confidence, sourceIds: digest.sourceIds };
    if (!newest || digest.ts > newest.ts) newest = { zgRequestId: digest.zgRequestId, ts: digest.ts };
  }
  if (Object.keys(perAsset).length === 0) return undefined;
  return {
    perAsset,
    summary: "",
    trace: {
      requestId: newest?.zgRequestId ?? "",
      model: "glm-5.3-flash",
      provider: null,
      billing: null,
      teeVerified: null,
      latencyMs: 0,
      payer: "platform",
    },
    traces: [],
    error: null,
  };
}

/** Runs one tick for one agent. Never throws. */
export async function runTick(deps: Deps, agent: Agent): Promise<TickResult> {
  const makeId = deps.newId ?? newId;
  const requestId = makeId();
  const log = deps.logger.child({ agent: agent.id, req: requestId });
  const episodeId = makeId();
  const result: TickResult = {
    agentId: agent.id,
    requestId,
    episode: null,
    skipped: null,
    orderId: null,
    mode: null,
    budgetTier: null,
    sold: false,
    error: null,
  };
  let persisted = false;

  try {
    if (agent.status !== "active") {
      result.skipped = `agent is ${agent.status}`;
      log.info("tick skipped", { reason: result.skipped });
      return result;
    }

    const now = deps.clock.now();
    if (!isTradingWalletProvisioned(agent)) {
      result.skipped = "not provisioned";
      log.info("tick skipped", { reason: result.skipped });
      const risk = await deps.risk.current().catch(() => "NORMAL" as const);
      const episode: Episode = {
        id: episodeId,
        agentId: agent.id,
        ts: now,
        riskLevel: risk,
        budgetTier: "healthy",
        market: [],
        decision: null,
        inference: null,
        verdict: hold("not provisioned"),
        flashOrderIds: [],
        zgStorageRoot: null,
        error: null,
      };
      await persistTick(deps.db, episode, { traces: [], forecast: null, order: null });
      persisted = true;
      result.episode = episode;
      return result;
    }

    const risk = await deps.risk.current();
    const budget = await deps.budget.forAgent(agent);
    let budgetTier: BudgetTier = budget.tier;
    result.budgetTier = budgetTier;

    const errors: string[] = [];
    const snapshots: MarketSnapshot[] = [];
    for (const asset of agent.config.assets) {
      try {
        snapshots.push(await deps.market.getSnapshot(asset));
      } catch (err) {
        errors.push(`market ${asset}: ${msg(err)}`);
      }
    }
    const snapshotFor = (asset: string | undefined) => snapshots.find((s) => s.asset === asset);
    const marketPick: Episode["market"] = snapshots.map((s) => ({ asset: s.asset, priceUsd: s.priceUsd, indicators: s.indicators }));

    /** Writes the episode with whatever has been decided so far, and returns the result. */
    const finish = async (
      verdict: PolicyVerdict,
      parts: { decision?: DecisionOutput | null; inference?: InferenceTrace | null } & Partial<Persistence> & { orderId?: string | null },
    ): Promise<TickResult> => {
      const episode: Episode = {
        id: episodeId,
        agentId: agent.id,
        ts: now,
        riskLevel: risk,
        budgetTier,
        market: marketPick,
        decision: parts.decision ?? null,
        inference: parts.inference ?? null,
        verdict,
        flashOrderIds: parts.orderId ? [parts.orderId] : [],
        zgStorageRoot: null,
        error: errors.length > 0 ? errors.join("; ") : null,
      };
      await persistTick(deps.db, episode, {
        traces: parts.traces ?? [],
        forecast: parts.forecast ?? null,
        order: parts.order ?? null,
      });
      persisted = true;
      result.episode = episode;
      result.budgetTier = budgetTier;
      return result;
    };

    if (deps.globalLimits.killSwitch) {
      // PRD 6.5: the kill switch stops new decisions but still cancels unfilled entries. Positions keep
      // their exchange-side TP/SL.
      const cancel = await cancelPendingEntries(deps, agent, now);
      errors.push(...cancel.failed.map((f) => `cancel ${f.orderId}: ${f.error}`));
      log.warn("tick skipped: kill switch", { cancelled: cancel.cancelled.length, failed: cancel.failed.length });
      return finish(
        hold(
          `GLOBAL_KILL_SWITCH is on: tick skipped before inference; cancelled ${cancel.cancelled.length} pending entr${cancel.cancelled.length === 1 ? "y" : "ies"}`,
        ),
        {},
      );
    }
    if (snapshots.length === 0) {
      errors.push("no market data available");
      return finish(hold("no market data: nothing to decide on"), {});
    }
    if (budgetTier === "empty") {
      return finish(hold(`budget tier empty (${budget.source}): LLM skipped, no new entries`), {});
    }

    const lessons = await topForAgent(deps.db, agent.id, { k: LESSON_LIMIT });
    const insights = await latestInsight(deps.db, agent.id, agent.config.assets);
    const state = await loadAgentState(deps.db, agent, now);
    const openPositions = state.fifo.openPositions;

    let decision: DecisionOutput | null = null;
    let traces: InferenceTrace[] = [];
    let inference: InferenceTrace | null = null;
    try {
      const router = deps.agentRouterFor ? await deps.agentRouterFor(agent) : deps.routerFor(agent);
      const res = await decide(router, {
        agentName: agent.name,
        config: agent.config,
        templateSummary: TEMPLATES[agent.config.template].description,
        market: snapshots,
        lessons,
        insights,
        risk,
        budget: budgetTier,
        openPositions,
      });
      decision = res.output;
      traces = res.traces;
      inference = res.trace;
      if (res.error) errors.push(`model output rejected after retry: ${res.error}`);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        deps.budget.markCritical(agent.id, "0G 402");
        budgetTier = "critical";
        errors.push(`0G 402 insufficient balance${err.requestId ? ` (request ${err.requestId})` : ""}`);
        log.warn("0G insufficient balance: budget set to critical", { requestId: err.requestId ?? undefined });
      } else {
        errors.push(`decision failed: ${msg(err)}`);
        log.error("decision failed", { error: err });
      }
    }

    if (!decision) {
      return finish(hold(errors[errors.length - 1] ?? "no decision"), { traces });
    }

    const proposal = decision.proposal;
    const markPrice = snapshotFor(proposal.asset)?.priceUsd ?? 0;
    const positionQty = openPositions.find((p) => p.asset === proposal.asset)?.qty ?? 0;
    const ctx: PolicyContext = {
      config: agent.config,
      riskLevel: risk,
      budgetTier,
      openPositions: openPositions.length,
      dailyPnlUsd: state.dailyPnlUsd,
      dailyVolumeUsd: state.dailyVolumeUsd,
      drawdownPct: state.fifo.maxDrawdownPct,
      lastTradeAt: state.lastTradeAt,
      now,
      markPrice,
      allocationUsd: agent.config.limits.maxAllocationUsd,
      global: deps.globalLimits,
      forecast: decision.forecast,
      positionUsd: positionQty * markPrice,
    };
    const verdict = evaluate(proposal, ctx);

    let forecast: InsertForecastInput | null = null;
    if (decision.forecast) {
      const price = snapshotFor(decision.forecast.asset)?.priceUsd;
      if (price && price > 0) {
        forecast = {
          agentId: agent.id,
          asset: decision.forecast.asset,
          horizonMin: decision.forecast.horizonMin,
          direction: decision.forecast.direction,
          expectedMovePct: decision.forecast.expectedMovePct,
          confidence: decision.forecast.confidence,
          priceAtForecast: price,
          resolveAt: now + decision.forecast.horizonMin * 60_000,
          createdAt: now,
        };
      } else {
        errors.push(`forecast not stored: no price for ${decision.forecast.asset}`);
      }
    }

    let order: Persistence["order"] = null;
    let orderId: string | null = null;
    if (verdict.kind === "approve" || verdict.kind === "clamp") {
      try {
        const placed = await placeOrder(deps, agent, verdict.order, markPrice, now);
        order = placed.persist;
        orderId = placed.orderId;
        result.mode = placed.mode;
        result.orderId = placed.orderId;
        result.sold = verdict.order.side === "sell";
        log.info("order sent", { orderId: placed.orderId, mode: placed.mode, side: verdict.order.side, asset: verdict.order.asset, notionalUsd: verdict.order.notionalUsd });
      } catch (err) {
        result.mode = modeFor(deps, agent);
        errors.push(`execution failed: ${msg(err)}`);
        log.error("execution failed", { error: err });
      }
    }

    log.info("tick decided", { verdict: verdict.kind, action: proposal.action, zgRequestId: inference?.requestId, budget: budgetTier });
    return finish(verdict, { decision, inference, traces, forecast, order, orderId });
  } catch (err) {
    log.error("tick failed", { error: err });
    result.error = msg(err);
    if (!persisted) {
      try {
        await persistTick(deps.db, {
          id: episodeId,
          agentId: agent.id,
          ts: deps.clock.now(),
          riskLevel: "NORMAL",
          budgetTier: result.budgetTier ?? "healthy",
          market: [],
          decision: null,
          inference: null,
          verdict: hold("tick failed before a decision was recorded"),
          flashOrderIds: [],
          zgStorageRoot: null,
          error: result.error,
        }, { traces: [], forecast: null, order: null });
        result.episode = null;
      } catch (writeErr) {
        log.error("could not record failed tick", { error: writeErr });
      }
    }
    return result;
  }
}
