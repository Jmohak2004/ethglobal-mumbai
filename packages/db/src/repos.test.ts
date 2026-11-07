// Tests for the repo changes: stats preservation, top-up nonces, the forecast hit rule, insights and cursors.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StrategyConfig } from "@arena/shared";
import {
  cancelPaperOrders,
  closeDb,
  createAgent,
  createDb,
  createTopup,
  insertFills,
  insertPaperFill,
  listRecentFills,
  fillsSummary,
  listPaperFillsByFunder,
  listUnjournaledPaperFills,
  setFillTxId,
  createTopupIfAbsent,
  forecastHit,
  getChainCursor,
  getTopupByNonce,
  insertForecast,
  insertInsightDigest,
  insertInsightItems,
  latestInsightDigest,
  leaderboard,
  listForecastsByAgent,
  listRecentInsightItems,
  listTopupsByAgent,
  markStatsVerified,
  upsertOrder,
  upsertUser,
  migrate,
  resolveForecast,
  setChainCursor,
  updateTopup,
  upsertStats,
  type Db,
  type StatsInput,
} from "./index.ts";

const OWNER = "0x0000000000000000000000000000000000000001";
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

function config(): StrategyConfig {
  return {
    template: "momentum",
    assets: ["WETH", "cbBTC"],
    sliders: { sizePct: 0.2, tpPct: 3, slPct: 2 },
    limits: { maxTradeUsd: 1, maxOpenPositions: 2, maxAllocationUsd: 5, maxDailyLossUsd: 1, maxDrawdownPct: 15, cooldownSec: 900 },
    tickIntervalSec: 300,
    modelTier: "balanced",
    crashMode: "tighten_stops",
    commissionBps: 1000,
    autoTune: { enabled: false, maxDeltaPct: 0 },
    publicCommentary: "off",
    insightSources: [],
    fork: { forkable: true, priceUsd: 2 },
  };
}

let db: Db;
beforeEach(async () => {
  db = createDb({ memory: true });
  await migrate(db);
});
afterEach(async () => {
  await closeDb(db);
});

async function agent(id: string) {
  return createAgent(db, {
    id,
    name: id,
    ownerAddress: OWNER,
    tradingWallet: "0x0000000000000000000000000000000000000100",
    config: config(),
    configHash: H(1),
    createdAt: 1_000,
  });
}

function stats(overrides: Partial<StatsInput> & Pick<StatsInput, "entityId">): StatsInput {
  return {
    kind: "agent",
    name: overrides.entityId,
    template: "momentum",
    mode: "paper",
    realizedPnlUsd: 0,
    realizedPnlPct: 0,
    volumeUsd: 0,
    trades: 0,
    winRateBps: 0,
    maxDrawdownBps: 0,
    forecastHitRateBps: 0,
    daysActive: 0,
    ...overrides,
  };
}

async function statsRow(entityId: string) {
  return (await leaderboard(db, { kind: "agent", limit: 500 })).find((r) => r.entityId === entityId);
}

describe("upsertStats keeps fields that are not provided", () => {
  test("a recompute without verified or selfFunded keeps the stored verification", async () => {
    await upsertStats(db, [stats({ entityId: "a", realizedPnlUsd: 1, verified: { reportTx: H(5), asOf: 500 }, selfFunded: true })]);
    await upsertStats(db, [stats({ entityId: "a", realizedPnlUsd: 7 })]);
    const row = await statsRow("a");
    expect(row?.realizedPnlUsd).toBe(7);
    expect(row?.verified).toEqual({ reportTx: H(5), asOf: 500 });
    expect(row?.selfFunded).toBe(true);
  });

  test("null clears the verification, and an object replaces it", async () => {
    await upsertStats(db, [stats({ entityId: "a", verified: { reportTx: H(5), asOf: 500 } })]);
    await upsertStats(db, [stats({ entityId: "a", verified: null })]);
    expect((await statsRow("a"))?.verified).toBeNull();
    await upsertStats(db, [stats({ entityId: "a", verified: { reportTx: H(6), asOf: 600 } })]);
    expect((await statsRow("a"))?.verified).toEqual({ reportTx: H(6), asOf: 600 });
  });

  test("a new row without verified or selfFunded starts unverified and not self-funded", async () => {
    await upsertStats(db, [stats({ entityId: "fresh" })]);
    const row = await statsRow("fresh");
    expect(row?.verified).toBeNull();
    expect(row?.selfFunded).toBe(false);
  });
});

