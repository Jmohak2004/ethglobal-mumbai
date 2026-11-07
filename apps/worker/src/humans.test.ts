// Humans board: Flash orders and fills are synced by funder for opted-in users only, then stats are computed with the
// same FIFO PnL the agents use. Finished orders are not re-fetched. A Flash failure for one user does not stop the rest.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, insertFills, insertPaperFill, leaderboard, upsertOrder, upsertUser, type Db } from "@arena/db";
import type { FlashClient } from "@arena/flash";
import { humanDisplayName, isPaperOrder, recomputeHumanStats, syncHumans } from "./humans.ts";
import { silentLogger } from "./logger.ts";
import { fixedClock, memoryDb, NOW } from "./test-fixtures.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";

const HOUR = 3_600_000;
const iso = (ts: number) => new Date(ts).toISOString();

/** A Flash order in the shape GET /orders returns (only the fields the sync reads). */
function order(orderId: string, funder: string, side: "buy" | "sell", status: string, placedAt: number) {
  return {
    orderId,
    funderAddress: funder,
    side,
    status,
    orderType: "market",
    targetAsset: { ticker: "WETH" },
    placedAt: iso(placedAt),
    qty: "1",
  };
}

/** One filled chunk in the shape GET /orders/{id} returns. */
function fill(txId: string, qty: number, price: number, notional: number, fee: number, at: number) {
  return {
    status: "CHAIN_STATUS_FINALIZED",
    targetAmount: String(qty),
    fillPrice: String(price),
    notional: String(notional),
    feeNotional: String(fee),
    integratorFeeNotional: "0",
    transactionId: txId,
    filledAt: iso(at),
  };
}

interface Fixture {
  listed: Record<string, unknown[]>;
  details: Record<string, { order: unknown; fills: unknown[] }>;
}

/** Fake Flash: serves listed orders per funder and details per order. Records every call. */
function fakeFlash(fixture: Fixture) {
  const listCalls: string[] = [];
  const detailCalls: string[] = [];
  const failFor = new Set<string>();
  const flash = {
    listCalls,
    detailCalls,
    failFor,
    async listAllOrders(params: { funderAddress: string }) {
      listCalls.push(params.funderAddress);
      if (failFor.has(params.funderAddress)) throw new Error("flash 503");
      return fixture.listed[params.funderAddress] ?? [];
    },
    async getOrder(orderId: string) {
      detailCalls.push(orderId);
      const detail = fixture.details[orderId];
      if (!detail) throw new Error(`no detail for ${orderId}`);
      return detail;
    },
  };
  return flash;
}

/** Alice: buy 1 WETH at 2000 (fee 2), sell it at 2200 (fee 2.2), and an open buy. Bob: one buy. Carol never opts in. */
function scenario(): Fixture {
  const a1 = order("A1", ALICE, "buy", "ORDER_STATUS_FILLED", NOW - 3 * HOUR);
  const a2 = order("A2", ALICE, "sell", "ORDER_STATUS_FILLED", NOW - HOUR);
  const a3 = order("A3", ALICE, "buy", "ORDER_STATUS_ACCEPTED", NOW - 30 * 60_000);
  const b1 = order("B1", BOB, "buy", "ORDER_STATUS_FILLED", NOW - 2 * HOUR);
  const c1 = order("C1", CAROL, "buy", "ORDER_STATUS_FILLED", NOW - HOUR);
  return {
    listed: { [ALICE]: [a1, a2, a3], [BOB]: [b1], [CAROL]: [c1] },
    details: {
      A1: { order: a1, fills: [fill("0x01", 1, 2000, 2000, 2, NOW - 3 * HOUR)] },
      A2: { order: a2, fills: [fill("0x02", 1, 2200, 2200, 2.2, NOW - HOUR)] },
      A3: { order: a3, fills: [] },
      B1: { order: b1, fills: [fill("0x03", 2, 1000, 2000, 0, NOW - 2 * HOUR)] },
      C1: { order: c1, fills: [fill("0x04", 1, 1500, 1500, 0, NOW - HOUR)] },
    },
  };
}

