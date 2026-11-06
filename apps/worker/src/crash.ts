// Crash protection (PRD 6.5, layer 3). When the RiskOracle reports HALT, every active agent:
//   1. cancels its pending entry (buy) orders;
//   2. then, per crashMode, either tightens each open position's stop-loss to max(current, mark x (1 - 1%)),
//      or flattens the position to USDC as a sell intent that goes through the policy engine and executor.
// CAUTION does nothing here: the policy engine already halves size and blocks breakout entries.
// Each action is written as an episode whose reason starts with "RiskOracle HALT", and logged.
// The guard acts once per HALT report (asOf), so repeated reads of the same report do nothing.
// The same cancel step runs on the kill-switch path (tick.ts), so exits stay possible while trading is off.

import { newId, orders as ordersTable, upsertOrder, type OrderRecord } from "@arena/db";
import { OPEN_ORDER_STATUSES } from "@arena/flash";
import { evaluate } from "@arena/policy";
import type {
  Agent,
  BudgetTier,
  DecisionOutput,
  Episode,
  FlashOrderType,
  OrderIntent,
  PolicyContext,
  PolicyVerdict,
  Proposal,
} from "@arena/shared";
import type { Deps, RiskReading } from "./deps.ts";
import { loadAgentState, persistTick, placeOrder, type AgentState, type Persistence } from "./execution.ts";

export const HALT_REASON = "RiskOracle HALT";
/** PRD 6.5: stops are moved to at least mark x (1 - this %). */
export const STOP_BUFFER_PCT = 1;
const DUST_QTY = 1e-12;

const PENDING_ENTRY_STATUSES: string[] = ["submitted", ...OPEN_ORDER_STATUSES];
const CLOSED_STATUSES: string[] = ["ORDER_STATUS_CANCELLED", "ORDER_STATUS_REJECTED", "ORDER_STATUS_TERMINATED", "cancelled"];
const CANCELLED = "ORDER_STATUS_CANCELLED";

type OrderRow = typeof ordersTable.$inferSelect;

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Paper orders never reach Flash, so their cancel and stop changes are database-only. */
const isPaper = (o: Pick<OrderRow, "raw">): boolean => (o.raw as Record<string, unknown>)?.paper === true;