describe("total PnL", () => {
  test("defaults to realized when unrealized is not given, and unrealized defaults to 0", async () => {
    await upsertStats(db, [stats({ entityId: "t1", realizedPnlUsd: 3, realizedPnlPct: 30 })]);
    const row = await statsRow("t1");
    expect(row?.unrealizedPnlUsd).toBe(0);
    expect(row?.totalPnlUsd).toBe(3);
    expect(row?.totalPnlPct).toBe(30);
  });

  test("stores explicit unrealized and total, and the leaderboard ranks by total", async () => {
    await upsertStats(db, [
      stats({ entityId: "realized-only", realizedPnlUsd: 5 }),
      stats({ entityId: "holder", realizedPnlUsd: 0, unrealizedPnlUsd: 8, totalPnlUsd: 8, totalPnlPct: 80 }),
      stats({ entityId: "bag", realizedPnlUsd: 9, unrealizedPnlUsd: -20, totalPnlUsd: -11, totalPnlPct: -110 }),
    ]);
    const rows = (await leaderboard(db, { kind: "agent", limit: 500 })).filter((r) => ["realized-only", "holder", "bag"].includes(r.entityId));
    expect(rows.map((r) => r.entityId)).toEqual(["holder", "realized-only", "bag"]);
    const holder = rows[0];
    expect(holder?.realizedPnlUsd).toBe(0);
    expect(holder?.unrealizedPnlUsd).toBe(8);
    expect(holder?.totalPnlPct).toBe(80);
  });
});

describe("markStatsVerified", () => {
  test("sets only the verification on an existing row", async () => {
    await upsertStats(db, [stats({ entityId: "a", realizedPnlUsd: 3, trades: 4, selfFunded: true })]);
    expect(await markStatsVerified(db, "a", { reportTx: H(9), asOf: 900 })).toBe(true);
    const row = await statsRow("a");
    expect(row?.verified).toEqual({ reportTx: H(9), asOf: 900 });
    expect(row?.realizedPnlUsd).toBe(3);
    expect(row?.trades).toBe(4);
    expect(row?.selfFunded).toBe(true);
  });

  test("returns false when the entity has no stats row", async () => {
    expect(await markStatsVerified(db, "missing", { reportTx: H(9), asOf: 900 })).toBe(false);
    expect(await statsRow("missing")).toBeUndefined();
  });
});