async function openDb(): Promise<Db> {
  const db = await memoryDb();
  dbs.push(db);
  await upsertUser(db, { address: ALICE, displayName: "Alice", humansBoardOptIn: true, createdAt: NOW - 10 * 24 * HOUR });
  await upsertUser(db, { address: BOB, humansBoardOptIn: true, createdAt: NOW - 2 * 24 * HOUR });
  await upsertUser(db, { address: CAROL, humansBoardOptIn: false, createdAt: NOW - 24 * HOUR });
  return db;
}

describe("humans board sync", () => {
  test("syncs opted-in users only, computes FIFO stats, and re-fetches only what is new, changed or open", async () => {
    const db = await openDb();
    const clock = fixedClock();
    const fixture = scenario();
    const flash = fakeFlash(fixture);
    const opts = { db, flash: flash as unknown as Pick<FlashClient, "listAllOrders" | "getOrder">, clock, logger: silentLogger };

    const first = await syncHumans(opts);
    expect(first).toEqual({ users: 2, ordersFetched: 4, fillsWritten: 3, failedUsers: 0, statsRows: 2 });
    expect(flash.listCalls).toEqual([ALICE, BOB]);
    expect(flash.detailCalls).toEqual(["A1", "A2", "A3", "B1"]);

    const human = (await leaderboard(db, { kind: "human" })).map((r) => [r.name, r.entityId]);
    expect(human).toEqual([
      ["Alice", ALICE],
      ["0xbbbb...bbbb", BOB],
    ]);

    const alice = (await leaderboard(db, { kind: "human" }))[0];
    expect(alice?.realizedPnlUsd).toBeCloseTo(195.8, 6);
    expect(alice?.realizedPnlPct).toBeCloseTo(9.79, 2);
    expect(alice?.volumeUsd).toBeCloseTo(4200, 6);
    expect(alice?.trades).toBe(2);
    expect(alice?.winRateBps).toBe(10_000);
    expect(alice?.maxDrawdownBps).toBe(0);
    expect(alice?.mode).toBe("live");
    expect(alice?.template).toBeNull();
    expect(alice?.daysActive).toBe(10);

    const bob = (await leaderboard(db, { kind: "human" }))[1];
    expect(bob?.realizedPnlUsd).toBe(0);
    expect(bob?.volumeUsd).toBe(2000);
    expect(bob?.winRateBps).toBe(0);

    // Orders are stored with no agent (they are human trades).
    const stored = await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, "A1") });
    expect(stored).toMatchObject({ agentId: null, funderAddress: ALICE, status: "ORDER_STATUS_FILLED" });

    // Second run: A1, A2 and B1 are finished and unchanged, so only the open A3 is fetched again.
    const second = await syncHumans(opts);
    expect(second.ordersFetched).toBe(1);
    expect(flash.detailCalls.slice(4)).toEqual(["A3"]);
    expect(await db.query.fills.findMany({ where: (f, { eq }) => eq(f.orderId, "A1") })).toHaveLength(1);

    // A3 fills later: its status changed, so it is fetched and counted.
    fixture.listed[ALICE] = [
      fixture.details.A1?.order,
      fixture.details.A2?.order,
      order("A3", ALICE, "buy", "ORDER_STATUS_FILLED", NOW - 30 * 60_000),
    ];
    fixture.details.A3 = {
      order: order("A3", ALICE, "buy", "ORDER_STATUS_FILLED", NOW - 30 * 60_000),
      fills: [fill("0x05", 1, 2100, 2100, 2.1, NOW - 30 * 60_000)],
    };
    const third = await syncHumans(opts);
    expect(third.ordersFetched).toBe(1);
    expect((await leaderboard(db, { kind: "human" }))[0]?.trades).toBe(3);
    expect((await leaderboard(db, { kind: "human" }))[0]?.realizedPnlUsd).toBeCloseTo(195.8, 6);
  });

  test("a Flash failure for one user is counted, the others still sync, and stored fills still feed the stats", async () => {
    const db = await openDb();
    const clock = fixedClock();
    const flash = fakeFlash(scenario());
    const opts = { db, flash: flash as unknown as Pick<FlashClient, "listAllOrders" | "getOrder">, clock, logger: silentLogger };

    await syncHumans(opts);
    flash.failFor.add(BOB);
    const result = await syncHumans(opts);

    expect(result.failedUsers).toBe(1);
    expect(result.statsRows).toBe(2);
    expect((await leaderboard(db, { kind: "human" })).find((r) => r.entityId === BOB)?.volumeUsd).toBe(2000);
  });

  test("recomputeHumanStats reads only the stored data (no Flash calls) and skips users who did not opt in", async () => {
    const db = await openDb();
    const clock = fixedClock();
    const flash = fakeFlash(scenario());
    await syncHumans({ db, flash: flash as unknown as Pick<FlashClient, "listAllOrders" | "getOrder">, clock, logger: silentLogger });
    const callsBefore = flash.listCalls.length + flash.detailCalls.length;

    expect(await recomputeHumanStats({ db, clock, logger: silentLogger })).toBe(2);
    expect(flash.listCalls.length + flash.detailCalls.length).toBe(callsBefore);
    expect((await leaderboard(db, { kind: "human" })).map((r) => r.entityId)).not.toContain(CAROL);
  });

  test("marks open lots to the live price: total = realized + unrealized, one price lookup per asset, ranked by total", async () => {
    const db = await openDb();
    const clock = fixedClock();
    const flash = fakeFlash(scenario());
    await syncHumans({ db, flash: flash as unknown as Pick<FlashClient, "listAllOrders" | "getOrder">, clock, logger: silentLogger });

    const calls: string[] = [];
    const market = { getPrice: async (asset: string) => (calls.push(asset), 1200) };
    await recomputeHumanStats({ db, clock, logger: silentLogger, market });
    expect(calls).toEqual(["WETH"]);

    const rows = await leaderboard(db, { kind: "human" });
    // Bob holds 2 WETH bought at 1000: +400 open, nothing realized, over 2000 bought.
    expect(rows.map((r) => r.entityId)).toEqual([BOB, ALICE]);
    expect(rows[0]).toMatchObject({ realizedPnlUsd: 0, unrealizedPnlUsd: 400, totalPnlUsd: 400 });
    expect(rows[0]?.totalPnlPct).toBeCloseTo(20, 9);
    // Alice closed her only position: total equals realized.
    expect(rows[1]?.unrealizedPnlUsd).toBe(0);
    expect(rows[1]?.totalPnlUsd).toBeCloseTo(rows[1]?.realizedPnlUsd ?? NaN, 9);
  });

  test("a failed price lookup leaves the asset unmarked and does not stop the pass", async () => {
    const db = await openDb();
    const clock = fixedClock();
    const flash = fakeFlash(scenario());
    await syncHumans({ db, flash: flash as unknown as Pick<FlashClient, "listAllOrders" | "getOrder">, clock, logger: silentLogger });

    const market = { getPrice: async (): Promise<number> => { throw new Error("coinbase down"); } };
    expect(await recomputeHumanStats({ db, clock, logger: silentLogger, market })).toBe(2);
    const bob = (await leaderboard(db, { kind: "human" })).find((r) => r.entityId === BOB);
    expect(bob).toMatchObject({ unrealizedPnlUsd: 0, totalPnlUsd: 0 });
  });

  test("the display name falls back to a short address", () => {
    expect(humanDisplayName({ address: BOB, displayName: null })).toBe("0xbbbb...bbbb");
    expect(humanDisplayName({ address: BOB, displayName: "  " })).toBe("0xbbbb...bbbb");
    expect(humanDisplayName({ address: ALICE, displayName: "Alice" })).toBe("Alice");
  });
});

