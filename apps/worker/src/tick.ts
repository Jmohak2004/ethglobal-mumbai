// One decision tick for one agent (PRD 6.3). Order of operations:
//   pre-checks -> market data -> context -> 0G decision -> policy engine -> execution -> persistence.
// The LLM can only ever reach the venue through evaluate(). runTick never throws: every failure is
// recorded on the episode, and the returned TickResult says what happened.

import {
  insertEpisode,
  insertForecast,
  insertFills,
  insertGuardrailBlock,
  insertInference,
  topForAgent,
  upsertOrder,
  newId,
  type Db,
  type FillRecord,
  type InsertForecastInput,
  type OrderRecord,
} from "@arena/db";
import { computeFifoPnl, type ExecutionResult, type FifoPnlResult, type OrderSigner, type Trade } from "@arena/flash";
import { evaluate, TEMPLATES } from "@arena/policy";
import type {
  Agent,
  BudgetTier,
  DecisionOutput,
  Episode,
  ExecutionMode,
  InferenceTrace,
  MarketSnapshot,
  OrderIntent,
  PolicyContext,
  PolicyVerdict,
} from "@arena/shared";
import { decide, InsufficientBalanceError, type InsightDigest } from "@arena/zerog";
import type { Deps } from "./deps.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const LESSON_LIMIT = 5;

