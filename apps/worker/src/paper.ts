// Paper-mode economics. Paper agents only, and nothing here sends an order or touches the onchain treasury.
//   - Take-profit / stop-loss monitor (PRD 6.5): a bracket entry whose mark crosses its TP or SL is closed with a
//     simulated sell at the mark. The exit is recorded like a paper fill in execution.ts and shows in the decision log.
//   - Self-funding (PRD 6.11, simulated): commission on realized PnL above its high-water mark, then a paper top-up
//     that converts the ledger balance into 0G credit.

import { insertPaperLedger, newId, paperLedgerTotals, type Db, type FillRecord, type OrderRecord } from "@arena/db";
import { computeFifoPnl, type Trade } from "@arena/flash";
import type { Agent, BudgetTier, Episode, OrderIntent, RiskLevel } from "@arena/shared";
import type { Deps } from "./deps.ts";
import { persistTick, tradesFrom } from "./execution.ts";

/** Used when ZG_PER_USDC is not set. Same meaning as the relayer's fallback rate. */
export const DEFAULT_ZG_PER_USDC = 6;
export const COMMISSION_NOTE = "paper commission on new high-water mark";
export const TOPUP_NOTE = "paper top-up";
const EPS = 1e-12;
const TOPUP_TIERS: BudgetTier[] = ["low", "critical", "empty"];

export type PaperDeps = Pick<Deps, "db" | "clock" | "logger" | "market" | "risk" | "budget" | "newId">;
export type LedgerDeps = Pick<Deps, "db" | "clock" | "logger">;

type OrderRow = Awaited<ReturnType<Db["query"]["orders"]["findMany"]>>[number];

/** A trade in the paper book. closesOrderId is set on exits, so they consume their own bracket order first. */
export interface LotEntry {
  trade: Trade;
  closesOrderId: string | null;
}

export interface PaperBracket {
  orderId: string;
  asset: string;
  takeProfitPrice: number;
  stopLossPrice: number;
  /** Entry fee per USD of notional, used to estimate the exit fee. */
  feeRatio: number;
}

export interface PaperBook {
  trades: Trade[];
  entries: LotEntry[];
  brackets: PaperBracket[];
}

const isPaperOrder = (o: Pick<OrderRow, "raw">): boolean => (o.raw as Record<string, unknown>)?.paper === true;

function closesOrderIdOf(o: Pick<OrderRow, "raw">): string | null {
  const value = (o.raw as Record<string, unknown>)?.closesOrderId;
  return typeof value === "string" ? value : null;
}

function bracketPricesOf(o: Pick<OrderRow, "raw">): { takeProfitPrice: number; stopLossPrice: number } | null {
  const b = (o.raw as Record<string, unknown>)?.attachedBracket as { takeProfitPrice?: unknown; stopLossPrice?: unknown } | null | undefined;
  const tp = b?.takeProfitPrice;
  const sl = b?.stopLossPrice;
  if (typeof tp === "number" && Number.isFinite(tp) && typeof sl === "number" && Number.isFinite(sl)) {
    return { takeProfitPrice: tp, stopLossPrice: sl };
  }
  return null;
}

/** The agent's paper orders and fills, as trades, plus the bracket entries that TP/SL can close. */
export async function loadPaperBook(db: Db, agentId: string): Promise<PaperBook> {
  const orders = (await db.query.orders.findMany({ where: (o, { eq }) => eq(o.agentId, agentId) })).filter(isPaperOrder);
  const fillRows =
    orders.length > 0 ? await db.query.fills.findMany({ where: (f, { inArray }) => inArray(f.orderId, orders.map((o) => o.id)) }) : [];
  const trades = tradesFrom(orders, fillRows);
  const closes = new Map(orders.map((o) => [o.id, closesOrderIdOf(o)]));
  const entries: LotEntry[] = trades.map((trade) => ({ trade, closesOrderId: closes.get(trade.orderId) ?? null }));

  const brackets: PaperBracket[] = [];
  for (const o of orders) {
    if (o.side !== "buy") continue;
    const prices = bracketPricesOf(o);
    if (!prices) continue;
    const buys = trades.filter((t) => t.orderId === o.id);
    const notional = buys.reduce((s, t) => s + t.notionalUsd, 0);
    const fee = buys.reduce((s, t) => s + t.feeUsd, 0);
    brackets.push({ orderId: o.id, asset: o.asset, ...prices, feeRatio: notional > EPS ? fee / notional : 0 });
  }
  return { trades, entries, brackets };
}

