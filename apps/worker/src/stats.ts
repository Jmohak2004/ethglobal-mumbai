// Leaderboard stats and onchain verification.
//   recomputeStats:      FIFO PnL, volume, win rate, drawdown and forecast hit rate per agent, from our fills.
//                        Writes unverified rows, but keeps any verification a previous sync recorded.
//   syncAttestations:    reads PerformanceRegistry.getPerformance per agent and the latest
//                        PerformanceReported log, then marks the stats row verified with that tx.

import {
  insertAttestation,
  insertFills,
  leaderboard,
  upsertOrder,
  upsertStats,
  type Db,
  type FillRecord,
  type StatsInput,
} from "@arena/db";
import { computeFifoPnl, normalizeFills, OPEN_ORDER_STATUSES, type FlashClient, type FlashGetOrderResponse } from "@arena/flash";
import { agentIdToBytes32, type ExecutionMode, type FlashOrderType, type OrderIntent, type TemplateId } from "@arena/shared";
import type { Hex, PublicClient } from "viem";
import { PERFORMANCE_REGISTRY_ABI } from "./abi.ts";
import type { Clock } from "./deps.ts";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";
import { tradesFrom } from "./tick.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const STATS_LIMIT = 500;

export interface PerfReading {
  asOf: bigint;
  realizedPnlUsd6: bigint;
  volumeUsd6: bigint;
  trades: number;
  winRateBps: number;
  maxDrawdownBps: number;
  forecastHitRateBps: number;
  hwmUsd6: bigint;
  commissionOwedCumulativeUsd6: bigint;
}

/** The PerformanceRegistry reads the attestor needs. Injected so the sync can be tested without a chain. */
export interface PerfChain {
  /** Null when the agent has never been reported (asOf == 0). */
  getPerformance(agentIdBytes32: Hex): Promise<PerfReading | null>;
  /** The most recent PerformanceReported log for this agent. */
  latestReport(agentIdBytes32: Hex): Promise<{ txHash: Hex; blockNumber: bigint | null } | null>;
}

const round = (n: number) => Math.round(n);

/** Recomputes every agent's stats from fills and forecasts. Returns the number of rows written. */
export async function recomputeStats(opts: { db: Db; clock: Clock; logger?: Logger }): Promise<number> {
  const { db } = opts;
  const now = opts.clock.now();
  const agents = await db.query.agents.findMany();
  const rows: StatsInput[] = [];

  for (const a of agents) {
    const orders = await db.query.orders.findMany({ where: (o, { eq }) => eq(o.agentId, a.id) });
    const orderIds = orders.map((o) => o.id);
    const fillRows =
      orderIds.length > 0 ? await db.query.fills.findMany({ where: (f, { inArray }) => inArray(f.orderId, orderIds) }) : [];
    const capital = a.config.limits.maxAllocationUsd;
    const fifo = computeFifoPnl(tradesFrom(orders, fillRows), { startingCapitalUsd: capital });

    const fc = await db.query.forecasts.findMany({ where: (f, { eq }) => eq(f.agentId, a.id) });
    const resolved = fc.filter((f) => f.hit !== null);
    const hits = resolved.filter((f) => f.hit === true).length;
    const closing = fifo.wins + fifo.losses;

    const existing = await db.query.agentStats.findFirst({ where: (s, { eq }) => eq(s.entityId, a.id) });
    rows.push({
      entityId: a.id,
      kind: "agent",
      name: a.name,
      template: a.template as TemplateId,
      mode: a.mode as ExecutionMode,
      realizedPnlUsd: fifo.realizedPnlUsd,
      realizedPnlPct: capital > 0 ? (fifo.realizedPnlUsd / capital) * 100 : 0,
      volumeUsd: fifo.volumeUsd,
      trades: fifo.trades,
      winRateBps: closing > 0 ? round((fifo.wins / closing) * 10_000) : 0,
      maxDrawdownBps: round(fifo.maxDrawdownPct * 100),
      forecastHitRateBps: resolved.length > 0 ? round((hits / resolved.length) * 10_000) : 0,
      daysActive: Math.max(0, Math.floor((now - a.createdAt) / DAY_MS)),
      verified:
        existing?.verifiedTx && existing.verifiedAsOf !== null
          ? { reportTx: existing.verifiedTx as Hex, asOf: existing.verifiedAsOf }
          : null,
      selfFunded: existing?.selfFunded ?? false,
      updatedAt: now,
    });
  }

  await upsertStats(db, rows);
  opts.logger?.info("stats recomputed", { agents: rows.length });
  return rows.length;
}