export interface TickResult {
  agentId: string;
  requestId: string;
  episode: Episode | null;
  /** Set when the tick did not run (agent not active). No episode is written. */
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

/** Paper mode never signs, so the funder is the trading address and signing throws if it is ever reached. */
export function paperSigner(agent: Pick<Agent, "tradingWallet">): OrderSigner {
  return {
    address: agent.tradingWallet,
    signTypedData: async () => {
      throw new Error("paper mode never signs orders");
    },
  };
}

type OrderRow = Awaited<ReturnType<Db["query"]["orders"]["findMany"]>>[number];
type FillRow = Awaited<ReturnType<Db["query"]["fills"]["findMany"]>>[number];

/** Flash-normalized trades for an agent's fills, joined to the order side and asset. Fills without an order are dropped. */
export function tradesFrom(orders: OrderRow[], fillRows: FillRow[]): Trade[] {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const trades: Trade[] = [];
  for (const f of fillRows) {
    const o = byId.get(f.orderId);
    if (!o) continue;
    trades.push({
      orderId: o.id,
      side: o.side === "sell" ? "sell" : "buy",
      asset: o.asset,
      qty: f.qty,
      price: f.price,
      notionalUsd: f.notionalUsd,
      feeUsd: f.feeUsd,
      integratorFeeUsd: f.integratorFeeUsd,
      txId: f.txId ?? "",
      ts: f.ts,
    });
  }
  return trades;
}

export interface AgentState {
  trades: Trade[];
  fifo: FifoPnlResult;
  dailyPnlUsd: number;
  dailyVolumeUsd: number;
  lastTradeAt: number | null;
}

/** Loads the agent's fills and orders and derives the policy inputs from them (FIFO PnL, volume, cooldown). */
export async function loadAgentState(db: Db, agent: Agent, now: number): Promise<AgentState> {
  const orders = await db.query.orders.findMany({ where: (o, { eq }) => eq(o.agentId, agent.id) });
  const orderIds = orders.map((o) => o.id);
  const fillRows =
    orderIds.length > 0 ? await db.query.fills.findMany({ where: (f, { inArray }) => inArray(f.orderId, orderIds) }) : [];

  const trades = tradesFrom(orders, fillRows);
  const dayStart = now - (now % DAY_MS);
  const fifo = computeFifoPnl(trades, { startingCapitalUsd: agent.config.limits.maxAllocationUsd });
  const before = computeFifoPnl(trades.filter((t) => t.ts < dayStart));
  const dailyVolumeUsd = orders.filter((o) => o.createdAt >= dayStart).reduce((sum, o) => sum + o.notionalUsd, 0);
  const lastTradeAt = orders.reduce<number | null>((max, o) => (max === null || o.createdAt > max ? o.createdAt : max), null);

  return {
    trades,
    fifo,
    dailyPnlUsd: fifo.realizedPnlUsd - before.realizedPnlUsd,
    dailyVolumeUsd,
    lastTradeAt,
  };
}

/**
 * Latest insight digest for the agent's assets, if any were recorded (PRD 6.8). The digest table has no
 * repo yet, so this reads it directly. Returns undefined when there is nothing to inject.
 */
export async function latestInsight(db: Db, assets: string[]): Promise<InsightDigest | undefined> {
  if (assets.length === 0) return undefined;
  const rows = await db.query.insightDigests.findMany({
    where: (t, { inArray }) => inArray(t.asset, assets),
    orderBy: (t, { desc }) => [desc(t.ts)],
    limit: 50,
  });
  const perAsset: InsightDigest["perAsset"] = {};
  for (const row of rows) {
    if (perAsset[row.asset]) continue;
    perAsset[row.asset] = {
      stance: row.stance as InsightDigest["perAsset"][string]["stance"],
      confidence: row.confidence,
      sourceIds: row.sourceIds,
    };
  }
  if (Object.keys(perAsset).length === 0) return undefined;
  const newest = rows[0];
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

interface Persistence {
  traces: InferenceTrace[];
  forecast: InsertForecastInput | null;
  order: { record: OrderRecord; fills: FillRecord[] } | null;
}

/** Writes the episode first (other rows reference it), then its inference calls, forecast, guardrail and order. */
export async function persistTick(db: Db, episode: Episode, extra: Persistence): Promise<void> {
  await insertEpisode(db, episode);
  for (const trace of extra.traces) {
    await insertInference(db, trace, { agentId: episode.agentId, purpose: "decision", ts: episode.ts });
  }
  if (extra.forecast) {
    await insertForecast(db, { ...extra.forecast, episodeId: episode.id });
  }
  if (episode.verdict.kind === "reject" || episode.verdict.kind === "clamp") {
    await insertGuardrailBlock(db, { agentId: episode.agentId, episodeId: episode.id, reasons: episode.verdict.reasons, ts: episode.ts });
  }
  if (extra.order) {
    await upsertOrder(db, extra.order.record);
    await insertFills(db, extra.order.fills);
  }
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
      log.warn("tick skipped: kill switch", {});
      return finish(hold("GLOBAL_KILL_SWITCH is on: tick skipped before inference"), {});
    }
    if (snapshots.length === 0) {
      errors.push("no market data available");
      return finish(hold("no market data: nothing to decide on"), {});
    }
    if (budgetTier === "empty") {
      return finish(hold(`budget tier empty (${budget.source}): LLM skipped, no new entries`), {});
    }

    const lessons = await topForAgent(deps.db, agent.id, { k: LESSON_LIMIT });
    const insights = await latestInsight(deps.db, agent.config.assets);
    const state = await loadAgentState(deps.db, agent, now);
    const openPositions = state.fifo.openPositions;

    let decision: DecisionOutput | null = null;
    let traces: InferenceTrace[] = [];
    let inference: InferenceTrace | null = null;
    try {
      const router = deps.routerFor(agent);
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
      const mode: ExecutionMode = deps.executionMode === "live" && agent.mode === "live" ? "live" : "paper";
      result.mode = mode;
      try {
        const signer = mode === "live" ? await liveSignerFor(deps, agent) : paperSigner(agent);
        const exec = await deps.executor.execute(verdict.order, signer, mode, { referencePriceUsd: markPrice });
        const built = orderRows(exec, agent, verdict.order, now);
        order = built;
        orderId = exec.orderId;
        result.orderId = exec.orderId;
        result.sold = verdict.order.side === "sell";
        log.info("order sent", { orderId: exec.orderId, mode, side: verdict.order.side, asset: verdict.order.asset, notionalUsd: verdict.order.notionalUsd });
      } catch (err) {
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

/** Live signer for an agent. The derived address must match the trading wallet the DB recorded. */
async function liveSignerFor(deps: Deps, agent: Agent): Promise<OrderSigner> {
  const signer = await deps.wallets.signerFor(agent);
  if (signer.address.toLowerCase() !== agent.tradingWallet.toLowerCase()) {
    throw new Error(`signer ${signer.address} does not match the agent trading wallet ${agent.tradingWallet}`);
  }
  return signer;
}

/** DB rows for an executed order: the order itself and, for paper fills, the simulated fill. */
export function orderRows(
  exec: ExecutionResult,
  agent: Pick<Agent, "id" | "tradingWallet">,
  intent: OrderIntent,
  now: number,
): { record: OrderRecord; fills: FillRecord[] } {
  const base = {
    id: exec.orderId,
    agentId: agent.id,
    funderAddress: agent.tradingWallet,
    side: intent.side,
    asset: intent.asset,
    orderType: intent.orderType,
    notionalUsd: intent.notionalUsd,
    createdAt: now,
    updatedAt: now,
  };
  if (exec.paper) {
    return {
      record: {
        ...base,
        status: exec.status,
        raw: { paper: true, quoteId: exec.quote.quoteId, fill: exec.fill },
      },
      fills: [
        {
          id: `${exec.orderId}:fill`,
          orderId: exec.orderId,
          price: exec.fill.price,
          qty: exec.fill.qty,
          notionalUsd: exec.fill.notionalUsd,
          feeUsd: Number(exec.quote.fees.estimatedFeeNotional) || 0,
          integratorFeeUsd: 0,
          txId: null,
          ts: exec.fill.ts,
        },
      ],
    };
  }
  return {
    record: {
      ...base,
      status: exec.status,
      raw: { quoteId: exec.quote.quoteId, attachedBracketStatus: exec.attachedBracketStatus },
    },
    fills: [],
  };
}