export interface LotState {
  /** Open quantity still attributable to each buy order. */
  remainingByOrder: Map<string, number>;
  openQtyByAsset: Map<string, number>;
}

interface OpenLot {
  orderId: string;
  qty: number;
  unitCostUsd: number;
}

/**
 * Replays the book into open lots. A sell with closesOrderId consumes that order's lots first, then oldest lots
 * (FIFO). Total open quantity per asset matches computeFifoPnl, and only the attribution to orders differs.
 */
export function replayLots(entries: LotEntry[]): LotState {
  const ordered = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.trade.ts - b.e.trade.ts || a.i - b.i)
    .map((x) => x.e);
  const lots = new Map<string, OpenLot[]>();

  for (const { trade: t, closesOrderId } of ordered) {
    const list = lots.get(t.asset) ?? [];
    lots.set(t.asset, list);
    if (t.side === "buy") {
      if (t.qty > EPS) list.push({ orderId: t.orderId, qty: t.qty, unitCostUsd: (t.notionalUsd + t.feeUsd) / t.qty });
      continue;
    }
    let remaining = t.qty;
    if (closesOrderId) remaining = consume(list, remaining, (lot) => lot.orderId === closesOrderId);
    consume(list, remaining, () => true);
  }

  const remainingByOrder = new Map<string, number>();
  const openQtyByAsset = new Map<string, number>();
  for (const [asset, list] of lots) {
    for (const lot of list) {
      remainingByOrder.set(lot.orderId, (remainingByOrder.get(lot.orderId) ?? 0) + lot.qty);
      openQtyByAsset.set(asset, (openQtyByAsset.get(asset) ?? 0) + lot.qty);
    }
  }
  return { remainingByOrder, openQtyByAsset };
}

/** Consumes up to qty from matching lots, oldest first. Returns the quantity that could not be consumed. */
function consume(list: OpenLot[], qty: number, match: (lot: OpenLot) => boolean): number {
  let remaining = qty;
  let i = 0;
  while (i < list.length && remaining > EPS) {
    const lot = list[i];
    if (!lot || !match(lot)) {
      i++;
      continue;
    }
    const take = Math.min(remaining, lot.qty);
    lot.qty -= take;
    remaining -= take;
    if (lot.qty <= EPS) list.splice(i, 1);
    else i++;
  }
  return remaining;
}

/**
 * Highest cumulative realized PnL reached over the trade sequence (0 when never positive). This is the high-water
 * mark commission is charged on, so recovered losses are not charged twice.
 */
export function peakRealizedPnl(trades: Trade[]): number {
  const ordered = trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.ts - b.t.ts || a.i - b.i)
    .map((x) => x.t);
  let peak = 0;
  for (let n = 1; n <= ordered.length; n++) {
    if (ordered[n - 1]?.side !== "sell") continue;
    peak = Math.max(peak, computeFifoPnl(ordered.slice(0, n)).realizedPnlUsd);
  }
  return peak;
}

export interface Trigger {
  reason: "take-profit hit" | "stop-loss hit";
  detail: string;
}

/** A long entry closes at or below its stop-loss, or at or above its take-profit. Stop-loss is checked first. */
export function triggerFor(mark: number, bracket: Pick<PaperBracket, "takeProfitPrice" | "stopLossPrice">): Trigger | null {
  if (!Number.isFinite(mark) || mark <= 0) return null;
  if (mark <= bracket.stopLossPrice) {
    return { reason: "stop-loss hit", detail: `mark ${mark} at or below stop-loss ${bracket.stopLossPrice}` };
  }
  if (mark >= bracket.takeProfitPrice) {
    return { reason: "take-profit hit", detail: `mark ${mark} at or above take-profit ${bracket.takeProfitPrice}` };
  }
  return null;
}