describe("topup nonces", () => {
  test("createTopupIfAbsent is idempotent per (agent, nonce)", async () => {
    await agent("agent-1");
    const first = await createTopupIfAbsent(db, { agentId: "agent-1", nonce: 7n, usdcAmount: 1, status: "requested", ts: 1000 });
    const again = await createTopupIfAbsent(db, { agentId: "agent-1", nonce: 7n, usdcAmount: 1, status: "requested", ts: 2000 });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.topup.id).toBe(first.topup.id);
    expect(again.topup.ts).toBe(1000);
    expect(await listTopupsByAgent(db, "agent-1")).toHaveLength(1);
  });

  test("getTopupByNonce accepts bigint, number or string, and is scoped per agent", async () => {
    await agent("agent-1");
    await agent("agent-2");
    const { topup } = await createTopupIfAbsent(db, { agentId: "agent-1", nonce: 42n, usdcAmount: 1 });
    expect(topup.nonce).toBe("42");
    expect((await getTopupByNonce(db, "agent-1", 42n))?.id).toBe(topup.id);
    expect((await getTopupByNonce(db, "agent-1", 42))?.id).toBe(topup.id);
    expect((await getTopupByNonce(db, "agent-1", "42"))?.id).toBe(topup.id);
    expect(await getTopupByNonce(db, "agent-2", 42n)).toBeNull();
    expect(await getTopupByNonce(db, "agent-1", 43n)).toBeNull();
    // The same nonce on another agent is a different top-up.
    const other = await createTopupIfAbsent(db, { agentId: "agent-2", nonce: 42n, usdcAmount: 1 });
    expect(other.created).toBe(true);
  });

  test("a second createTopup with the same nonce is rejected by the unique index", async () => {
    await agent("agent-1");
    await createTopup(db, { id: "t1", agentId: "agent-1", nonce: 1, usdcAmount: 1 });
    await expect(createTopup(db, { id: "t2", agentId: "agent-1", nonce: 1, usdcAmount: 1 })).rejects.toThrow();
  });

  test("rows without a nonce are allowed and do not collide", async () => {
    await agent("agent-1");
    const a = await createTopup(db, { agentId: "agent-1", usdcAmount: 1 });
    const b = await createTopup(db, { agentId: "agent-1", usdcAmount: 2 });
    expect(a.nonce).toBeNull();
    expect(b.nonce).toBeNull();
  });

  test("a nonce must be a non-negative integer", async () => {
    await agent("agent-1");
    await expect(createTopup(db, { agentId: "agent-1", nonce: "abc", usdcAmount: 1 })).rejects.toThrow("non-negative integer");
  });

  test("updateTopup moves updatedAt forward and leaves ts alone", async () => {
    await agent("agent-1");
    const t = await createTopup(db, { agentId: "agent-1", nonce: 3, usdcAmount: 1, ts: 1000 });
    expect(t.updatedAt).toBe(1000);
    const updated = await updateTopup(db, t.id, { status: "deposited" });
    expect(updated?.ts).toBe(1000);
    expect(updated?.updatedAt).toBeGreaterThan(1000);
    expect(updated?.status).toBe("deposited");
  });
});

describe("forecast hit rule", () => {
  const up = { direction: "up" as const, expectedMovePct: 1 };
  const down = { direction: "down" as const, expectedMovePct: 1 };
  const flat = { direction: "flat" as const, expectedMovePct: 1 };

  test("up and down need a move of at least 25% of the expected move, in the right direction", () => {
    expect(forecastHit(up, 100, 100.25)).toBe(true);
    expect(forecastHit(up, 100, 100.1)).toBe(false);
    expect(forecastHit(up, 100, 99.9)).toBe(false);
    expect(forecastHit(down, 100, 99.5)).toBe(true);
    expect(forecastHit(down, 100, 99.9)).toBe(false);
    expect(forecastHit(down, 100, 100.5)).toBe(false);
  });

  test("flat hits only within ±0.2%, whatever expectedMovePct says", () => {
    expect(forecastHit(flat, 100, 100.19)).toBe(true);
    expect(forecastHit(flat, 100, 99.81)).toBe(true);
    expect(forecastHit(flat, 100, 100.3)).toBe(false);
    expect(forecastHit({ direction: "flat", expectedMovePct: 5 }, 100, 101)).toBe(false);
  });

  test("invalid prices never hit", () => {
    expect(forecastHit(up, 0, 10)).toBe(false);
    expect(forecastHit(up, 100, Number.NaN)).toBe(false);
  });

  test("resolveForecast stores the same hit as forecastHit", async () => {
    await agent("agent-1");
    const flatId = await insertForecast(db, {
      agentId: "agent-1", asset: "WETH", horizonMin: 60, direction: "flat", expectedMovePct: 1, confidence: 0.5,
      priceAtForecast: 100, resolveAt: 5000, createdAt: 1000,
    });
    const weakUpId = await insertForecast(db, {
      agentId: "agent-1", asset: "WETH", horizonMin: 60, direction: "up", expectedMovePct: 1, confidence: 0.5,
      priceAtForecast: 100, resolveAt: 5000, createdAt: 1000,
    });
    // Under the old direction-only rule both of these were hits. Under forecastHit neither is.
    const flatRow = await resolveForecast(db, flatId, 100.3);
    const weakRow = await resolveForecast(db, weakUpId, 100.1);
    expect(flatRow?.hit).toBe(false);
    expect(weakRow?.hit).toBe(false);
    expect(flatRow?.ts).toBe(1000);
    expect((await listForecastsByAgent(db, "agent-1")).map((f) => f.hit)).toEqual([false, false]);
  });
});