describe("humans board paper fills", () => {
  const DAVE = "0xdddddddddddddddddddddddddddddddddddddddd";
  const EVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const FRANK = "0xffffffffffffffffffffffffffffffffffffffff";

  async function paperDb(): Promise<Db> {
    const db = await memoryDb();
    dbs.push(db);
    await upsertUser(db, { address: DAVE, displayName: "Dave", humansBoardOptIn: true, createdAt: NOW - 10 * 24 * HOUR });
    await upsertUser(db, { address: EVE, displayName: "Eve", humansBoardOptIn: true, createdAt: NOW - 10 * 24 * HOUR });
    await upsertUser(db, { address: FRANK, humansBoardOptIn: false, createdAt: NOW - 10 * 24 * HOUR });
    return db;
  }

  /** Saves a paper round trip: buy 1 WETH at 2000 (fee 2), sell it at 2200 (fee 2.2). FIFO PnL is 195.8. */
  async function saveRoundTrip(db: Db, funder: string): Promise<void> {
    await insertPaperFill(db, {
      funderAddress: funder,
      side: "buy",
      asset: "WETH",
      orderType: "market",
      notionalUsd: 2000,
      priceUsd: 2000,
      feeUsd: 2,
      integratorFeeUsd: 2,
      ts: NOW - 3 * HOUR,
    });
    await insertPaperFill(db, {
      funderAddress: funder,
      side: "sell",
      asset: "WETH",
      orderType: "limit",
      notionalUsd: 2200,
      priceUsd: 2200,
      feeUsd: 2.2,
      integratorFeeUsd: 2.2,
      ts: NOW - HOUR,
    });
  }

  const flashOpts = (db: Db, flash: ReturnType<typeof fakeFlash>) => ({
    db,
    flash: flash as unknown as Pick<FlashClient, "listAllOrders" | "getOrder">,
    clock: fixedClock(),
    logger: silentLogger,
  });

  test("paper fills saved in the database count toward the stats, and the row is labelled paper", async () => {
    const db = await paperDb();
    await saveRoundTrip(db, DAVE);
    const flash = fakeFlash({ listed: {}, details: {} });

    const result = await syncHumans(flashOpts(db, flash));
    expect(result.statsRows).toBe(2);
    const dave = (await leaderboard(db, { kind: "human" })).find((r) => r.entityId === DAVE);
    expect(dave).toMatchObject({ name: "Dave", mode: "paper", trades: 2, volumeUsd: 4200, winRateBps: 10_000 });
    expect(dave?.realizedPnlUsd).toBeCloseTo(195.8, 6);
    expect((await leaderboard(db, { kind: "human", mode: "paper" })).map((r) => r.entityId)).toEqual([DAVE]);
    expect((await leaderboard(db, { kind: "human", mode: "live" })).map((r) => r.entityId)).toEqual([EVE]);
    expect((await leaderboard(db, { kind: "human" })).find((r) => r.entityId === FRANK)).toBeUndefined();

    // A Flash outage for the user does not remove the paper fills from the stats.
    flash.failFor.add(DAVE);
    const retry = await syncHumans(flashOpts(db, flash));
    expect(retry.failedUsers).toBe(1);
    expect((await leaderboard(db, { kind: "human" })).find((r) => r.entityId === DAVE)).toMatchObject({ mode: "paper", trades: 2 });
  });

  test("a human with both live and paper fills is labelled live and counts both", async () => {
    const db = await paperDb();
    await saveRoundTrip(db, EVE);
    await upsertOrder(db, {
      id: "eve-live-1",
      agentId: null,
      funderAddress: EVE,
      side: "buy",
      asset: "WETH",
      orderType: "market",
      notionalUsd: 1500,
      status: "ORDER_STATUS_FILLED",
      raw: { orderId: "eve-live-1" },
      createdAt: NOW - HOUR,
      updatedAt: NOW - HOUR,
    });
    await insertFills(db, [
      { id: "eve-live-1:0x09", orderId: "eve-live-1", price: 1500, qty: 1, notionalUsd: 1500, feeUsd: 1.5, integratorFeeUsd: 0, txId: "0x09", ts: NOW - HOUR },
    ]);

    expect(await recomputeHumanStats({ db, clock: fixedClock(), logger: silentLogger })).toBe(2);
    const eve = (await leaderboard(db, { kind: "human" })).find((r) => r.entityId === EVE);
    expect(eve).toMatchObject({ mode: "live", trades: 3, volumeUsd: 5700 });
  });

  test("isPaperOrder reads the paper flag stored on the order", () => {
    expect(isPaperOrder({ raw: { paper: true } })).toBe(true);
    expect(isPaperOrder({ raw: { paper: false } })).toBe(false);
    expect(isPaperOrder({ raw: {} })).toBe(false);
  });
});