export interface PaperExit {
  orderId: string;
  closesOrderId: string;
  asset: string;
  reason: Trigger["reason"];
  qty: number;
  priceUsd: number;
  notionalUsd: number;
  trade: Trade;
}

/**
 * Checks every paper bracket entry against its mark and closes the ones that were hit. Each exit closes at most the
 * entry's remaining quantity, capped by the asset's open quantity, so a position is never closed twice. Exits are
 * recorded as paper orders and fills, plus an approved episode whose rationale is the trigger.
 */
export async function closePaperBrackets(deps: PaperDeps, agent: Agent): Promise<PaperExit[]> {
  const log = deps.logger.child({ agent: agent.id });
  const book = await loadPaperBook(deps.db, agent.id);
  const exits: PaperExit[] = [];
  if (book.brackets.length === 0) return exits;

  const entries = [...book.entries];
  const marks = new Map<string, number | null>();
  for (const bracket of book.brackets) {
    const state = replayLots(entries);
    const remaining = state.remainingByOrder.get(bracket.orderId) ?? 0;
    const openQty = state.openQtyByAsset.get(bracket.asset) ?? 0;
    const qty = Math.min(remaining, openQty);
    if (qty <= EPS) continue;

    if (!marks.has(bracket.asset)) {
      try {
        marks.set(bracket.asset, (await deps.market.getSnapshot(bracket.asset)).priceUsd);
      } catch (err) {
        log.warn("paper TP/SL: no mark price, position left open", { asset: bracket.asset, error: err });
        marks.set(bracket.asset, null);
      }
    }
    const mark = marks.get(bracket.asset) ?? null;
    if (mark === null) continue;

    const trigger = triggerFor(mark, bracket);
    if (!trigger) continue;

    const exit = await recordExit(deps, agent, bracket, qty, mark, trigger);
    entries.push({ trade: exit.trade, closesOrderId: bracket.orderId });
    exits.push(exit);
    log.info(`paper ${trigger.reason}: closed ${qty} ${bracket.asset}`, { orderId: exit.orderId, closesOrderId: bracket.orderId, mark });
  }
  return exits;
}

async function recordExit(
  deps: PaperDeps,
  agent: Agent,
  bracket: PaperBracket,
  qty: number,
  mark: number,
  trigger: Trigger,
): Promise<PaperExit> {
  const makeId = deps.newId ?? newId;
  const now = deps.clock.now();
  const orderId = `paper-${makeId()}`;
  const notionalUsd = qty * mark;
  const feeUsd = notionalUsd * bracket.feeRatio;
  const intent: OrderIntent = { side: "sell", asset: bracket.asset, quoteAsset: "USDC", orderType: "market", notionalUsd };

  // Same shape as execution.ts orderRows() for a paper fill: the order, plus one simulated fill at the mark.
  const record: OrderRecord = {
    id: orderId,
    agentId: agent.id,
    funderAddress: agent.tradingWallet,
    side: "sell",
    asset: bracket.asset,
    orderType: "market",
    notionalUsd,
    status: "simulated_fill",
    raw: {
      paper: true,
      exit: true,
      reason: trigger.reason,
      detail: trigger.detail,
      closesOrderId: bracket.orderId,
      fill: { qty, price: mark, notionalUsd, ts: now },
      attachedBracket: null,
    },
    createdAt: now,
    updatedAt: now,
  };
  const fills: FillRecord[] = [
    { id: `${orderId}:fill`, orderId, price: mark, qty, notionalUsd, feeUsd, integratorFeeUsd: 0, txId: null, ts: now },
  ];

  const risk: RiskLevel = await deps.risk.current().catch(() => "NORMAL" as const);
  const budgetTier: BudgetTier = await deps.budget
    .forAgent(agent)
    .then((r) => r.tier)
    .catch(() => "healthy" as const);
  const rationale = `${trigger.reason}: ${trigger.detail}`;
  const episode: Episode = {
    id: makeId(),
    agentId: agent.id,
    ts: now,
    riskLevel: risk,
    budgetTier,
    market: [],
    decision: { forecast: null, proposal: { action: "sell", asset: bracket.asset, orderType: "market", rationale } },
    inference: null,
    verdict: { kind: "approve", order: intent },
    flashOrderIds: [orderId],
    zgStorageRoot: null,
    error: null,
  };
  await persistTick(deps.db, episode, { traces: [], forecast: null, order: { record, fills } });

  return {
    orderId,
    closesOrderId: bracket.orderId,
    asset: bracket.asset,
    reason: trigger.reason,
    qty,
    priceUsd: mark,
    notionalUsd,
    trade: {
      orderId,
      side: "sell",
      asset: bracket.asset,
      qty,
      price: mark,
      notionalUsd,
      feeUsd,
      integratorFeeUsd: 0,
      txId: "", // same as tradesFrom() for a fill with no tx id
      ts: now,
    },
  };
}

