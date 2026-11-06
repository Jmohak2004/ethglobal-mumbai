// Order placement and ledger writes shared by the decision tick and the crash guard. Nothing here decides
// what to trade: callers pass a policy-approved OrderIntent. Paper orders never sign.

import {
  insertEpisode,
  insertForecast,
  insertFills,
  insertGuardrailBlock,
  insertInference,
  upsertOrder,
  type Db,
  type FillRecord,
  type InsertForecastInput,
  type OrderRecord,
} from "@arena/db";
import { computeFifoPnl, type ExecutionResult, type FifoPnlResult, type OrderSigner, type Trade } from "@arena/flash";
import type { Agent, Episode, ExecutionMode, InferenceTrace, OrderIntent } from "@arena/shared";
import type { Deps } from "./deps.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Paper mode never signs, so the funder is the trading address and signing throws if it is ever reached. */
export function paperSigner(agent: Pick<Agent, "tradingWallet">): OrderSigner {
  return {
    address: agent.tradingWallet,
    signTypedData: async () => {
      throw new Error("paper mode never signs orders");
    },
  };
}

/** Live signer for an agent. The derived address must match the trading wallet the DB recorded. */
export async function liveSignerFor(deps: Pick<Deps, "wallets">, agent: Agent): Promise<OrderSigner> {
  const signer = await deps.wallets.signerFor(agent);
  if (signer.address.toLowerCase() !== agent.tradingWallet.toLowerCase()) {
    throw new Error(`signer ${signer.address} does not match the agent trading wallet ${agent.tradingWallet}`);
  }
  return signer;
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
  // The attached bracket is kept on the order so that later stop management (crash guard) can find it.
  const bracket = intent.attachedBracket ?? null;
  if (exec.paper) {
    return {
      record: {
        ...base,
        status: exec.status,
        raw: { paper: true, quoteId: exec.quote.quoteId, fill: exec.fill, attachedBracket: bracket },
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
      raw: { quoteId: exec.quote.quoteId, attachedBracketStatus: exec.attachedBracketStatus, attachedBracket: bracket },
    },
    fills: [],
  };
}

export interface PlacedOrder {
  orderId: string;
  mode: ExecutionMode;
  /** Rows to persist with the episode. */
  persist: { record: OrderRecord; fills: FillRecord[] };
}

/** Live only when the platform and the agent both allow it. */
export function modeFor(deps: Pick<Deps, "executionMode">, agent: Pick<Agent, "mode">): ExecutionMode {
  return deps.executionMode === "live" && agent.mode === "live" ? "live" : "paper";
}

/**
 * Sends one policy-approved intent through the executor, in the mode modeFor() gives. Throws on failure;
 * the caller decides how to record it.
 */
export async function placeOrder(
  deps: Pick<Deps, "executionMode" | "wallets" | "executor">,
  agent: Agent,
  intent: OrderIntent,
  referencePriceUsd: number,
  now: number,
): Promise<PlacedOrder> {
  const mode = modeFor(deps, agent);
  const signer = mode === "live" ? await liveSignerFor(deps, agent) : paperSigner(agent);
  const exec = await deps.executor.execute(intent, signer, mode, { referencePriceUsd });
  return { orderId: exec.orderId, mode, persist: orderRows(exec, agent, intent, now) };
}

export interface Persistence {
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
