import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, insertPaperLedger, paperLedgerTotals, upsertOrder, type Db } from "@arena/db";
import { computeFifoPnl, type Trade } from "@arena/flash";
import type { Agent } from "@arena/shared";
import {
  closePaperBrackets,
  loadPaperBook,
  peakRealizedPnl,
  replayLots,
  settlePaperCommission,
  settlePaperTopUp,
  triggerFor,
  type LedgerDeps,
} from "./paper.ts";
import { silentLogger } from "./logger.ts";
import { deps, fakeMarket, fixedClock, memoryDb, NOW, seedAgent, seedPaperFill, type FakeMarket } from "./test-fixtures.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

async function freshDb(): Promise<Db> {
  const db = await memoryDb();
  dbs.push(db);
  return db;
}

const ledgerDeps = (db: Db): LedgerDeps => ({ db, clock: fixedClock(), logger: silentLogger });
const TOPUP = { minUsd: 0.01, zgPerUsdc: 6 };
/** Exits are stamped with the clock, so it must run after every fill in the test (as it does in production). */
const LATER = fixedClock(NOW + 60_000);

describe("triggerFor", () => {
  const bracket = { takeProfitPrice: 2100, stopLossPrice: 1900 };

  test("take-profit at or above the target, stop-loss at or below the stop", () => {
    expect(triggerFor(2100, bracket)?.reason).toBe("take-profit hit");
    expect(triggerFor(2250, bracket)?.reason).toBe("take-profit hit");
    expect(triggerFor(1900, bracket)?.reason).toBe("stop-loss hit");
    expect(triggerFor(1800, bracket)?.reason).toBe("stop-loss hit");
  });

  test("no trigger between the stop and the target, or for an invalid mark", () => {
    expect(triggerFor(2000, bracket)).toBeNull();
    expect(triggerFor(Number.NaN, bracket)).toBeNull();
    expect(triggerFor(0, bracket)).toBeNull();
  });
});