/**
 * Accrues commission owed on the high-water mark: owed = max(0, HWM) x commissionBps / 10000 (the same formula
 * as the onchain registry). Only the difference from commission already on the ledger is inserted, so repeated
 * calls never charge twice and a drawdown below the mark charges nothing. Returns the amount accrued.
 */
export async function settlePaperCommission(deps: LedgerDeps, agent: Agent): Promise<number> {
  const log = deps.logger.child({ agent: agent.id });
  const book = await loadPaperBook(deps.db, agent.id);
  const hwm = peakRealizedPnl(book.trades);
  const owed = (Math.max(0, hwm) * agent.config.commissionBps) / 10_000;
  const totals = await paperLedgerTotals(deps.db, agent.id);
  const delta = owed - totals.commissionUsd;
  log.info("paper commission check", { highWaterMarkUsd: hwm, owedUsd: owed, accruedUsd: totals.commissionUsd });
  if (delta <= EPS) return 0;

  await insertPaperLedger(deps.db, {
    agentId: agent.id,
    kind: "commission",
    amountUsd: delta,
    amount0g: null,
    note: COMMISSION_NOTE,
    ts: deps.clock.now(),
  });
  log.info("paper commission accrued", { amountUsd: delta, highWaterMarkUsd: hwm });
  return delta;
}

export interface TopUpOptions {
  minUsd: number;
  zgPerUsdc: number;
}

/**
 * Converts the whole paper ledger balance into 0G credit once the budget tier is low, critical or empty and the
 * balance reaches minUsd. The balance drops to zero, so the next top-up needs new commission. Returns the row written.
 */
export async function settlePaperTopUp(deps: LedgerDeps, agent: Agent, tier: BudgetTier, opts: TopUpOptions): Promise<{ amountUsd: number; amount0g: number } | null> {
  const log = deps.logger.child({ agent: agent.id });
  if (!TOPUP_TIERS.includes(tier)) return null;
  const totals = await paperLedgerTotals(deps.db, agent.id);
  if (totals.balanceUsd < opts.minUsd || totals.balanceUsd <= 0) {
    log.info("paper top-up skipped: ledger balance below minimum", { tier, balanceUsd: totals.balanceUsd, minUsd: opts.minUsd });
    return null;
  }

  const amountUsd = totals.balanceUsd;
  const amount0g = amountUsd * opts.zgPerUsdc;
  await insertPaperLedger(deps.db, {
    agentId: agent.id,
    kind: "topup",
    amountUsd,
    amount0g,
    note: TOPUP_NOTE,
    ts: deps.clock.now(),
  });
  log.info("paper top-up", { tier, amountUsd, amount0g, zgPerUsdc: opts.zgPerUsdc });
  return { amountUsd, amount0g };
}
