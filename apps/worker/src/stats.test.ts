import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, insertFills, leaderboard, upsertOrder, type Db } from "@arena/db";
import type { FlashGetOrderResponse } from "@arena/flash";
import type { Hex } from "viem";
import { recomputeStats, syncAttestations, syncOrderFills, toUnixMs, type PerfChain, type PerfReading } from "./stats.ts";
import { fixedClock, memoryDb, NOW, seedAgent } from "./test-fixtures.ts";
import { silentLogger } from "./logger.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

const TX = `0x${"ab".repeat(32)}` as Hex;

async function tradedAgent() {
  const db = await memoryDb();
  dbs.push(db);
  const agent = await seedAgent(db, { name: "[test] stats" });
  const wallet = agent.tradingWallet;
  await upsertOrder(db, {
    id: "buy-1", agentId: agent.id, funderAddress: wallet, side: "buy", asset: "WETH", orderType: "limit",
    notionalUsd: 2000, status: "filled", createdAt: NOW - 2 * 3_600_000, updatedAt: NOW - 2 * 3_600_000,
  });
  await insertFills(db, [
    { id: "buy-1:f", orderId: "buy-1", price: 2000, qty: 1, notionalUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, txId: "0x1", ts: NOW - 2 * 3_600_000 },
  ]);
  await upsertOrder(db, {
    id: "sell-1", agentId: agent.id, funderAddress: wallet, side: "sell", asset: "WETH", orderType: "market",
    notionalUsd: 2200, status: "filled", createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000,
  });
  await insertFills(db, [
    { id: "sell-1:f", orderId: "sell-1", price: 2200, qty: 1, notionalUsd: 2200, feeUsd: 0, integratorFeeUsd: 0, txId: "0x2", ts: NOW - 3_600_000 },
  ]);
  return { db, agent };
}

describe("recomputeStats", () => {
  test("computes FIFO PnL, volume, win rate and return on allocation from fills", async () => {
    const { db, agent } = await tradedAgent();
    const rows = await recomputeStats({ db, clock: fixedClock() });
    expect(rows).toBe(1);
    const [row] = (await leaderboard(db, { kind: "agent" })).filter((r) => r.entityId === agent.id);
    expect(row?.realizedPnlUsd).toBeCloseTo(200, 9);
    expect(row?.volumeUsd).toBeCloseTo(4200, 9);
    expect(row?.trades).toBe(2);
    expect(row?.winRateBps).toBe(10_000);
    // $200 on a $5 allocation.
    expect(row?.realizedPnlPct).toBeCloseTo(4000, 6);
    expect(row?.verified).toBeNull();
  });

  test("keeps an existing verification when stats are recomputed", async () => {
    const { db, agent } = await tradedAgent();
    const clock = fixedClock();
    await recomputeStats({ db, clock });
    const perf: PerfChain = {
      async getPerformance(): Promise<PerfReading | null> {
        return { asOf: BigInt(NOW / 1000), realizedPnlUsd6: 200_000_000n, volumeUsd6: 4_200_000_000n, trades: 2, winRateBps: 10_000, maxDrawdownBps: 0, forecastHitRateBps: 0, hwmUsd6: 200_000_000n, commissionOwedCumulativeUsd6: 20_000_000n };
      },
      async latestReport() {
        return { txHash: TX, blockNumber: 42n };
      },
    };
    expect(await syncAttestations({ db, perf, logger: silentLogger })).toBe(1);
    await recomputeStats({ db, clock });
    const [row] = (await leaderboard(db, { kind: "agent" })).filter((r) => r.entityId === agent.id);
    expect(row?.verified?.reportTx).toBe(TX);

    const attestation = await db.query.attestations.findFirst({ where: (a, { eq }) => eq(a.kind, "perf") });
    expect(attestation?.txHash).toBe(TX);
    expect(attestation?.payload).toMatchObject({ agentId: agent.id, trades: 2 });
  });
});

describe("syncAttestations", () => {
  test("an agent with no onchain report stays unverified", async () => {
    const { db, agent } = await tradedAgent();
    await recomputeStats({ db, clock: fixedClock() });
    const perf: PerfChain = {
      async getPerformance() {
        return null;
      },
      async latestReport() {
        return { txHash: TX, blockNumber: 1n };
      },
    };
    expect(await syncAttestations({ db, perf, logger: silentLogger })).toBe(0);
    const [row] = (await leaderboard(db, { kind: "agent" })).filter((r) => r.entityId === agent.id);
    expect(row?.verified).toBeNull();
    const attestations = await db.query.attestations.findMany({ where: (a, { eq }) => eq(a.kind, "perf") });
    expect(attestations).toHaveLength(0);
  });

  test("toUnixMs accepts seconds and milliseconds", () => {
    expect(toUnixMs(1_700_000_000n)).toBe(1_700_000_000_000);
    expect(toUnixMs(1_700_000_000_000n)).toBe(1_700_000_000_000);
  });
});

describe("syncOrderFills", () => {
  test("stores live fills once, updates the order status, and skips orders that are finished", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db, { mode: "live" });
    await upsertOrder(db, {
      id: "flash-1", agentId: agent.id, funderAddress: agent.tradingWallet, side: "buy", asset: "WETH",
      orderType: "limit", notionalUsd: 1000, status: "submitted", createdAt: NOW - 60_000, updatedAt: NOW - 60_000,
    });

    const partial = {
      order: { orderId: "flash-1", side: "buy", status: "ORDER_STATUS_PARTIALLY_FILLED", targetAsset: { ticker: "WETH" } },
      fills: [
        { status: "CHAIN_STATUS_CONFIRMED", targetAmount: "0.25", fillPrice: "2000", notional: "500", feeNotional: "0.5", integratorFeeNotional: "0.05", transactionId: "0xaa", filledAt: new Date(NOW - 30_000).toISOString() },
      ],
    } as unknown as FlashGetOrderResponse;
    const filled = {
      order: { orderId: "flash-1", side: "buy", status: "ORDER_STATUS_FILLED", targetAsset: { ticker: "WETH" } },
      fills: [
        ...partial.fills,
        { status: "CHAIN_STATUS_CONFIRMED", targetAmount: "0.25", fillPrice: "2000", notional: "500", feeNotional: "0.5", integratorFeeNotional: "0.05", transactionId: "0xbb", filledAt: new Date(NOW - 10_000).toISOString() },
      ],
    } as unknown as FlashGetOrderResponse;

    let response = partial;
    const flash = { getOrder: async () => response };
    const clock = fixedClock();

    expect(await syncOrderFills({ db, flash, clock, logger: silentLogger })).toEqual({ polled: 1, fillsInserted: 1 });
    expect(await syncOrderFills({ db, flash, clock, logger: silentLogger })).toEqual({ polled: 1, fillsInserted: 1 });
    expect(await db.query.fills.findMany({ where: (f, { eq }) => eq(f.orderId, "flash-1") })).toHaveLength(1);

    response = filled;
    expect(await syncOrderFills({ db, flash, clock, logger: silentLogger })).toEqual({ polled: 1, fillsInserted: 2 });
    const order = await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, "flash-1") });
    expect(order?.status).toBe("ORDER_STATUS_FILLED");
    expect(await db.query.fills.findMany({ where: (f, { eq }) => eq(f.orderId, "flash-1") })).toHaveLength(2);

    // Finished orders are not polled again.
    expect(await syncOrderFills({ db, flash, clock, logger: silentLogger })).toEqual({ polled: 0, fillsInserted: 0 });
  });
});