describe("insights", () => {
  test("insertInsightItems is idempotent on id and returns ids in order", async () => {
    const ids = await insertInsightItems(db, [
      { id: "i1", sourceKind: "rss", asset: "WETH", body: "ETH rally", ts: 1000 },
      { sourceKind: "web_search", asset: "cbBTC", body: "BTC quiet", ts: 2000 },
    ]);
    expect(ids[0]).toBe("i1");
    expect(typeof ids[1]).toBe("string");
    expect(await insertInsightItems(db, [{ id: "i1", sourceKind: "rss", asset: "WETH", body: "changed", ts: 1000 }])).toEqual(["i1"]);
    const rows = await listRecentInsightItems(db, { assets: ["WETH"], since: 0 });
    expect(rows.map((r) => r.body)).toEqual(["ETH rally"]);
    expect(await insertInsightItems(db, [])).toEqual([]);
  });

  test("listRecentInsightItems filters by since and returns newest first", async () => {
    await insertInsightItems(db, [
      { id: "old", sourceKind: "rss", asset: "WETH", body: "old", ts: 100 },
      { id: "mid", sourceKind: "rss", asset: "WETH", body: "mid", ts: 500 },
      { id: "new", sourceKind: "rss", asset: "WETH", body: "new", ts: 900 },
    ]);
    const rows = await listRecentInsightItems(db, { assets: ["WETH"], since: 400 });
    expect(rows.map((r) => r.id)).toEqual(["new", "mid"]);
  });

  test("agentId selects an agent's own posts, and an empty query returns nothing", async () => {
    await insertInsightItems(db, [
      { id: "own", sourceKind: "agent", sourceRef: "agent-9", asset: null, body: "my take", ts: 800 },
      { id: "other", sourceKind: "agent", sourceRef: "agent-8", asset: null, body: "theirs", ts: 800 },
    ]);
    const rows = await listRecentInsightItems(db, { agentId: "agent-9", since: 0 });
    expect(rows.map((r) => r.id)).toEqual(["own"]);
    expect(rows[0]?.sourceKind).toBe("agent");
    expect(await listRecentInsightItems(db, { since: 0 })).toEqual([]);
  });

  test("latestInsightDigest returns the newest digest for an agent, optionally per asset", async () => {
    await agent("agent-1");
    await agent("agent-2");
    await insertInsightDigest(db, { id: "d1", agentId: "agent-1", asset: "WETH", stance: "bearish", confidence: 0.4, ts: 100 });
    await insertInsightDigest(db, { id: "d2", agentId: "agent-1", asset: "WETH", stance: "bullish", confidence: 0.8, sourceIds: ["item-1"], zgRequestId: "req-2", ts: 300 });
    await insertInsightDigest(db, { id: "d3", agentId: "agent-1", asset: "cbBTC", stance: "neutral", confidence: 0.5, ts: 200 });
    await insertInsightDigest(db, { id: "d4", agentId: "agent-2", asset: "WETH", stance: "bearish", confidence: 0.9, ts: 999 });

    const latest = await latestInsightDigest(db, "agent-1");
    expect(latest?.id).toBe("d2");
    expect(latest?.stance).toBe("bullish");
    expect(latest?.sourceIds).toEqual(["item-1"]);
    expect(latest?.zgRequestId).toBe("req-2");
    expect((await latestInsightDigest(db, "agent-1", { asset: "cbBTC" }))?.id).toBe("d3");
    expect(await latestInsightDigest(db, "agent-3")).toBeNull();
  });

  test("a platform-wide digest has no agent and is not returned for any agent", async () => {
    await insertInsightDigest(db, { id: "platform", asset: "WETH", stance: "neutral", confidence: 0.5, ts: 1 });
    await agent("agent-1");
    expect(await latestInsightDigest(db, "agent-1")).toBeNull();
  });
});