function stopLossOf(o: Pick<OrderRow, "raw">): number | null {
  const bracket = (o.raw as Record<string, unknown>)?.attachedBracket as { stopLossPrice?: unknown } | null | undefined;
  const value = bracket?.stopLossPrice;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const toRecord = (o: OrderRow, patch: Partial<OrderRecord> = {}): OrderRecord => ({
  id: o.id,
  agentId: o.agentId,
  funderAddress: o.funderAddress,
  side: o.side as OrderIntent["side"],
  asset: o.asset,
  orderType: o.orderType as FlashOrderType,
  notionalUsd: o.notionalUsd,
  status: o.status,
  raw: o.raw,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
  ...patch,
});

export interface CancelResult {
  cancelled: Array<{ orderId: string; asset: string }>;
  failed: Array<{ orderId: string; asset: string; error: string }>;
}

/**
 * Cancels the agent's unfilled buy orders. Paper orders are marked cancelled in the database. Live orders
 * go to Flash first, through deps.orderControl; without that, each live order fails with a clear error.
 */
export async function cancelPendingEntries(deps: Deps, agent: Agent, now: number): Promise<CancelResult> {
  const result: CancelResult = { cancelled: [], failed: [] };
  const pending = await deps.db.query.orders.findMany({
    where: (o, { and, eq, inArray }) => and(eq(o.agentId, agent.id), eq(o.side, "buy"), inArray(o.status, PENDING_ENTRY_STATUSES)),
  });
  for (const order of pending) {
    try {
      if (!isPaper(order)) {
        if (!deps.orderControl) throw new Error("live cancel needs Flash cancel signing, which is not configured");
        await deps.orderControl.cancelOrder(order.id, order.funderAddress);
      }
      await upsertOrder(deps.db, toRecord(order, { status: CANCELLED, updatedAt: now }));
      result.cancelled.push({ orderId: order.id, asset: order.asset });
    } catch (err) {
      result.failed.push({ orderId: order.id, asset: order.asset, error: msg(err) });
    }
  }
  return result;
}

export interface StopMove {
  orderId: string;
  asset: string;
  from: number;
  to: number;
}

export interface TightenResult {
  moved: StopMove[];
  failed: Array<{ orderId: string | null; asset: string; error: string }>;
}

/**
 * Raises the stop-loss on every open buy of `asset` that has a recorded stop, to max(current, mark x (1 - 1%)).
 * "Open" means not cancelled or rejected. Lot-level matching is not available, so a buy that has already
 * closed may be included. Live orders need deps.orderControl; paper stops are recorded on the order.
 */
export async function tightenStops(deps: Deps, agent: Agent, asset: string, mark: number, now: number): Promise<TightenResult> {
  const result: TightenResult = { moved: [], failed: [] };
  const target = mark * (1 - STOP_BUFFER_PCT / 100);
  const buys = await deps.db.query.orders.findMany({
    where: (o, { and, eq, notInArray }) =>
      and(eq(o.agentId, agent.id), eq(o.side, "buy"), eq(o.asset, asset), notInArray(o.status, CLOSED_STATUSES)),
  });
  const withStop = buys.filter((o) => stopLossOf(o) !== null);
  if (withStop.length === 0) {
    result.failed.push({ orderId: null, asset, error: `no recorded stop-loss on open ${asset} entries to tighten` });
    return result;
  }

  for (const order of withStop) {
    const from = stopLossOf(order) as number;
    const to = Math.max(from, target);
    if (to <= from) continue; // already at or above the target
    try {
      if (!isPaper(order)) {
        if (!deps.orderControl) throw new Error("live stop changes need Flash order signing, which is not configured");
        await deps.orderControl.setStopLoss(order.id, order.funderAddress, to);
      }
      const bracket = (order.raw as Record<string, unknown>).attachedBracket as Record<string, unknown>;
      await upsertOrder(
        deps.db,
        toRecord(order, {
          raw: { ...order.raw, attachedBracket: { ...bracket, stopLossPrice: to }, stopLossTightenedAt: now },
          updatedAt: now,
        }),
      );
      result.moved.push({ orderId: order.id, asset, from, to });
    } catch (err) {
      result.failed.push({ orderId: order.id, asset, error: msg(err) });
    }
  }
  return result;
}

export interface FlattenResult {
  decision: DecisionOutput;
  verdict: PolicyVerdict;
  orderId: string | null;
  order: Persistence["order"];
  error: string | null;
}

/**
 * Sells the whole position in `asset` to USDC. The sell is a market intent, and it goes through evaluate()
 * like any other order. The policy's caps still apply to exits: maxTradeUsd and the daily volume cap can
 * clamp or reject the sell, and that verdict is what gets recorded.
 */
export async function flattenPosition(
  deps: Deps,
  agent: Agent,
  position: { asset: string; qty: number },
  mark: number,
  state: AgentState,
  budgetTier: BudgetTier,
  now: number,
): Promise<FlattenResult> {
  const rationale = `${HALT_REASON}: flatten ${position.asset} to USDC`;
  const proposal: Proposal = { action: "sell", asset: position.asset, orderType: "market", sizePct: 1, rationale };
  const decision: DecisionOutput = { forecast: null, proposal };
  const ctx: PolicyContext = {
    config: agent.config,
    riskLevel: "HALT",
    budgetTier,
    openPositions: state.fifo.openPositions.length,
    dailyPnlUsd: state.dailyPnlUsd,
    dailyVolumeUsd: state.dailyVolumeUsd,
    drawdownPct: state.fifo.maxDrawdownPct,
    lastTradeAt: state.lastTradeAt,
    now,
    markPrice: mark,
    allocationUsd: agent.config.limits.maxAllocationUsd,
    global: deps.globalLimits,
    forecast: null,
    positionUsd: position.qty * mark,
  };
  const verdict = evaluate(proposal, ctx);
  if (verdict.kind !== "approve" && verdict.kind !== "clamp") {
    return { decision, verdict, orderId: null, order: null, error: null };
  }
  try {
    const placed = await placeOrder(deps, agent, verdict.order, mark, now);
    return { decision, verdict, orderId: placed.orderId, order: placed.persist, error: null };
  } catch (err) {
    return { decision, verdict, orderId: null, order: null, error: `flatten ${position.asset} failed: ${msg(err)}` };
  }
}

export interface HaltSummary {
  asOf: number | null;
  agents: number;
  cancelled: number;
  stopsTightened: number;
  flattened: number;
  failures: number;
}

/** The budget tier is recorded on the episode for display only. An unreadable budget does not stop the HALT actions. */
async function tierFor(deps: Deps, agent: Agent): Promise<BudgetTier> {
  try {
    return (await deps.budget.forAgent(agent)).tier;
  } catch {
    return "healthy";
  }
}

/** Runs the HALT actions for the given agents. Every action is recorded as an episode and logged. */
export async function runHaltActions(deps: Deps, agents: Agent[], risk: RiskReading): Promise<HaltSummary> {
  const summary: HaltSummary = { asOf: risk.asOf, agents: agents.length, cancelled: 0, stopsTightened: 0, flattened: 0, failures: 0 };
  const makeId = deps.newId ?? newId;

  for (const agent of agents) {
    const log = deps.logger.child({ agent: agent.id, riskAsOf: risk.asOf });
    const budgetTier = await tierFor(deps, agent);

    const record = async (parts: {
      decision: DecisionOutput;
      verdict: PolicyVerdict;
      orderIds?: string[];
      order?: Persistence["order"];
      error?: string | null;
      note: string;
    }) => {
      const now = deps.clock.now();
      const episode: Episode = {
        id: makeId(),
        agentId: agent.id,
        ts: now,
        riskLevel: "HALT",
        budgetTier,
        market: [],
        decision: parts.decision,
        inference: null,
        verdict: parts.verdict,
        flashOrderIds: parts.orderIds ?? [],
        zgStorageRoot: null,
        error: parts.error ?? null,
      };
      try {
        await persistTick(deps.db, episode, { traces: [], forecast: null, order: parts.order ?? null });
      } catch (err) {
        log.error("could not record HALT episode", { error: err });
      }
      if (parts.error) {
        summary.failures += 1;
        log.error(`${HALT_REASON}: ${parts.note} failed`, { error: parts.error });
      } else {
        log.warn(`${HALT_REASON}: ${parts.note}`, {});
      }
    };

    try {
      const now = deps.clock.now();

      // Step 1: cancel pending entries (both modes).
      const cancel = await cancelPendingEntries(deps, agent, now);
      for (const c of cancel.cancelled) {
        summary.cancelled += 1;
        const reason = `${HALT_REASON}: cancelled pending buy ${c.orderId} (${c.asset})`;
        await record({
          decision: { forecast: null, proposal: { action: "cancel", asset: c.asset, rationale: reason } },
          verdict: { kind: "noop", reasons: [reason] },
          orderIds: [c.orderId],
          note: `cancel ${c.orderId}`,
        });
      }
      for (const f of cancel.failed) {
        const reason = `${HALT_REASON}: cancel pending buy ${f.orderId} (${f.asset})`;
        await record({
          decision: { forecast: null, proposal: { action: "cancel", asset: f.asset, rationale: reason } },
          verdict: { kind: "noop", reasons: [reason] },
          orderIds: [f.orderId],
          error: f.error,
          note: `cancel ${f.orderId}`,
        });
      }

      // Step 2: protect or exit each open position, according to the agent's crash mode.
      const state = await loadAgentState(deps.db, agent, now);
      for (const pos of state.fifo.openPositions) {
        if (!(pos.qty > DUST_QTY)) continue;
        let mark: number;
        try {
          mark = await deps.market.getPrice(pos.asset);
        } catch (err) {
          await record({
            decision: { forecast: null, proposal: { action: "adjust_stops", asset: pos.asset, rationale: `${HALT_REASON}: no mark price for ${pos.asset}` } },
            verdict: { kind: "noop", reasons: [`${HALT_REASON}: no mark price for ${pos.asset}`] },
            error: msg(err),
            note: `mark ${pos.asset}`,
          });
          continue;
        }

        if (agent.config.crashMode === "tighten_stops") {
          const tight = await tightenStops(deps, agent, pos.asset, mark, now);
          for (const m of tight.moved) {
            summary.stopsTightened += 1;
            const reason = `${HALT_REASON}: stop-loss on ${m.orderId} (${pos.asset}) raised from ${m.from.toFixed(2)} to ${m.to.toFixed(2)}`;
            await record({
              decision: { forecast: null, proposal: { action: "adjust_stops", asset: pos.asset, rationale: reason } },
              verdict: { kind: "noop", reasons: [reason] },
              orderIds: [m.orderId],
              note: `tighten ${m.orderId}`,
            });
          }
          for (const f of tight.failed) {
            const reason = `${HALT_REASON}: tighten stop on ${f.orderId ?? pos.asset}`;
            await record({
              decision: { forecast: null, proposal: { action: "adjust_stops", asset: pos.asset, rationale: reason } },
              verdict: { kind: "noop", reasons: [reason] },
              orderIds: f.orderId ? [f.orderId] : [],
              error: f.error,
              note: reason,
            });
          }
        } else {
          const flat = await flattenPosition(deps, agent, pos, mark, state, budgetTier, now);
          if (flat.orderId) summary.flattened += 1;
          await record({
            decision: flat.decision,
            verdict: flat.verdict,
            orderIds: flat.orderId ? [flat.orderId] : [],
            order: flat.order,
            error: flat.error,
            note: `flatten ${pos.asset}`,
          });
        }
      }
    } catch (err) {
      summary.failures += 1;
      log.error(`${HALT_REASON}: actions for agent failed`, { error: err });
    }
  }
  return summary;
}

export interface CrashGuardOptions {
  deps: Deps;
  /** Agents to act on. The guard filters to status "active". */
  loadAgents: () => Promise<Agent[]>;
}

export interface CrashGuard {
  /**
   * Reads the risk level. On HALT, runs the HALT actions once per report (asOf). Returns the summary when
   * actions ran, or null otherwise. A reset to NORMAL or CAUTION re-arms the guard.
   */
  check(): Promise<HaltSummary | null>;
}

export function createCrashGuard(opts: CrashGuardOptions): CrashGuard {
  let acted: { asOf: number | null } | null = null;
  return {
    async check() {
      const risk = await opts.deps.risk.reading();
      if (risk.level !== "HALT") {
        acted = null;
        return null;
      }
      if (acted && acted.asOf === risk.asOf) return null;

      acted = { asOf: risk.asOf };
      try {
        const agents = (await opts.loadAgents()).filter((a) => a.status === "active");
        const summary = await runHaltActions(opts.deps, agents, risk);
        opts.deps.logger.warn(`${HALT_REASON}: handled`, { ...summary });
        return summary;
      } catch (err) {
        // Re-arm so the next check retries. Every step is idempotent, so a retry does no harm.
        acted = null;
        throw err;
      }
    },
  };
}
