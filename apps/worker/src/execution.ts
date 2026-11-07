// Order placement and ledger writes shared by the decision tick and the crash guard. Nothing here decides
// what to trade: callers pass a policy-approved OrderIntent. Paper orders never sign.

import { normalizeTrace } from "./billing.ts";
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
import {
  computeFifoPnl,
  FlashApprovalRequiredError,
  type ApprovalRequirements,
  type ExecutionResult,
  type FifoPnlResult,
  type OrderSigner,
  type Trade,
} from "@arena/flash";
import type { Agent, Episode, ExecutionMode, InferenceTrace, OrderIntent } from "@arena/shared";
import type { Hex } from "viem";
import type { Deps } from "./deps.ts";
import type { Logger } from "./logger.ts";
import type { FlashSender, TxRequest } from "./wallets.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Flash setup transactions (quote.setupTxs) must be signed and posted to /setup-transaction. Not implemented yet. */
export const FLASH_SETUP_UNSUPPORTED = "Flash setupTxs not supported yet";

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

/**
 * DB rows for an executed order: the order itself and, for paper fills, the simulated fill. `approvalTxs` are the
 * Flash approval txs mined on Base mainnet before a live order; they are kept on the order's raw record.
 */
export function orderRows(
  exec: ExecutionResult,
  agent: Pick<Agent, "id" | "tradingWallet">,
  intent: OrderIntent,
  now: number,
  approvalTxs: Hex[] = [],
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
      raw: {
        quoteId: exec.quote.quoteId,
        attachedBracketStatus: exec.attachedBracketStatus,
        attachedBracket: bracket,
        ...(approvalTxs.length > 0 ? { approvalTxs } : {}),
      },
    },
    fills: [],
  };
}

export interface PlacedOrder {
  orderId: string;
  mode: ExecutionMode;
  /** Flash approval txs mined on Base mainnet before this order, in send order. Empty when none were needed. */
  approvalTxs: Hex[];
  /** Rows to persist with the episode. */
  persist: { record: OrderRecord; fills: FillRecord[] };
}

/** Live only when the platform and the agent both allow it. */
export function modeFor(deps: Pick<Deps, "executionMode">, agent: Pick<Agent, "mode">): ExecutionMode {
  return deps.executionMode === "live" && agent.mode === "live" ? "live" : "paper";
}

/** The trading wallet's Flash sender on Base mainnet. Checked against the wallet the DB recorded, like liveSignerFor. */
export async function liveFlashSenderFor(deps: Pick<Deps, "wallets">, agent: Agent): Promise<FlashSender> {
  if (!deps.wallets.flashSenderFor) throw new Error("this wallet provider cannot send Flash approvals on Base mainnet");
  const sender = await deps.wallets.flashSenderFor(agent);
  if (sender.address.toLowerCase() !== agent.tradingWallet.toLowerCase()) {
    throw new Error(`flash sender ${sender.address} does not match the agent trading wallet ${agent.tradingWallet}`);
  }
  return sender;
}

/**
 * Sends the approvals a quote requires on Base mainnet, in order: wrap, approve, bracket approve. Each one must be
 * mined successfully before the next is sent. Every hash is pushed to `sent` as soon as it is mined, so the caller
 * can still record them when a later step fails. Quote setupTxs are refused, not guessed at.
 */
