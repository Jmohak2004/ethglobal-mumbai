// Mark-to-market snapshot of an agent's book (paper or live), derived from its fills. Pure math in
// computePortfolio; snapshotPortfolio loads the fills and marks. The book starts with cash equal to the
// owner's allocation (config.limits.maxAllocationUsd).

import type { PortfolioPosition, PortfolioSnapshot } from "@arena/db";
import { computeFifoPnl, type Trade } from "@arena/flash";
import type { Agent } from "@arena/shared";
import type { Deps } from "./deps.ts";
import { loadAgentState } from "./execution.ts";

/**
 * Cash = starting cash + realized PnL - cost basis of the open lots. Equity = cash + market value of the open lots,
 * which equals starting cash + realized + unrealized. Fees are inside the cost basis and the sale proceeds.
 * avgPriceUsd is the cost basis per unit including fees. A missing or invalid mark falls back to that cost basis,
 * so its unrealized PnL reads as zero.
 */
export function computePortfolio(fills: Trade[], startingCashUsd: number, marks: Record<string, number>, asOf = 0): PortfolioSnapshot {
  const fifo = computeFifoPnl(fills);
  let openCost = 0;
  let value = 0;
  let unrealized = 0;
  const positions: PortfolioPosition[] = fifo.openPositions.map((p) => {
    const known = marks[p.asset];
    const markPriceUsd = typeof known === "number" && Number.isFinite(known) && known > 0 ? known : p.avgCostUsd;
    const valueUsd = p.qty * markPriceUsd;
    const unrealizedPnlUsd = valueUsd - p.costUsd;
    openCost += p.costUsd;
    value += valueUsd;
    unrealized += unrealizedPnlUsd;
    return { asset: p.asset, qty: p.qty, avgPriceUsd: p.avgCostUsd, markPriceUsd, valueUsd, unrealizedPnlUsd };
  });
  const cashUsd = startingCashUsd + fifo.realizedPnlUsd - openCost;
  return {
    cashUsd,
    positions,
    equityUsd: cashUsd + value,
    realizedPnlUsd: fifo.realizedPnlUsd,
    unrealizedPnlUsd: unrealized,
    asOf,
  };
}

/** Loads the agent's fills, marks each open asset with the market snapshot price, and computes the book. */
export async function snapshotPortfolio(deps: Pick<Deps, "db" | "market" | "logger">, agent: Agent, now: number): Promise<PortfolioSnapshot> {
  const state = await loadAgentState(deps.db, agent, now);
  const marks: Record<string, number> = {};
  for (const position of state.fifo.openPositions) {
    try {
      marks[position.asset] = (await deps.market.getSnapshot(position.asset)).priceUsd;
    } catch (err) {
      deps.logger.warn("portfolio mark unavailable, valuing at cost", { agent: agent.id, asset: position.asset, error: err });
    }
  }
  return computePortfolio(state.trades, agent.config.limits.maxAllocationUsd, marks, now);
}
