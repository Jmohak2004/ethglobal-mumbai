// Humans board (PRD 6.13). Users who opted in are ranked on their own Flash fills. Each run syncs their orders by
// funder address, then recomputes their PerformanceStats (kind "human") with the same FIFO PnL the agents use.
// Human orders have no agent (agentId null), so they never feed an agent's decisions.

import { insertFills, listHumansOptedIn, upsertOrder, upsertStats, type Db, type StatsInput, type UserRecord } from "@arena/db";
import { computeFifoPnl, OPEN_ORDER_STATUSES, type FlashClient } from "@arena/flash";
import type { Clock } from "./deps.ts";
import { tradesFrom } from "./execution.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { fillRecordsFromDetail } from "./stats.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface HumansOptions {
  db: Db;
  flash: Pick<FlashClient, "listAllOrders" | "getOrder">;
  clock: Clock;
  logger?: Logger;
}

export interface HumansSyncResult {
  users: number;
  /** Order details fetched from Flash this run (new, changed or still open). */
  ordersFetched: number;
  /** Fill rows written this run (idempotent on fill id). */
  fillsWritten: number;
  /** Users whose Flash sync failed. Their stored fills still feed the stats. */
  failedUsers: number;
  statsRows: number;
}

/** Name shown on the board: the display name, or a short address. */
export function humanDisplayName(user: Pick<UserRecord, "address" | "displayName">): string {
  const name = user.displayName?.trim();
  return name ? name : `${user.address.slice(0, 6)}...${user.address.slice(-4)}`;
}

/**
 * Syncs Flash orders and fills for every opted-in user, then recomputes their stats. A Flash failure for one user is
 * logged and does not stop the others.
 */
export async function syncHumans(opts: HumansOptions): Promise<HumansSyncResult> {
  const logger = opts.logger ?? silentLogger;
  const users = await listHumansOptedIn(opts.db);
  const result: HumansSyncResult = { users: users.length, ordersFetched: 0, fillsWritten: 0, failedUsers: 0, statsRows: 0 };

  for (const user of users) {
    try {
      const synced = await syncFunderOrders(opts, user.address);
      result.ordersFetched += synced.ordersFetched;
      result.fillsWritten += synced.fillsWritten;
    } catch (err) {
      result.failedUsers += 1;
      logger.warn("humans: flash sync failed for user; will retry", { user: user.address, error: err });
    }
  }
  result.statsRows = await recomputeHumanStats({ db: opts.db, clock: opts.clock, logger });
  return result;
}

/**
 * Lists every Flash order for one funder. Details (fills) are fetched only for orders that are new, whose status
 * changed, or that are still open. A finished order that did not change is skipped.
 */
async function syncFunderOrders(opts: HumansOptions, funder: string): Promise<{ ordersFetched: number; fillsWritten: number }> {
  const logger = opts.logger ?? silentLogger;
  const now = opts.clock.now();
  const listed = await opts.flash.listAllOrders({ funderAddress: funder });
  const stored = await opts.db.query.orders.findMany({
    where: (o, { eq }) => eq(o.funderAddress, funder),
    columns: { id: true, status: true, createdAt: true },
  });
  const known = new Map(stored.map((o) => [o.id, o]));
  let ordersFetched = 0;
  let fillsWritten = 0;

  for (const order of listed) {
    const prior = known.get(order.orderId);
    const open = (OPEN_ORDER_STATUSES as readonly string[]).includes(order.status);
    if (prior && prior.status === order.status && !open) continue;
    try {
      const detail = await opts.flash.getOrder(order.orderId, funder);
      const fills = fillRecordsFromDetail(order.orderId, detail);
      // The order row must exist before its fills (fills reference orders).
      await upsertOrder(opts.db, {
        id: order.orderId,
        agentId: null,
        funderAddress: funder,
        side: order.side,
        asset: order.targetAsset.ticker,
        orderType: order.orderType,
        notionalUsd: fills.reduce((sum, f) => sum + f.notionalUsd, 0),
        status: detail.order.status,
        raw: detail.order as unknown as Record<string, unknown>,
        createdAt: prior?.createdAt ?? (Date.parse(order.placedAt) || now),
        updatedAt: now,
      });
      await insertFills(opts.db, fills);
      ordersFetched += 1;
      fillsWritten += fills.length;
    } catch (err) {
      logger.warn("humans: order sync failed; will retry", { order: order.orderId, error: err });
    }
  }
  return { ordersFetched, fillsWritten };
}

/**
 * Recomputes the stats of every opted-in user from the stored orders and fills (no Flash calls). Returns the number
 * of rows written. Realized PnL is FIFO and net of fees. Win rate and drawdown follow computeFifoPnl. There is no
 * capital base for a human, so the PnL percentage is taken over total buy notional, and the forecast hit rate is 0.
 */
export async function recomputeHumanStats(opts: { db: Db; clock: Clock; logger?: Logger }): Promise<number> {
  const now = opts.clock.now();
  const users = await listHumansOptedIn(opts.db);
  const rows: StatsInput[] = [];

  for (const user of users) {
    const orders = await opts.db.query.orders.findMany({ where: (o, { eq }) => eq(o.funderAddress, user.address) });
    const ids = orders.map((o) => o.id);
    const fillRows =
      ids.length > 0 ? await opts.db.query.fills.findMany({ where: (f, { inArray }) => inArray(f.orderId, ids) }) : [];
    const trades = tradesFrom(orders, fillRows);
    const fifo = computeFifoPnl(trades);
    const boughtUsd = trades.filter((t) => t.side === "buy").reduce((sum, t) => sum + t.notionalUsd, 0);
    const closing = fifo.wins + fifo.losses;

    rows.push({
      entityId: user.address,
      kind: "human",
      name: humanDisplayName(user),
      template: null,
      mode: "live",
      realizedPnlUsd: fifo.realizedPnlUsd,
      realizedPnlPct: boughtUsd > 0 ? (fifo.realizedPnlUsd / boughtUsd) * 100 : 0,
      volumeUsd: fifo.volumeUsd,
      trades: fifo.trades,
      winRateBps: closing > 0 ? Math.round((fifo.wins / closing) * 10_000) : 0,
      maxDrawdownBps: Math.round(fifo.maxDrawdownPct * 100),
      forecastHitRateBps: 0,
      daysActive: Math.max(0, Math.floor((now - user.createdAt) / DAY_MS)),
      updatedAt: now,
    });
  }

  await upsertStats(opts.db, rows);
  opts.logger?.info("humans stats recomputed", { users: users.length });
  return rows.length;
}