export async function sendFlashApprovals(
  sender: FlashSender,
  reqs: ApprovalRequirements,
  sent: Hex[],
  log: Pick<Logger, "info">,
): Promise<void> {
  if (reqs.setupTxs.length > 0) {
    throw new Error(
      `${FLASH_SETUP_UNSUPPORTED}: the quote needs ${reqs.setupTxs.length} setup transaction(s) first; no approval was sent`,
    );
  }
  const steps: Array<{ label: string; tx: TxRequest }> = [];
  if (reqs.wrapTx) {
    steps.push({ label: "wrap", tx: { to: reqs.wrapTx.to, data: reqs.wrapTx.data, value: BigInt(reqs.wrapTx.value) } });
  }
  if (reqs.approveTx) steps.push({ label: "approve", tx: { to: reqs.approveTx.to, data: reqs.approveTx.data } });
  if (reqs.bracketApproveTx) {
    steps.push({ label: "bracket approve", tx: { to: reqs.bracketApproveTx.to, data: reqs.bracketApproveTx.data } });
  }
  if (steps.length === 0) return;

  const eth = await sender.ethBalance();
  if (eth === 0n) {
    throw new Error(
      `trading wallet ${sender.address} needs gas on Base mainnet: it holds 0 ETH, so it cannot send the Flash approval(s)`,
    );
  }
  for (const step of steps) {
    const res = await sender.sendAndWait(step.tx);
    sent.push(res.hash);
    log.info("flash approval mined", { step: step.label, txHash: res.hash, status: res.status, chain: "base" });
    if (res.status !== "success") {
      throw new Error(`Flash ${step.label} transaction reverted on Base mainnet (tx ${res.hash})`);
    }
  }
}

/** Adds the approval txs already mined to an error, so they are recorded on the episode next to the failure. */
function withApprovalNote(err: unknown, approvalTxs: Hex[]): unknown {
  if (approvalTxs.length === 0) return err;
  const reason = err instanceof Error ? err.message : String(err);
  return new Error(`${reason} (Flash approval txs mined on Base mainnet: ${approvalTxs.join(", ")})`);
}

/**
 * Live execution with at most one approval round. If the quote needs onchain steps, they are sent on Base mainnet and
 * the order is quoted again. A second request for approvals in the same call is an error, so this cannot loop.
 */
async function executeLive(
  deps: Pick<Deps, "wallets" | "executor" | "logger">,
  agent: Agent,
  intent: OrderIntent,
  signer: OrderSigner,
  referencePriceUsd: number,
): Promise<{ exec: ExecutionResult; approvalTxs: Hex[] }> {
  const approvalTxs: Hex[] = [];
  const submit = () => deps.executor.execute(intent, signer, "live", { referencePriceUsd });
  try {
    try {
      return { exec: await submit(), approvalTxs };
    } catch (err) {
      if (!(err instanceof FlashApprovalRequiredError)) throw err;
      const log = deps.logger.child({ agent: agent.id });
      await sendFlashApprovals(await liveFlashSenderFor(deps, agent), err.requirements, approvalTxs, log);
    }
    try {
      return { exec: await submit(), approvalTxs };
    } catch (err) {
      if (err instanceof FlashApprovalRequiredError) {
        throw new Error("Flash still requires onchain setup after the approvals were mined; not sending another approval round");
      }
      throw err;
    }
  } catch (err) {
    throw withApprovalNote(err, approvalTxs);
  }
}

/**
 * Sends one policy-approved intent through the executor, in the mode modeFor() gives. Live orders that need Flash
 * approvals get them sent on Base mainnet first (executeLive). Throws on failure; the caller decides how to record it.
 */
export async function placeOrder(
  deps: Pick<Deps, "executionMode" | "wallets" | "executor" | "logger">,
  agent: Agent,
  intent: OrderIntent,
  referencePriceUsd: number,
  now: number,
): Promise<PlacedOrder> {
  const mode = modeFor(deps, agent);
  if (mode === "paper") {
    const exec = await deps.executor.execute(intent, paperSigner(agent), "paper", { referencePriceUsd });
    return { orderId: exec.orderId, mode, approvalTxs: [], persist: orderRows(exec, agent, intent, now) };
  }
  const signer = await liveSignerFor(deps, agent);
  const { exec, approvalTxs } = await executeLive(deps, agent, intent, signer, referencePriceUsd);
  return { orderId: exec.orderId, mode, approvalTxs, persist: orderRows(exec, agent, intent, now, approvalTxs) };
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
    await insertInference(db, normalizeTrace(trace), { agentId: episode.agentId, purpose: "decision", ts: episode.ts });
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