describe("closePaperBrackets", () => {
  test("take-profit closes the bracket position once, at the mark, with an episode", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    await seedPaperFill(db, agent, { id: "paper-entry-tp", side: "buy", qty: 1, price: 2000, ts: NOW, bracket: { takeProfitPrice: 2100, stopLossPrice: 1900 } });
    const market = fakeMarket({ WETH: 2000 });
    const d = deps({ db, market, clock: LATER });

    expect(await closePaperBrackets(d, agent)).toEqual([]);

    market.setPrice("WETH", 2110);
    const exits = await closePaperBrackets(d, agent);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ reason: "take-profit hit", closesOrderId: "paper-entry-tp", qty: 1, priceUsd: 2110 });

    market.setPrice("WETH", 2150);
    expect(await closePaperBrackets(d, agent)).toEqual([]);

    const sells = (await db.query.orders.findMany({ where: (o, { eq }) => eq(o.agentId, agent.id) })).filter((o) => o.side === "sell");
    expect(sells).toHaveLength(1);
    expect(sells[0]?.status).toBe("simulated_fill");
    expect(sells[0]?.raw).toMatchObject({ paper: true, reason: "take-profit hit", closesOrderId: "paper-entry-tp" });

    const fills = await db.query.fills.findMany({ where: (f, { eq }) => eq(f.orderId, sells[0]?.id ?? "") });
    expect(fills).toHaveLength(1);
    expect(fills[0]?.price).toBe(2110);

    const episodes = await db.query.episodes.findMany({ where: (e, { eq }) => eq(e.agentId, agent.id) });
    const exitEpisodes = episodes.filter((e) => e.verdict?.kind === "approve");
    expect(exitEpisodes).toHaveLength(1);
    expect(exitEpisodes[0]?.decision?.proposal.rationale).toContain("take-profit hit");
    expect(exitEpisodes[0]?.decision?.proposal.rationale).toContain("2110");

    const book = await loadPaperBook(db, agent.id);
    expect(replayLots(book.entries).remainingByOrder.get("paper-entry-tp") ?? 0).toBeCloseTo(0);
  });

  test("stop-loss closes once, and a stop tightened by crash.ts is honoured", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    await seedPaperFill(db, agent, { id: "paper-entry-sl", side: "buy", qty: 1, price: 2000, ts: NOW, bracket: { takeProfitPrice: 2100, stopLossPrice: 1900 } });
    const market = fakeMarket({ WETH: 2000 });
    const d = deps({ db, market, clock: LATER });

    // crash.ts raises the stop to 1990 by rewriting the order's attached bracket (same as tightenStops()).
    await upsertOrder(db, {
      id: "paper-entry-sl",
      agentId: agent.id,
      funderAddress: agent.tradingWallet,
      side: "buy",
      asset: "WETH",
      orderType: "market",
      notionalUsd: 2000,
      status: "simulated_fill",
      raw: { paper: true, attachedBracket: { takeProfitPrice: 2100, stopLossPrice: 1990 }, stopLossTightenedAt: NOW },
      createdAt: NOW,
      updatedAt: NOW,
    });
    market.setPrice("WETH", 1985);
    const exits = await closePaperBrackets(d, agent);
    expect(exits.map((e) => e.reason)).toEqual(["stop-loss hit"]);
    expect(await closePaperBrackets(d, agent)).toEqual([]);
  });

  test("a sell that already closed the entry is not closed again by its bracket", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    await seedPaperFill(db, agent, { id: "paper-entry-llm", side: "buy", qty: 1, price: 2000, ts: NOW, bracket: { takeProfitPrice: 2100, stopLossPrice: 1900 } });
    await seedPaperFill(db, agent, { id: "paper-llm-sell", side: "sell", qty: 1, price: 2050, ts: NOW + 1_000 });
    const market = fakeMarket({ WETH: 2000 });
    market.setPrice("WETH", 2200);
    expect(await closePaperBrackets(deps({ db, market, clock: LATER }), agent)).toEqual([]);
  });

  test("a partial sell closes only the remaining quantity", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    await seedPaperFill(db, agent, { id: "paper-entry-two", side: "buy", qty: 2, price: 2000, ts: NOW, bracket: { takeProfitPrice: 2100, stopLossPrice: 1900 } });
    await seedPaperFill(db, agent, { id: "paper-llm-half", side: "sell", qty: 1, price: 2050, ts: NOW + 1_000 });
    const market = fakeMarket({ WETH: 2000 });
    market.setPrice("WETH", 2105);
    const exits = await closePaperBrackets(deps({ db, market, clock: LATER }), agent);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.qty).toBeCloseTo(1);
    expect(await closePaperBrackets(deps({ db, market, clock: LATER }), agent)).toEqual([]);
  });

  test("two bracket entries close independently, each once", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    await seedPaperFill(db, agent, { id: "paper-entry-a", side: "buy", qty: 1, price: 2000, ts: NOW, bracket: { takeProfitPrice: 2100, stopLossPrice: 1900 } });
    await seedPaperFill(db, agent, { id: "paper-entry-b", side: "buy", qty: 1, price: 2050, ts: NOW + 1_000, bracket: { takeProfitPrice: 2100, stopLossPrice: 1900 } });
    const market = fakeMarket({ WETH: 2000 });
    market.setPrice("WETH", 2120);
    const d = deps({ db, market, clock: LATER });
    const exits = await closePaperBrackets(d, agent);
    expect(exits.map((e) => e.closesOrderId).sort()).toEqual(["paper-entry-a", "paper-entry-b"]);
    expect(await closePaperBrackets(d, agent)).toEqual([]);
  });

  test("without a mark price the position stays open", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    await seedPaperFill(db, agent, { id: "paper-entry-nomark", side: "buy", qty: 1, price: 2000, ts: NOW, bracket: { takeProfitPrice: 2100, stopLossPrice: 1900 } });
    const market: FakeMarket = fakeMarket({ WETH: 2000 });
    market.failAsset("WETH");
    expect(await closePaperBrackets(deps({ db, market, clock: LATER }), agent)).toEqual([]);
  });
});

describe("replayLots", () => {
  const trade = (p: Partial<Trade> & Pick<Trade, "orderId" | "side">): Trade => ({
    asset: "WETH",
    qty: 1,
    price: 2000,
    notionalUsd: 2000,
    feeUsd: 0,
    integratorFeeUsd: 0,
    txId: "",
    ts: NOW,
    ...p,
  });

  test("open quantity per asset matches computeFifoPnl", () => {
    const trades = [
      trade({ orderId: "b1", side: "buy", qty: 2, notionalUsd: 4000, feeUsd: 4, ts: NOW }),
      trade({ orderId: "b2", side: "buy", qty: 1, notionalUsd: 2100, ts: NOW + 1 }),
      trade({ orderId: "s1", side: "sell", qty: 1.5, notionalUsd: 3075, ts: NOW + 2 }),
    ];
    const state = replayLots(trades.map((t) => ({ trade: t, closesOrderId: null })));
    const fifo = computeFifoPnl(trades);
    expect(state.openQtyByAsset.get("WETH")).toBeCloseTo(fifo.openPositions[0]?.qty ?? -1);
    expect(state.remainingByOrder.get("b1")).toBeCloseTo(0.5);
    expect(state.remainingByOrder.get("b2")).toBeCloseTo(1);
  });

  test("a targeted exit consumes its own order before older lots", () => {
    const trades = [
      trade({ orderId: "old", side: "buy", ts: NOW }),
      trade({ orderId: "new", side: "buy", ts: NOW + 1, price: 2100, notionalUsd: 2100 }),
      trade({ orderId: "exit", side: "sell", ts: NOW + 2, price: 2200, notionalUsd: 2200 }),
    ];
    const state = replayLots([
      { trade: trades[0] as Trade, closesOrderId: null },
      { trade: trades[1] as Trade, closesOrderId: null },
      { trade: trades[2] as Trade, closesOrderId: "new" },
    ]);
    expect(state.remainingByOrder.get("old")).toBeCloseTo(1);
    expect(state.remainingByOrder.get("new") ?? 0).toBeCloseTo(0);
  });
});

