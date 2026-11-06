// Tick paths that do not depend on the model: the kill switch (cancel pending entries, keep positions) and
// the latest insight digest fed into decide().

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, insertInsightDigest, insertFills, upsertOrder, type Db } from "@arena/db";
import { runTick } from "./tick.ts";
import {
  buyReply,
  completion,
  deps,
  fakeMarket,
  globalLimits,
  HOLD_REPLY,
  memoryDb,
  NOW,
  routerWith,
  seedAgent,
} from "./test-fixtures.ts";

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

async function freshDb(): Promise<Db> {
  const db = await memoryDb();
  dbs.push(db);
  return db;
}

describe("kill switch", () => {
  test("skips the model, cancels the unfilled entry, and leaves the open position alone", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "paper" });
    await upsertOrder(db, {
      id: "entry-open",
      agentId: agent.id,
      funderAddress: agent.tradingWallet,
      side: "buy",
      asset: "WETH",
      orderType: "limit",
      notionalUsd: 0.8,
      status: "ORDER_STATUS_PENDING",
      raw: { paper: true },
      createdAt: NOW - 60_000,
      updatedAt: NOW - 60_000,
    });
    await upsertOrder(db, {
      id: "entry-filled",
      agentId: agent.id,
      funderAddress: agent.tradingWallet,
      side: "buy",
      asset: "WETH",
      orderType: "limit",
      notionalUsd: 0.8,
      status: "simulated_fill",
      raw: { paper: true, attachedBracket: { takeProfitPrice: 2100, stopLossPrice: 1900 } },
      createdAt: NOW - 3_600_000,
      updatedAt: NOW - 3_600_000,
    });
    await insertFills(db, [
      { id: "entry-filled:fill", orderId: "entry-filled", price: 2000, qty: 0.0004, notionalUsd: 0.8, feeUsd: 0, integratorFeeUsd: 0, txId: null, ts: NOW - 3_600_000 },
    ]);

    const { router, requests } = routerWith(() => completion(buyReply(2000)));
    const result = await runTick(
      deps({ db, market: fakeMarket({ WETH: 2000 }), globalLimits: globalLimits({ killSwitch: true }), routerFor: () => router }),
      agent,
    );

    expect(requests).toHaveLength(0);
    expect(result.episode?.verdict.kind).toBe("noop");
    const reason = (result.episode?.verdict as { reasons: string[] }).reasons[0] ?? "";
    expect(reason).toContain("cancelled 1 pending entry");
    expect(result.episode?.error).toBeNull();

    const pending = await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, "entry-open") });
    expect(pending?.status).toBe("ORDER_STATUS_CANCELLED");
    const open = await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, "entry-filled") });
    expect(open?.status).toBe("simulated_fill");
    expect((open?.raw as { attachedBracket: { stopLossPrice: number } }).attachedBracket.stopLossPrice).toBe(1900);
  });

  test("with nothing pending, the kill switch is a plain skip", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "paper" });
    const result = await runTick(
      deps({ db, market: fakeMarket({ WETH: 2000 }), globalLimits: globalLimits({ killSwitch: true }) }),
      agent,
    );
    expect((result.episode?.verdict as { reasons: string[] }).reasons[0]).toContain("cancelled 0 pending entries");
  });

  test("a failed live cancel is recorded on the episode error", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { mode: "live" });
    await upsertOrder(db, {
      id: "live-entry",
      agentId: agent.id,
      funderAddress: agent.tradingWallet,
      side: "buy",
      asset: "WETH",
      orderType: "limit",
      notionalUsd: 0.8,
      status: "ORDER_STATUS_ACCEPTED",
      raw: { quoteId: "q" },
      createdAt: NOW - 60_000,
      updatedAt: NOW - 60_000,
    });
    const result = await runTick(
      deps({ db, market: fakeMarket({ WETH: 2000 }), globalLimits: globalLimits({ killSwitch: true }) }),
      agent,
    );
    expect(result.episode?.error).toContain("cancel live-entry");
    const row = await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, "live-entry") });
    expect(row?.status).toBe("ORDER_STATUS_ACCEPTED");
  });
});

describe("insight digest", () => {
  test("the agent's newest digest for its assets is sent to the model, and other agents' digests are not", async () => {
    const db = await freshDb();
    const agent = await seedAgent(db, { assets: ["WETH"] });
    const other = await seedAgent(db, { assets: ["WETH"] });
    // Confidence values are unique strings, so the request body can be searched for them.
    await insertInsightDigest(db, { agentId: agent.id, asset: "WETH", stance: "bullish", confidence: 0.8125, sourceIds: ["item-1"], zgRequestId: "req-own", ts: NOW - 1000 });
    await insertInsightDigest(db, { agentId: agent.id, asset: "WETH", stance: "bullish", confidence: 0.7625, ts: NOW - 5000 });
    await insertInsightDigest(db, { agentId: other.id, asset: "WETH", stance: "bearish", confidence: 0.9375, ts: NOW });

    const { router, requests } = routerWith(() => completion(HOLD_REPLY));
    await runTick(deps({ db, market: fakeMarket({ WETH: 2000 }), routerFor: () => router }), agent);

    expect(requests).toHaveLength(1);
    const body = JSON.stringify(requests[0]);
    expect(body).toContain("0.8125");
    expect(body).not.toContain("0.7625");
    expect(body).not.toContain("0.9375");
  });
});