describe("chain cursors", () => {
  test("a cursor is null before its first write, then holds the last written block", async () => {
    expect(await getChainCursor(db, "perf")).toBeNull();
    await setChainCursor(db, "perf", 100);
    expect(await getChainCursor(db, "perf")).toBe(100);
    await setChainCursor(db, "perf", 250);
    expect(await getChainCursor(db, "perf")).toBe(250);
    expect(await getChainCursor(db, "other")).toBeNull();
  });
});

describe("paper fills (human manual trades in paper mode)", () => {
  const WALLET = "0x00000000000000000000000000000000000000Aa";
  const OTHER = "0x00000000000000000000000000000000000000bb";

  test("insertPaperFill stores an agentless filled order and its fill, with qty = notional / price", async () => {
    const { orderId, fillId } = await insertPaperFill(db, {
      funderAddress: WALLET,
      side: "buy",
      asset: "WETH",
      orderType: "limit",
      notionalUsd: 10,
      priceUsd: 2000,
      feeUsd: 0.02,
      integratorFeeUsd: 0.01,
      quoteId: "q-1",
      ts: 5_000,
    });
    expect(orderId.startsWith("paper_")).toBe(true);
    const order = await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, orderId) });
    expect(order).toMatchObject({ agentId: null, funderAddress: WALLET.toLowerCase(), status: "filled", asset: "WETH" });
    expect(order?.raw).toEqual({ paper: true, quoteId: "q-1" });
    const fill = await db.query.fills.findFirst({ where: (f, { eq }) => eq(f.id, fillId) });
    expect(fill).toMatchObject({ orderId, price: 2000, notionalUsd: 10, feeUsd: 0.02, integratorFeeUsd: 0.01, ts: 5_000, txId: null });
    expect(fill?.qty).toBeCloseTo(0.005, 12);
  });

  test("insertPaperFill rejects a non-positive price", async () => {
    await expect(
      insertPaperFill(db, { funderAddress: WALLET, side: "buy", asset: "WETH", orderType: "market", notionalUsd: 1, priceUsd: 0, feeUsd: 0, integratorFeeUsd: 0 }),
    ).rejects.toThrow("priceUsd");
  });

  test("listPaperFillsByFunder returns only this funder's paper fills, newest first, and skips live orders", async () => {
    const early = await insertPaperFill(db, { funderAddress: WALLET, side: "buy", asset: "WETH", orderType: "market", notionalUsd: 1, priceUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, ts: 1_000 });
    const late = await insertPaperFill(db, { funderAddress: WALLET, side: "sell", asset: "cbBTC", orderType: "stop", notionalUsd: 2, priceUsd: 60000, feeUsd: 0, integratorFeeUsd: 0, ts: 2_000 });
    await insertPaperFill(db, { funderAddress: OTHER, side: "buy", asset: "WETH", orderType: "market", notionalUsd: 1, priceUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, ts: 3_000 });
    await upsertOrder(db, {
      id: "flash-live-1",
      agentId: null,
      funderAddress: WALLET,
      side: "buy",
      asset: "WETH",
      orderType: "market",
      notionalUsd: 1,
      status: "ORDER_STATUS_FILLED",
      raw: { paper: false },
      createdAt: 4_000,
      updatedAt: 4_000,
    });
    await insertFills(db, [{ id: "flash-live-1:0x1", orderId: "flash-live-1", price: 2000, qty: 0.0005, notionalUsd: 1, feeUsd: 0, integratorFeeUsd: 0, txId: "0x1", ts: 4_000 }]);

    const rows = await listPaperFillsByFunder(db, WALLET);
    expect(rows.map((r) => r.orderId)).toEqual([late.orderId, early.orderId]);
    expect(rows[0]).toMatchObject({ side: "sell", asset: "cbBTC", orderType: "stop", price: 60000, notionalUsd: 2 });
  });

  test("cancelPaperOrders marks only this funder's open paper orders, and leaves filled and live orders alone", async () => {
    const base = { agentId: null, side: "buy" as const, asset: "WETH", orderType: "limit" as const, notionalUsd: 1, createdAt: 1, updatedAt: 1 };
    await upsertOrder(db, { ...base, id: "paper_open", funderAddress: WALLET, status: "open", raw: { paper: true } });
    await upsertOrder(db, { ...base, id: "paper_other", funderAddress: OTHER, status: "open", raw: { paper: true } });
    await upsertOrder(db, { ...base, id: "live_open", funderAddress: WALLET, status: "open", raw: { paper: false } });
    const filled = await insertPaperFill(db, { funderAddress: WALLET, side: "buy", asset: "WETH", orderType: "market", notionalUsd: 1, priceUsd: 2000, feeUsd: 0, integratorFeeUsd: 0 });

    const changed = await cancelPaperOrders(db, WALLET, ["paper_open", "paper_other", "live_open", filled.orderId], 9_000);
    expect(changed).toEqual(["paper_open"]);
    expect((await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, "paper_open") }))).toMatchObject({ status: "cancelled", updatedAt: 9_000 });
    expect((await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, "paper_other") }))?.status).toBe("open");
    expect((await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, "live_open") }))?.status).toBe("open");
    expect((await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, filled.orderId) }))?.status).toBe("filled");
    expect(await cancelPaperOrders(db, WALLET, [])).toEqual([]);
  });
});