/** Seconds (contract convention) or milliseconds, to unix ms. */
export function toUnixMs(asOf: bigint): number {
  const n = Number(asOf);
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Verifies stats against PerformanceRegistry. For each agent with a report, stores the attestation and
 * marks the stats row verified with the latest PerformanceReported tx. Returns the number verified.
 */
export async function syncAttestations(opts: {
  db: Db;
  perf: PerfChain;
  logger?: Logger;
}): Promise<number> {
  const logger = opts.logger ?? silentLogger;
  const agentRows = await opts.db.query.agents.findMany({ columns: { id: true } });
  const board = await leaderboard(opts.db, { kind: "agent", limit: STATS_LIMIT });
  const statsById = new Map(board.map((s) => [s.entityId, s]));
  let verified = 0;

  for (const { id } of agentRows) {
    const bytes = agentIdToBytes32(id);
    try {
      const reading = await opts.perf.getPerformance(bytes);
      if (!reading) continue;
      const latest = await opts.perf.latestReport(bytes);
      if (!latest) continue;
      const asOf = toUnixMs(reading.asOf);

      await insertAttestation(opts.db, {
        id: `perf:${id}:${reading.asOf.toString()}`,
        kind: "perf",
        txHash: latest.txHash,
        asOf,
        payload: {
          agentId: id,
          agentIdBytes32: bytes,
          asOf: reading.asOf.toString(),
          realizedPnlUsd6: reading.realizedPnlUsd6.toString(),
          volumeUsd6: reading.volumeUsd6.toString(),
          trades: reading.trades,
          winRateBps: reading.winRateBps,
          maxDrawdownBps: reading.maxDrawdownBps,
          forecastHitRateBps: reading.forecastHitRateBps,
          hwmUsd6: reading.hwmUsd6.toString(),
          commissionOwedCumulativeUsd6: reading.commissionOwedCumulativeUsd6.toString(),
        },
      });

      const stat = statsById.get(id);
      if (!stat) {
        logger.warn("attested agent has no stats row yet; run recomputeStats first", { agent: id });
        continue;
      }
      const { entityId, kind, name, template, mode, realizedPnlUsd, realizedPnlPct, volumeUsd, trades, winRateBps, maxDrawdownBps, forecastHitRateBps, daysActive, selfFunded } = stat;
      await upsertStats(opts.db, [
        {
          entityId,
          kind,
          name,
          template,
          mode,
          realizedPnlUsd,
          realizedPnlPct,
          volumeUsd,
          trades,
          winRateBps,
          maxDrawdownBps,
          forecastHitRateBps,
          daysActive,
          selfFunded,
          verified: { reportTx: latest.txHash, asOf },
        },
      ]);
      verified += 1;
    } catch (err) {
      logger.warn("attestation sync failed for agent", { agent: id, error: err });
    }
  }
  return verified;
}

/**
 * Polls Flash for orders that are still open (status "submitted" from our own write, or a non-terminal Flash
 * status), and stores their fills and new status. Fill ids are deterministic, so re-polling is harmless.
 * Returns the number of orders polled and the number of fills inserted. Live orders only: paper fills are
 * written at tick time.
 */
export async function syncOrderFills(opts: {
  db: Db;
  flash: Pick<FlashClient, "getOrder">;
  clock: Clock;
  logger?: Logger;
}): Promise<{ polled: number; fillsInserted: number }> {
  const logger = opts.logger ?? silentLogger;
  const open = await opts.db.query.orders.findMany({
    where: (o, { inArray }) => inArray(o.status, ["submitted", ...OPEN_ORDER_STATUSES]),
  });
  let fillsInserted = 0;

  for (const o of open) {
    try {
      const detail: FlashGetOrderResponse = await opts.flash.getOrder(o.id, o.funderAddress);
      const trades = normalizeFills({ order: detail.order, fills: detail.fills });
      const fills: FillRecord[] = trades.map((t, i) => ({
        id: `${o.id}:${t.txId || "no-tx"}:${i}`,
        orderId: o.id,
        price: t.price,
        qty: t.qty,
        notionalUsd: t.notionalUsd,
        feeUsd: t.feeUsd,
        integratorFeeUsd: t.integratorFeeUsd,
        txId: t.txId || null,
        ts: t.ts,
      }));
      await insertFills(opts.db, fills);
      fillsInserted += fills.length;
      await upsertOrder(opts.db, {
        id: o.id,
        agentId: o.agentId,
        funderAddress: o.funderAddress,
        side: o.side as OrderIntent["side"],
        asset: o.asset,
        orderType: o.orderType as FlashOrderType,
        notionalUsd: o.notionalUsd,
        status: detail.order.status,
        raw: detail.order as unknown as Record<string, unknown>,
        createdAt: o.createdAt,
        updatedAt: opts.clock.now(),
      });
    } catch (err) {
      logger.warn("order poll failed; will retry", { order: o.id, error: err });
    }
  }
  return { polled: open.length, fillsInserted };
}

/** PerformanceRegistry reads over viem. Events are scanned from fromBlock (PERF_REGISTRY_FROM_BLOCK). */
export function createPerfChain(opts: { client: PublicClient; address: Hex; fromBlock: bigint }): PerfChain {
  const { client, address, fromBlock } = opts;
  return {
    async getPerformance(agentIdBytes32) {
      const e = (await client.readContract({
        address,
        abi: PERFORMANCE_REGISTRY_ABI,
        functionName: "getPerformance",
        args: [agentIdBytes32],
      })) as {
        asOf: bigint;
        realizedPnlUsd6: bigint;
        volumeUsd6: bigint;
        trades: number;
        winRateBps: number;
        maxDrawdownBps: number;
        forecastHitRateBps: number;
        hwmUsd6: bigint;
        commissionOwedCumulativeUsd6: bigint;
      };
      if (e.asOf === 0n) return null;
      return {
        asOf: e.asOf,
        realizedPnlUsd6: e.realizedPnlUsd6,
        volumeUsd6: e.volumeUsd6,
        trades: Number(e.trades),
        winRateBps: Number(e.winRateBps),
        maxDrawdownBps: Number(e.maxDrawdownBps),
        forecastHitRateBps: Number(e.forecastHitRateBps),
        hwmUsd6: e.hwmUsd6,
        commissionOwedCumulativeUsd6: e.commissionOwedCumulativeUsd6,
      };
    },
    async latestReport(agentIdBytes32) {
      const logs = await client.getContractEvents({
        address,
        abi: PERFORMANCE_REGISTRY_ABI,
        eventName: "PerformanceReported",
        args: { agentId: agentIdBytes32 },
        fromBlock,
        toBlock: "latest",
      });
      const last = logs.at(-1);
      if (!last) return null;
      return { txHash: last.transactionHash, blockNumber: last.blockNumber };
    },
  };
}
