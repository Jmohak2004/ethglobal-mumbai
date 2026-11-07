// Leaderboard stats and onchain verification.
//   recomputeStats:      FIFO PnL, volume, win rate, drawdown and forecast hit rate per agent, from our fills.
//                        Leaves the stored verification alone (upsertStats keeps fields it is not given).
//   syncAttestations:    reads PerformanceReported logs and marks each agent's stats row verified with the
//                        latest report tx. With a cursor, logs are scanned in chunks from the persisted block.

import {
  getChainCursor,
  insertAttestation,
  insertFills,
  markStatsVerified,
  setChainCursor,
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
import type { CursorStore } from "./economics/relayer.ts";
import type { Clock, MarketData } from "./deps.ts";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";
import { tradesFrom } from "./execution.ts";
import { createMarkSource } from "./marks.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_CHUNK_BLOCKS = 2000;

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

export interface ReportLog {
  agentIdBytes32: Hex;
  txHash: Hex;
  blockNumber: bigint;
}

/** The PerformanceRegistry reads the attestor needs. Injected so the sync can be tested without a chain. */
export interface PerfChain {
  getPerformance(agentIdBytes32: Hex): Promise<PerfReading | null>;
  /** The most recent PerformanceReported log for this agent. */
  latestReport(agentIdBytes32: Hex): Promise<{ txHash: Hex; blockNumber: bigint | null } | null>;
  /** PerformanceReported logs in [fromBlock, toBlock], inclusive, oldest first. Required for the cursor sync. */
  reportLogs?(fromBlock: bigint, toBlock: bigint): Promise<ReportLog[]>;
  /** Chain head. Required for the cursor sync. */
  latestBlock?(): Promise<bigint>;
}

const round = (n: number) => Math.round(n);

/**
 * Recomputes every agent's stats from fills and forecasts. Returns the number of rows written.
 * Verification and self-funded flags are not passed, so the stored values stay as they are.
 * realizedPnlUsd stays realized only (it is what CRE attests). With `market`, open lots are marked to the live price
 * (one lookup per asset per pass) and totalPnlUsd = realized + unrealized. Without it, unrealized is 0.
 */
export async function recomputeStats(opts: {
  db: Db;
  clock: Clock;
  logger?: Logger;
  market?: Pick<MarketData, "getPrice">;
}): Promise<number> {
  const { db } = opts;
  const markSource = createMarkSource(opts.market, opts.logger);
  const now = opts.clock.now();
  const agents = await db.query.agents.findMany();
  const rows: StatsInput[] = [];

  for (const a of agents) {
    const orders = await db.query.orders.findMany({ where: (o, { eq }) => eq(o.agentId, a.id) });
    const orderIds = orders.map((o) => o.id);
    const fillRows =
      orderIds.length > 0 ? await db.query.fills.findMany({ where: (f, { inArray }) => inArray(f.orderId, orderIds) }) : [];
    const capital = a.config.limits.maxAllocationUsd;
    const trades = tradesFrom(orders, fillRows);
    const unmarked = computeFifoPnl(trades, { startingCapitalUsd: capital });
    const marks = await markSource.marksFor(Object.keys(unmarked.openLots));
    const fifo = computeFifoPnl(trades, { startingCapitalUsd: capital, marks });
    const totalPnlUsd = fifo.realizedPnlUsd + fifo.unrealizedPnlUsd;

    const fc = await db.query.forecasts.findMany({ where: (f, { eq }) => eq(f.agentId, a.id) });
    const resolved = fc.filter((f) => f.hit !== null);
    const hits = resolved.filter((f) => f.hit === true).length;
    const closing = fifo.wins + fifo.losses;

    rows.push({
      entityId: a.id,
      kind: "agent",
      name: a.name,
      template: a.template as TemplateId,
      mode: a.mode as ExecutionMode,
      realizedPnlUsd: fifo.realizedPnlUsd,
      realizedPnlPct: capital > 0 ? (fifo.realizedPnlUsd / capital) * 100 : 0,
      unrealizedPnlUsd: fifo.unrealizedPnlUsd,
      totalPnlUsd,
      totalPnlPct: capital > 0 ? (totalPnlUsd / capital) * 100 : 0,
      volumeUsd: fifo.volumeUsd,
      trades: fifo.trades,
      winRateBps: closing > 0 ? round((fifo.wins / closing) * 10_000) : 0,
      maxDrawdownBps: round(fifo.maxDrawdownPct * 100),
      forecastHitRateBps: resolved.length > 0 ? round((hits / resolved.length) * 10_000) : 0,
      daysActive: Math.max(0, Math.floor((now - a.createdAt) / DAY_MS)),
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

/** Block cursor kept in the chain_cursors table. The name identifies the scanner. */
export function dbBlockCursor(db: Db, name: string): CursorStore {
  return {
    async read() {
      const block = await getChainCursor(db, name);
      return block === null ? null : BigInt(block);
    },
    async write(block) {
      await setChainCursor(db, name, Number(block));
    },
  };
}

export interface SyncAttestationsOptions {
  db: Db;
  perf: PerfChain;
  logger?: Logger;
  /** When set, PerformanceReported logs are scanned in chunks from this cursor (the last processed block). */
  cursor?: CursorStore;
  /** First block to scan when the cursor has no value yet. Default 0. */
  fromBlock?: bigint;
  /** Blocks per log query (LOG_CHUNK_BLOCKS). Default 2000. */
  chunkBlocks?: number;
}

/**
 * Records the attestation for one agent's current PerformanceRegistry reading and marks its stats row
 * verified with the given report tx. Returns true when the stats row was marked.
 */
async function verifyAgent(
  opts: SyncAttestationsOptions,
  agentId: string,
  bytes: Hex,
  latest: { txHash: Hex },
  logger: Logger,
): Promise<boolean> {
  const reading = await opts.perf.getPerformance(bytes);
  if (!reading) return false;
  const asOf = toUnixMs(reading.asOf);

  // One attestation per report tx, so the stored tx always matches the report it was recorded from.
  await insertAttestation(opts.db, {
    id: `perf:${agentId}:${latest.txHash}`,
    kind: "perf",
    txHash: latest.txHash,
    asOf,
    payload: {
      agentId,
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

  const marked = await markStatsVerified(opts.db, agentId, { reportTx: latest.txHash, asOf });
  if (!marked) {
    logger.warn("attested agent has no stats row yet; run recomputeStats first", { agent: agentId });
  }
  return marked;
}

/**
 * Verifies stats against PerformanceRegistry. With a cursor, PerformanceReported logs are read in chunks of
 * chunkBlocks from the stored block up to the head. Each chunk's agents are verified before the cursor moves
 * past it, so a crash never skips a report. Without a cursor, each agent is checked with latestReport.
 * Returns the number of stats rows verified.
 */
export async function syncAttestations(opts: SyncAttestationsOptions): Promise<number> {
  const logger = opts.logger ?? silentLogger;
  const agentRows = await opts.db.query.agents.findMany({ columns: { id: true } });
  const idByBytes = new Map(agentRows.map((a) => [agentIdToBytes32(a.id).toLowerCase(), a.id]));
  let verified = 0;

  if (opts.cursor) {
    const { perf, cursor } = opts;
    if (!perf.reportLogs || !perf.latestBlock) throw new Error("cursor sync needs perf.reportLogs and perf.latestBlock");
    const chunk = BigInt(opts.chunkBlocks ?? DEFAULT_LOG_CHUNK_BLOCKS);
    if (chunk < 1n) throw new RangeError("chunkBlocks must be >= 1");
    const head = await perf.latestBlock();
    const stored = await cursor.read();
    let start = stored !== null ? stored + 1n : (opts.fromBlock ?? 0n);

    while (start <= head) {
      const end = start + chunk - 1n < head ? start + chunk - 1n : head;
      const logs = await perf.reportLogs(start, end);
      // Logs are oldest first, so the last one per agent is the newest report in this chunk.
      const latestByAgent = new Map<string, ReportLog>();
      for (const log of logs) latestByAgent.set(log.agentIdBytes32.toLowerCase(), log);

      for (const [bytes, log] of latestByAgent) {
        const agentId = idByBytes.get(bytes);
        if (!agentId) continue;
        try {
          if (await verifyAgent(opts, agentId, bytes as Hex, { txHash: log.txHash }, logger)) verified += 1;
        } catch (err) {
          logger.warn("attestation sync failed for agent", { agent: agentId, error: err });
        }
      }
      await cursor.write(end);
      start = end + 1n;
    }
    return verified;
  }

  for (const [bytes, agentId] of idByBytes) {
    try {
      const hex = bytes as Hex;
      const latest = await opts.perf.latestReport(hex);
      if (!latest) continue;
      if (await verifyAgent(opts, agentId, hex, { txHash: latest.txHash }, logger)) verified += 1;
    } catch (err) {
      logger.warn("attestation sync failed for agent", { agent: agentId, error: err });
    }
  }
  return verified;
}

/**
 * Fill rows for one order, from its GET /orders/{id} detail. Ids are deterministic (order, tx, index), so the same
 * detail always yields the same rows and re-inserting is harmless.
 */
export function fillRecordsFromDetail(orderId: string, detail: FlashGetOrderResponse): FillRecord[] {
  return normalizeFills({ order: detail.order, fills: detail.fills }).map((t, i) => ({
    id: `${orderId}:${t.txId || "no-tx"}:${i}`,
    orderId,
    price: t.price,
    qty: t.qty,
    notionalUsd: t.notionalUsd,
    feeUsd: t.feeUsd,
    integratorFeeUsd: t.integratorFeeUsd,
    txId: t.txId || null,
    ts: t.ts,
  }));
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
      const fills = fillRecordsFromDetail(o.id, detail);
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

/**
 * PerformanceRegistry reads over viem. Log scans are chunked by chunkBlocks (LOG_CHUNK_BLOCKS), starting at
 * fromBlock (PERF_REGISTRY_FROM_BLOCK).
 */
export function createPerfChain(opts: { client: PublicClient; address: Hex; fromBlock: bigint; chunkBlocks?: number }): PerfChain {
  const { client, address, fromBlock } = opts;
  const chunk = BigInt(opts.chunkBlocks ?? DEFAULT_LOG_CHUNK_BLOCKS);

  const reportLogs = async (from: bigint, to: bigint): Promise<ReportLog[]> => {
    const logs = await client.getContractEvents({
      address,
      abi: PERFORMANCE_REGISTRY_ABI,
      eventName: "PerformanceReported",
      fromBlock: from,
      toBlock: to,
    });
    return logs.map((log) => ({
      agentIdBytes32: ((log.args as { agentId: Hex }).agentId ?? "0x") as Hex,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    }));
  };

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
      // Per-agent lookup, chunked like the cursor sync. Kept for callers that do not persist a cursor.
      const head = await client.getBlockNumber();
      let latest: { txHash: Hex; blockNumber: bigint } | null = null;
      for (let start = fromBlock; start <= head; start += chunk) {
        const end = start + chunk - 1n < head ? start + chunk - 1n : head;
        const logs = await client.getContractEvents({
          address,
          abi: PERFORMANCE_REGISTRY_ABI,
          eventName: "PerformanceReported",
          args: { agentId: agentIdBytes32 },
          fromBlock: start,
          toBlock: end,
        });
        const last = logs.at(-1);
        if (last) latest = { txHash: last.transactionHash, blockNumber: last.blockNumber };
      }
      return latest;
    },

    reportLogs,
    latestBlock: () => client.getBlockNumber(),
  };
}