describe("settlePaperCommission", () => {
  test("accrues commission on the high-water mark and never charges the same profit twice", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    const ledger = ledgerDeps(db);

    // +100 realized: 10% of 100.
    await seedPaperFill(db, agent, { id: "round1-buy", side: "buy", qty: 1, price: 2000, ts: NOW });
    await seedPaperFill(db, agent, { id: "round1-sell", side: "sell", qty: 1, price: 2100, ts: NOW + 1 });
    expect(await settlePaperCommission(ledger, agent)).toBeCloseTo(10);
    expect(await settlePaperCommission(ledger, agent)).toBe(0);

    // -100 realized: cumulative back to zero. Nothing is owed below the mark.
    await seedPaperFill(db, agent, { id: "round2-buy", side: "buy", qty: 1, price: 2100, ts: NOW + 2 });
    await seedPaperFill(db, agent, { id: "round2-sell", side: "sell", qty: 1, price: 2000, ts: NOW + 3 });
    expect(await settlePaperCommission(ledger, agent)).toBe(0);

    // +200 realized: cumulative 200, a new high. Only the difference above the old mark is charged.
    await seedPaperFill(db, agent, { id: "round3-buy", side: "buy", qty: 1, price: 2000, ts: NOW + 4 });
    await seedPaperFill(db, agent, { id: "round3-sell", side: "sell", qty: 1, price: 2200, ts: NOW + 5 });
    expect(await settlePaperCommission(ledger, agent)).toBeCloseTo(10);

    const totals = await paperLedgerTotals(db, agent.id);
    expect(totals.commissionUsd).toBeCloseTo(20);
    const rows = await db.query.paperLedger.findMany({ where: (l, { eq }) => eq(l.agentId, agent.id) });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "commission" && r.note === "paper commission on new high-water mark")).toBe(true);
  });

  test("charges nothing while realized PnL never goes above zero", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    await seedPaperFill(db, agent, { id: "loss-buy", side: "buy", qty: 1, price: 2000, ts: NOW });
    await seedPaperFill(db, agent, { id: "loss-sell", side: "sell", qty: 1, price: 1900, ts: NOW + 1 });
    expect(await settlePaperCommission(ledgerDeps(db), agent)).toBe(0);
    expect((await paperLedgerTotals(db, agent.id)).commissionUsd).toBe(0);
  });

  test("peakRealizedPnl is the highest cumulative realized value, not the final one", async () => {
    const trade = (orderId: string, side: "buy" | "sell", price: number, ts: number): Trade => ({
      orderId,
      side,
      asset: "WETH",
      qty: 1,
      price,
      notionalUsd: price,
      feeUsd: 0,
      integratorFeeUsd: 0,
      txId: "",
      ts,
    });
    const trades = [trade("a", "buy", 100, 1), trade("b", "sell", 150, 2), trade("c", "buy", 150, 3), trade("d", "sell", 120, 4)];
    expect(peakRealizedPnl(trades)).toBeCloseTo(50);
  });
});

describe("settlePaperTopUp", () => {
  test("converts the balance to 0G only at a low, critical or empty tier, then the balance is empty", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    const ledger = ledgerDeps(db);
    await insertPaperLedger(db, { agentId: agent.id, kind: "commission", amountUsd: 10, amount0g: null, note: "test", ts: NOW });

    expect(await settlePaperTopUp(ledger, agent, "healthy", TOPUP)).toBeNull();
    expect(await settlePaperTopUp(ledger, agent, "low", TOPUP)).toEqual({ amountUsd: 10, amount0g: 60 });

    const totals = await paperLedgerTotals(db, agent.id);
    expect(totals.topup0g).toBeCloseTo(60);
    expect(totals.balanceUsd).toBeCloseTo(0);

    expect(await settlePaperTopUp(ledger, agent, "critical", TOPUP)).toBeNull();
  });

  test("waits for PAPER_MIN_TOPUP_USD", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db);
    await insertPaperLedger(db, { agentId: agent.id, kind: "commission", amountUsd: 0.005, amount0g: null, note: "test", ts: NOW });
    expect(await settlePaperTopUp(ledgerDeps(db), agent, "empty", TOPUP)).toBeNull();
    expect(await settlePaperTopUp(ledgerDeps(db), agent, "empty", { minUsd: 0.001, zgPerUsdc: 6 })).not.toBeNull();
  });
});