describe("trade journal queue", () => {
  const WALLET = "0x00000000000000000000000000000000000000Cc";
  const TX = `0x${"ab".repeat(32)}` as const;
  const paper = (ts: number, extra: Partial<Parameters<typeof insertPaperFill>[1]> = {}) =>
    insertPaperFill(db, { funderAddress: WALLET, side: "buy", asset: "WETH", orderType: "market", notionalUsd: 1, priceUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, ts, ...extra });

  test("lists unjournaled paper fills oldest first, with the order fields the journal needs", async () => {
    const late = await paper(3_000, { side: "sell", asset: "cbBTC", priceUsd: 60000, notionalUsd: 2, quoteId: "q-late" });
    const early = await paper(1_000);
    const rows = await listUnjournaledPaperFills(db);
    expect(rows.map((r) => r.fill.id)).toEqual([early.fillId, late.fillId]);
    expect(rows[1]).toMatchObject({ orderId: late.orderId, agentId: null, funderAddress: WALLET.toLowerCase(), side: "sell", asset: "cbBTC", quoteId: "q-late" });
    expect(rows[0]?.quoteId).toBeNull();
  });

  test("skips fills that already have a tx hash and fills from live orders", async () => {
    const done = await paper(1_000);
    await setFillTxId(db, [done.fillId], TX);
    await upsertOrder(db, {
      id: "flash-live-2",
      agentId: null,
      funderAddress: WALLET,
      side: "buy",
      asset: "WETH",
      orderType: "market",
      notionalUsd: 1,
      status: "ORDER_STATUS_FILLED",
      raw: { paper: false },
      createdAt: 2_000,
      updatedAt: 2_000,
    });
    await insertFills(db, [{ id: "flash-live-2:fill", orderId: "flash-live-2", price: 2000, qty: 0.0005, notionalUsd: 1, feeUsd: 0, integratorFeeUsd: 0, txId: null, ts: 2_000 }]);
    const pending = await paper(3_000);
    expect((await listUnjournaledPaperFills(db)).map((r) => r.fill.id)).toEqual([pending.fillId]);
  });

  test("respects the limit", async () => {
    await paper(1);
    await paper(2);
    await paper(3);
    expect(await listUnjournaledPaperFills(db, 2)).toHaveLength(2);
  });

  test("setFillTxId stores the hash once and never overwrites it", async () => {
    const a = await paper(1);
    const b = await paper(2);
    expect(await setFillTxId(db, [a.fillId, b.fillId], TX)).toBe(2);
    expect(await setFillTxId(db, [a.fillId], `0x${"cd".repeat(32)}`)).toBe(0);
    expect(await setFillTxId(db, [], TX)).toBe(0);
    const row = await db.query.fills.findFirst({ where: (f, { eq }) => eq(f.id, a.fillId) });
    expect(row?.txId).toBe(TX);
    expect(await listUnjournaledPaperFills(db)).toEqual([]);
  });
});

