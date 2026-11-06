import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, insertEpisode, sumBillingSince, type Db } from "@arena/db";
import { TEMPLATES } from "@arena/policy";
import { NoopMemoryStore } from "@arena/zerog";
import { applySliderSuggestions, closedTradesFrom, reflectAgent } from "./reflection.ts";
import type { Trade } from "@arena/flash";
import { completion, fixedClock, globalLimits, memoryDb, routerWith, seedAgent, NOW } from "./test-fixtures.ts";
import { silentLogger } from "./logger.ts";

const momentum = TEMPLATES.momentum.sliders;

describe("applySliderSuggestions", () => {
  test("applies a change that sits inside the owner's ±maxDeltaPct window", () => {
    const { sliders, applied } = applySliderSuggestions(
      { lookbackBars: 20, minConfidence: 60, sizePct: 25, takeProfitPct: 4, stopLossPct: 2, trailPct: 2 },
      [{ key: "lookbackBars", from: 20, to: 21, reason: "slightly longer" }],
      momentum,
      5,
    );
    expect(sliders.lookbackBars).toBe(21);
    expect(applied).toEqual(["lookbackBars 20->21"]);
  });

  test("clamps a large suggestion to the window, then snaps to the slider step", () => {
    // takeProfitPct 4 with ±5% is [3.8, 4.2]; step 0.5 from min 0.5 leaves no step inside the window.
    const { sliders, applied } = applySliderSuggestions(
      { takeProfitPct: 4 },
      [{ key: "takeProfitPct", from: 4, to: 12, reason: "go big" }],
      momentum,
      5,
    );
    expect(sliders.takeProfitPct).toBe(4);
    expect(applied).toEqual([]);
  });

  test("never leaves the template bounds, and ignores unknown keys", () => {
    const { sliders } = applySliderSuggestions(
      { lookbackBars: 100 },
      [
        { key: "lookbackBars", from: 100, to: 500, reason: "way past max" },
        { key: "notASlider", from: 1, to: 2, reason: "unknown" },
      ],
      momentum,
      50,
    );
    expect(sliders.lookbackBars).toBe(100);
    expect(sliders).not.toHaveProperty("notASlider");
  });

  test("uses at most one suggestion per key", () => {
    const { applied } = applySliderSuggestions(
      { lookbackBars: 20 },
      [
        { key: "lookbackBars", from: 20, to: 22, reason: "first" },
        { key: "lookbackBars", from: 20, to: 25, reason: "second" },
      ],
      momentum,
      50,
    );
    expect(applied).toEqual(["lookbackBars 20->22"]);
  });
});

describe("closedTradesFrom", () => {
  test("pairs each sell with the PnL it realized under FIFO", () => {
    const trades: Trade[] = [
      { orderId: "b", side: "buy", asset: "WETH", qty: 1, price: 2000, notionalUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, txId: "", ts: 1 },
      { orderId: "s", side: "sell", asset: "WETH", qty: 1, price: 2200, notionalUsd: 2200, feeUsd: 0, integratorFeeUsd: 0, txId: "", ts: 2 },
    ];
    const [closed] = closedTradesFrom(trades);
    expect(closed?.pnlUsd).toBeCloseTo(200, 9);
    expect(closed?.entryPrice).toBeCloseTo(2000, 9);
    expect(closed?.pnlPct).toBeCloseTo(10, 9);
  });

  test("buys are not closed trades", () => {
    const trades: Trade[] = [
      { orderId: "b", side: "buy", asset: "WETH", qty: 1, price: 2000, notionalUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, txId: "", ts: 1 },
    ];
    expect(closedTradesFrom(trades)).toEqual([]);
  });
});

const dbs: Db[] = [];
afterAll(async () => {
  for (const db of dbs) await closeDb(db);
});

const LESSONS_JSON = JSON.stringify({
  lessons: [{ lesson: "Trim size after a stop-out", evidenceEpisodeIds: [], confidence: 0.7, appliesTo: ["momentum"] }],
  sliderSuggestions: [],
});

describe("reflectAgent records its 0G calls", () => {
  test("each reflection call is written to inference_calls with purpose reflection, and counts toward the budget", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db);
    await insertEpisode(db, {
      id: "ep-1",
      agentId: agent.id,
      ts: NOW - 60_000,
      riskLevel: "NORMAL",
      budgetTier: "healthy",
      market: [],
      decision: null,
      inference: null,
      verdict: { kind: "noop", reasons: ["hold"] },
      flashOrderIds: [],
      zgStorageRoot: null,
      error: null,
    });
    const stub = routerWith(() => completion(LESSONS_JSON, "req-r-0"));

    const summary = await reflectAgent(
      {
        db,
        clock: fixedClock(),
        logger: silentLogger,
        memory: new NoopMemoryStore(),
        routerFor: () => stub.router,
        globalLimits: globalLimits(),
        commissionBounds: { min: 0, max: 2000 },
      },
      agent,
    );

    expect(summary.error).toBeNull();
    expect(summary.lessons).toBe(1);
    const rows = await db.query.inferenceCalls.findMany({ where: (c, { eq }) => eq(c.agentId, agent.id) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestId: "req-r-0", purpose: "reflection", payer: "platform" });
    expect(await sumBillingSince(db, agent.id, 0)).toBe("0.01");
  });

  test("a reflection whose output is unusable is still recorded, since the call was billed", async () => {
    const db = await memoryDb();
    dbs.push(db);
    const agent = await seedAgent(db);
    await insertEpisode(db, {
      id: "ep-2",
      agentId: agent.id,
      ts: NOW - 60_000,
      riskLevel: "NORMAL",
      budgetTier: "healthy",
      market: [],
      decision: null,
      inference: null,
      verdict: { kind: "noop", reasons: ["hold"] },
      flashOrderIds: [],
      zgStorageRoot: null,
      error: null,
    });
    const stub = routerWith((_body, index) => completion("this is not json", `req-r-${index}`));

    const summary = await reflectAgent(
      {
        db,
        clock: fixedClock(),
        logger: silentLogger,
        memory: new NoopMemoryStore(),
        routerFor: () => stub.router,
        globalLimits: globalLimits(),
        commissionBounds: { min: 0, max: 2000 },
      },
      agent,
    );

    expect(summary.error).not.toBeNull();
    const rows = await db.query.inferenceCalls.findMany({ where: (c, { eq }) => eq(c.agentId, agent.id) });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.purpose === "reflection")).toBe(true);
    expect(rows.map((r) => r.requestId)).toContain("req-r-0");
  });
});
