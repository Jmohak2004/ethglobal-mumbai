// Agent trades and the equity series for the agent page chart. Server-only.
// Equity is built from the agent's fills: starting cash, one realized-PnL step per fill (FIFO, net of fees, from
// @arena/flash), and the worker's latest mark-to-market equity as the final point. Nothing is synthesized.
import { computeFifoPnl, type Trade } from "@arena/flash";

import type { Db } from "@/lib/server/db";
import type { EquityPoint, OrderTxRef, PortfolioSnapshot } from "@/lib/types";

/** The slice of @arena/db's drizzle relational query API this module uses. The Db is opaque in lib/server/db.ts. */
interface Ops {
  eq(column: unknown, value: unknown): unknown;
  inArray(column: unknown, values: unknown[]): unknown;
  asc(column: unknown): unknown;
}

interface RelationalDb {
  query: {
    orders: {
      findMany(args: {
        where: (t: Record<string, unknown>, ops: Ops) => unknown;
        columns: { id: true; side: true; asset: true };
      }): Promise<{ id: string; side: string; asset: string }[]>;
    };
    fills: {
      findMany(args: {
        where: (t: Record<string, unknown>, ops: Ops) => unknown;
        orderBy: (t: Record<string, unknown>, ops: Ops) => unknown;
        limit: number;
      }): Promise<
        {
          orderId: string;
          price: number;
          qty: number;
          notionalUsd: number;
          feeUsd: number;
          integratorFeeUsd: number;
          txId: string | null;
          ts: number;
        }[]
      >;
    };
  };
}

/** Upper bound on fills read for one chart. The FIFO replay is quadratic in this, so keep it modest. */
const MAX_FILLS = 1000;

/**
 * An agent's fills joined to their orders (side and asset live on the order, not the fill), oldest first. Fills
 * whose order is missing are dropped. Paper fills are rows too, so paper agents chart the same way.
 */
export async function agentTrades(db: Db, agentId: string): Promise<Trade[]> {
  const d = db as unknown as RelationalDb;
  const orders = await d.query.orders.findMany({
    where: (o, { eq }) => eq(o.agentId, agentId),
    columns: { id: true, side: true, asset: true },
  });
  if (orders.length === 0) return [];
  const byId = new Map(orders.map((o) => [o.id, o]));
  const fills = await d.query.fills.findMany({
    where: (f, { inArray }) => inArray(f.orderId, [...byId.keys()]),
    orderBy: (f, { asc }) => asc(f.ts),
    limit: MAX_FILLS,
  });
  const trades: Trade[] = [];
  for (const f of fills) {
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

/**
 * The fill tx of each of an agent's orders, keyed by order id. Agent paper orders have ids prefixed "paper-" (see
 * @arena/flash executor), and their fills carry the TradeJournal tx once the worker has journaled them.
 */
export async function agentOrderTxs(db: Db, agentId: string): Promise<Record<string, OrderTxRef>> {
  const out: Record<string, OrderTxRef> = {};
  for (const t of await agentTrades(db, agentId)) {
    out[t.orderId] = {
      txHash: /^0x[0-9a-fA-F]{64}$/.test(t.txId) ? (t.txId as `0x${string}`) : null,
      paper: t.orderId.startsWith("paper-"),
    };
  }
  return out;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Equity points, oldest first, with strictly increasing chart times (one point per second, the last write wins).
 * - Starts at (startedAt, startUsd).
 * - Each fill adds its cumulative realized PnL: equity = startUsd + realized.
 * - Ends at the worker's latest snapshot (asOf, equityUsd) when there is one. That point includes unrealized PnL.
 * With no trades it returns [] (the chart shows its empty state).
 */
export function equitySeries(input: {
  startUsd: number;
  startedAt: number;
  trades: Trade[];
  latest?: PortfolioSnapshot | null;
}): EquityPoint[] {
  const { startUsd, trades } = input;
  if (trades.length === 0) return [];
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);

  const raw: EquityPoint[] = [{ t: input.startedAt, equityUsd: round2(startUsd), pnlUsd: 0 }];
  for (let i = 0; i < sorted.length; i++) {
    const trade = sorted[i];
    if (!trade) continue;
    const realized = computeFifoPnl(sorted.slice(0, i + 1)).realizedPnlUsd;
    raw.push({ t: trade.ts, equityUsd: round2(startUsd + realized), pnlUsd: round2(realized) });
  }

  const last = raw[raw.length - 1];
  if (input.latest && last) {
    const t = Math.max(input.latest.asOf, last.t);
    raw.push({ t, equityUsd: round2(input.latest.equityUsd), pnlUsd: round2(input.latest.equityUsd - startUsd) });
  }

  const byChartSecond = new Map<number, EquityPoint>();
  for (const p of raw) byChartSecond.set(Math.floor(p.t / 1000), p);
  return [...byChartSecond.values()].sort((a, b) => a.t - b.t);
}