describe("public trades feed", () => {
  const WALLET = "0x00000000000000000000000000000000000000Aa";
  const OTHER = "0x00000000000000000000000000000000000000bb";
  const TX = H(7);
  const paper = (funderAddress: string, ts: number) =>
    insertPaperFill(db, { funderAddress, side: "buy", asset: "WETH", orderType: "market", notionalUsd: 2, priceUsd: 2000, feeUsd: 0, integratorFeeUsd: 0, ts });

  test("listRecentFills is newest first across traders, joins agent and opted-in human names, pages by cursor", async () => {
    const alpha = await agent("alpha");
    await upsertUser(db, { address: WALLET, humansBoardOptIn: true });
    await upsertStats(db, [stats({ entityId: WALLET.toLowerCase(), kind: "human", name: "Ada K.", template: null })]);
    const a = await paper(WALLET, 1_000);
    const b = await paper(OTHER, 2_000);
    await upsertOrder(db, { id: "flash-1", agentId: alpha.id, funderAddress: OWNER, side: "sell", asset: "cbBTC", orderType: "market", notionalUsd: 3, status: "filled", raw: { paper: false }, createdAt: 3_000, updatedAt: 3_000 });
    await insertFills(db, [{ id: "flash-1:0xabc", orderId: "flash-1", price: 60000, qty: 0.00005, notionalUsd: 3, feeUsd: 0, integratorFeeUsd: 0, txId: TX, ts: 3_000 }]);
    await setFillTxId(db, [b.fillId], H(8));

    const rows = await listRecentFills(db);
    expect(rows.map((r) => r.orderId)).toEqual(["flash-1", b.orderId, a.orderId]);
    expect(rows[0]).toMatchObject({ agentId: alpha.id, agentName: "alpha", paper: false, txId: TX, humanName: null });
    expect(rows[1]).toMatchObject({ agentId: null, agentName: null, paper: true, txId: H(8), humanName: null });
    expect(rows[2]).toMatchObject({ paper: true, txId: null, humanName: "Ada K." });

    expect((await listRecentFills(db, { agentId: alpha.id })).map((r) => r.orderId)).toEqual(["flash-1"]);
    const page = await listRecentFills(db, { limit: 1, before: { ts: rows[0]!.ts, id: rows[0]!.id } });
    expect(page.map((r) => r.orderId)).toEqual([b.orderId]);
    expect(await fillsSummary(db)).toEqual({ trades: 3, volumeUsd: 7, journaled: 2 });
    expect(await fillsSummary(db, { agentId: alpha.id })).toEqual({ trades: 1, volumeUsd: 3, journaled: 1 });
  });
});
