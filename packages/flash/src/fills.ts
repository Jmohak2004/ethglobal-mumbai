// Fill normalization and FIFO PnL for leaderboards. Pure functions, no I/O.

import type { FlashFill, FlashOrder, Trade } from "./types.ts";

const EPS = 1e-12;

function num(name: string, v: string | null | undefined): number {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) {
    throw new Error(`fill field ${name} is not numeric: ${JSON.stringify(v)}`);
  }
  return n;
}

/**
 * Turns GET /orders/{id} output into Trade rows (one per fill).
 * - qty: fill.targetAmount (target units). price: fill.fillPrice (USD per target unit, per the field name).
 * - notionalUsd: fill.notional. feeUsd: fill.feeNotional (total). integratorFeeUsd: fill.integratorFeeNotional.
 * - Fills in CHAIN_STATUS_REORGED are dropped because the chain reverted them.
 */
export function normalizeFills(detail: { order: FlashOrder; fills: FlashFill[] }): Trade[] {
  const { order, fills } = detail;
  return fills
    .filter((f) => f.status !== "CHAIN_STATUS_REORGED")
    .map((f) => ({
      orderId: order.orderId,
      side: order.side,
      asset: order.targetAsset.ticker,
      qty: num("targetAmount", f.targetAmount),
      price: num("fillPrice", f.fillPrice),
      notionalUsd: num("notional", f.notional),
      feeUsd: num("feeNotional", f.feeNotional),
      integratorFeeUsd: num("integratorFeeNotional", f.integratorFeeNotional),
      txId: f.transactionId,
      ts: Date.parse(f.filledAt),
    }))
    .filter((t) => Number.isFinite(t.ts))
    .sort((a, b) => a.ts - b.ts);
}

export interface OpenPosition {
  asset: string;
  qty: number;
  /** Cost basis of the remaining lots, including fees. */
  costUsd: number;
  avgCostUsd: number;
}

export interface FifoPnlResult {
  /** Net of fees (buy cost includes fees; sell proceeds are net of fees). */
  realizedPnlUsd: number;
  /** Sum of notionalUsd over all trades, buys and sells. */
  volumeUsd: number;
  trades: number;
  /** Closing sell trades with realized pnl > 0. */
  wins: number;
  /** Closing sell trades with realized pnl < 0. */
  losses: number;
  /**
   * Peak-to-trough decline of cumulative realized PnL, as a percent of `startingCapitalUsd` when given,
   * otherwise of the peak open cost basis. 0 when there is no base.
   */
  maxDrawdownPct: number;
  openPositions: OpenPosition[];
  /** Sell quantity that exceeded inventory. It is excluded from PnL, not invented as profit. */
  unmatchedSells: { asset: string; qty: number }[];
}

interface Lot {
  qty: number;
  unitCostUsd: number;
}

/**
 * FIFO realized PnL per asset. Buys open lots at (notional + fee) / qty. Sells close the oldest lots first,
 * at (notional - fee) / qty per unit. Trades are processed in ascending ts; ties keep input order.
 */
export function computeFifoPnl(trades: Trade[], opts: { startingCapitalUsd?: number } = {}): FifoPnlResult {
  const ordered = trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.ts - b.t.ts || a.i - b.i)
    .map((x) => x.t);

  const lots = new Map<string, Lot[]>();
  const unmatched = new Map<string, number>();
  let realized = 0;
  let volume = 0;
  let wins = 0;
  let losses = 0;
  let cumulative = 0;
  let peakCumulative = 0;
  let maxDrawdownUsd = 0;
  let peakOpenCost = 0;

  const openCost = () => {
    let total = 0;
    for (const ls of lots.values()) for (const l of ls) total += l.qty * l.unitCostUsd;
    return total;
  };

  for (const t of ordered) {
    volume += t.notionalUsd;
    const list = lots.get(t.asset) ?? [];
    lots.set(t.asset, list);

    if (t.side === "buy") {
      if (t.qty > EPS) {
        const cost = t.notionalUsd + t.feeUsd;
        list.push({ qty: t.qty, unitCostUsd: cost / t.qty });
      }
      peakOpenCost = Math.max(peakOpenCost, openCost());
      continue;
    }

    // Sell: close FIFO lots at the net proceeds per unit.
    const unitProceeds = t.qty > EPS ? (t.notionalUsd - t.feeUsd) / t.qty : 0;
    let remaining = t.qty;
    let tradePnl = 0;
    while (remaining > EPS && list.length > 0) {
      const head = list[0];
      if (!head) break;
      const take = Math.min(remaining, head.qty);
      tradePnl += take * (unitProceeds - head.unitCostUsd);
      head.qty -= take;
      remaining -= take;
      if (head.qty <= EPS) list.shift();
    }
    if (remaining > EPS) {
      unmatched.set(t.asset, (unmatched.get(t.asset) ?? 0) + remaining);
    }

    realized += tradePnl;
    if (tradePnl > EPS) wins += 1;
    else if (tradePnl < -EPS) losses += 1;

    cumulative += tradePnl;
    peakCumulative = Math.max(peakCumulative, cumulative);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peakCumulative - cumulative);
  }

  const base = opts.startingCapitalUsd !== undefined && opts.startingCapitalUsd > 0 ? opts.startingCapitalUsd : peakOpenCost;
  const maxDrawdownPct = base > 0 ? (maxDrawdownUsd / base) * 100 : 0;

  const openPositions: OpenPosition[] = [];
  for (const [asset, ls] of lots) {
    const qty = ls.reduce((s, l) => s + l.qty, 0);
    if (qty <= EPS) continue;
    const costUsd = ls.reduce((s, l) => s + l.qty * l.unitCostUsd, 0);
    openPositions.push({ asset, qty, costUsd, avgCostUsd: costUsd / qty });
  }

  return {
    realizedPnlUsd: realized,
    volumeUsd: volume,
    trades: ordered.length,
    wins,
    losses,
    maxDrawdownPct,
    openPositions,
    unmatchedSells: [...unmatched.entries()].map(([asset, qty]) => ({ asset, qty })),
  };
}
